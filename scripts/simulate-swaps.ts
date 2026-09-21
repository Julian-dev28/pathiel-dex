/**
 * Every execution path on Robinhood Chain, run against the live chain.
 *
 * The fork tests in contracts/ cannot reach Robinhood Chain: its public RPC is
 * not an archive node, and at ten blocks a second a pinned fork block ages out
 * of the node's state within seconds. `eth_simulateV1` runs a sequence of
 * calls at the head instead, with state overrides, so each scenario funds a
 * throwaway address, wraps ETH, buys its input token if it needs one, sends
 * the approvals the router would ask for, then the swap — and compares what
 * arrived with what was quoted. Nothing is signed or broadcast.
 *
 * This is how the V4 encoding was checked: the deployed router's single-hop
 * params carry a `maxHopSlippage` word the older struct lacks, and without it
 * every pool whose currency0 is not native ETH reverted.
 *
 *   npm run sim:swaps
 */

import {
  encodeFunctionData,
  decodeFunctionResult,
  parseEther,
  parseUnits,
  formatUnits,
  numberToHex,
  type Address,
} from 'viem';
import { CHAINS, bySymbol, type Token } from '../src/lib/chain';
import { client, discover, quoteLadder, type Venue } from '../src/lib/quote';
import { buildSwap, approvalsFor, approvalTx, minOut, ERC20 } from '../src/lib/execute';

const chain = CHAINS.robinhood;
const c = client(chain);
const ME: Address = '0x00000000000000000000000000000000000beef1';
const NATIVE = '0x0000000000000000000000000000000000000000';

type Tx = { to: Address; data: `0x${string}`; value?: bigint };
type Result = { status: string; returnData: `0x${string}`; gasUsed: string };

const balanceOf = (t: Token): Tx => ({
  to: t.address,
  data: encodeFunctionData({ abi: ERC20, functionName: 'balanceOf', args: [ME] }),
});
const decodeBalance = (d: `0x${string}`) =>
  decodeFunctionResult({ abi: ERC20, functionName: 'balanceOf', data: d }) as bigint;

async function simulate(txs: Tx[]): Promise<Result[]> {
  const res = (await c.request({
    method: 'eth_simulateV1',
    params: [
      {
        blockStateCalls: [
          {
            stateOverrides: { [ME]: { balance: numberToHex(parseEther('1000')) } },
            calls: txs.map((t) => ({
              from: ME,
              to: t.to,
              data: t.data,
              value: numberToHex(t.value ?? 0n),
              gas: numberToHex(30_000_000n),
            })),
          },
        ],
      },
      'latest',
    ],
  } as never)) as { calls: Result[] }[];
  return res[0].calls;
}

async function bestOf(tokenIn: Token, tokenOut: Token, amountIn: bigint, pick: (v: Venue) => boolean) {
  const venues = (await discover(tokenIn, tokenOut)).filter(pick);
  const curves = await quoteLadder(tokenIn, tokenOut, [amountIn], venues);
  return curves.sort((a, b) => (a.rungs[0].amountOut > b.rungs[0].amountOut ? -1 : 1))[0];
}

const swapSteps = (v: Venue, amountIn: bigint, floor: bigint): Tx[] => [
  ...approvalsFor(v).map((a) => approvalTx(a, amountIn)),
  buildSwap(v, amountIn, floor, ME),
];

let failures = 0;

async function scenario(name: string, inSym: string, outSym: string, amount: string, pick: (v: Venue) => boolean) {
  const tokenIn = bySymbol(inSym, chain);
  const tokenOut = bySymbol(outSym, chain);
  const amountIn = parseUnits(amount, tokenIn.decimals);
  const curve = await bestOf(tokenIn, tokenOut, amountIn, pick);
  if (!curve) {
    console.log(`  skip  ${name}: no venue of that kind quotes this pair`);
    return;
  }
  const quoted = curve.rungs[0].amountOut;

  const setup: Tx[] = [{ to: chain.weth.address, data: '0xd0e30db0', value: parseEther('50') }];
  if (tokenIn.address !== chain.weth.address) {
    // Buy the input with WETH through the deepest direct Uniswap V3 pool.
    const buy = parseEther('10');
    const source = await bestOf(chain.weth, tokenIn, buy, (v) => v.family === 'v3' && v.hops.length === 1);
    setup.push(...swapSteps(source.venue, buy, 0n));
  }

  const steps = [...setup, balanceOf(tokenOut), ...swapSteps(curve.venue, amountIn, minOut(quoted, 50)), balanceOf(tokenOut)];
  const res = await simulate(steps);
  const failed = res.findIndex((r) => r.status !== '0x1');
  if (failed >= 0) {
    console.log(`  FAIL  ${name.padEnd(26)} ${curve.venue.label}: step ${failed + 1} of ${steps.length} reverted`);
    failures++;
    return;
  }
  const got = decodeBalance(res[res.length - 1].returnData) - decodeBalance(res[setup.length].returnData);
  const fmt = (v: bigint) => Number(formatUnits(v, tokenOut.decimals)).toPrecision(8);
  console.log(
    `  ok    ${name.padEnd(26)} ${curve.venue.label.padEnd(34)} quoted ${fmt(quoted)}  got ${fmt(got)} ${outSym}  gas ${BigInt(res[res.length - 2].gasUsed)}`,
  );
}

const family = (f: Venue['family'], hops = 1) => (v: Venue) => v.family === f && v.hops.length === hops;
const v4Native = (v: Venue) =>
  v.family === 'v4' && v.hops.length === 1 && v.hops[0].family === 'v4' && v.hops[0].key.currency0 === NATIVE;
const v4Weth = (v: Venue) =>
  v.family === 'v4' && v.hops.length === 1 && v.hops[0].family === 'v4' && v.hops[0].key.currency0 !== NATIVE;

console.log(`Simulating swaps on ${chain.name} at the head\n`);
await scenario('v2', 'WETH', 'USDG', '0.05', family('v2'));
await scenario('v3', 'WETH', 'USDG', '1', family('v3'));
await scenario('v3 two-hop', 'WETH', 'TSLA', '0.3', family('v3', 2));
await scenario('pancake v3', 'USDG', 'NVDA', '100', (v) => v.label.startsWith('PancakeSwap') && v.hops.length === 1);
await scenario('v4 ETH pool, unwrap in', 'WETH', 'USDG', '1', v4Native);
await scenario('v4 ETH pool, wrap out', 'USDG', 'WETH', '1000', v4Native);
await scenario('v4 WETH pool', 'WETH', 'NVDA', '0.1', v4Weth);
await scenario('v4 ERC-20 pool', 'USDG', 'NVDA', '1000', family('v4'));
await scenario('v4 stock to stock', 'TSLA', 'SPY', '1', family('v4'));
await scenario('v4 two-hop', 'NVDA', 'WETH', '1', family('v4', 2));

if (failures > 0) {
  console.error(`\n${failures} scenario(s) reverted`);
  process.exit(1);
}

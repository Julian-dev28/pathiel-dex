/**
 * Candidate venue probe.
 *
 * Before a venue is added to the router it has to answer three questions:
 * does the factory return a pool for a pair we care about, does that pool hold
 * anything, and — the one that actually bites — what fee does it charge?
 *
 * The fee is derived rather than looked up. Every V2 fork uses the same curve
 * with a different numerator, and the numerator is the difference between a
 * correct quote and a quote that is wrong by a few basis points on every trade
 * forever. So: read the reserves, ask the fork's own router what it would pay,
 * and solve for the fee that reconciles the two.
 *
 *   out = (in * (10000 - f) * rOut) / (rIn * 10000 + in * (10000 - f))
 *
 * rearranges to
 *
 *   in * (10000 - f) = out * rIn * 10000 / (rOut - out)
 *
 *   npm run probe:venues
 */

import { parseAbi, type Address } from 'viem';
import { client } from '../src/lib/quote';
import { CHAINS, bySymbol } from '../src/lib/chain';

const v2Factory = parseAbi(['function getPair(address,address) view returns (address)']);
const v2Pair = parseAbi([
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function token0() view returns (address)',
]);
const v2Router = parseAbi([
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])',
]);
const v3Quoter = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256, uint160, uint32, uint256)',
]);

// The candidates below are Base deployments.
const WETH = bySymbol('WETH', 'base');
const USDC = bySymbol('USDC', 'base');
const c = client(CHAINS.base);

type V2Candidate = { name: string; factory: Address; router: Address };

const V2_CANDIDATES: V2Candidate[] = [
  {
    name: 'PancakeSwap V2',
    factory: '0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E',
    router: '0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb',
  },
  {
    name: 'AlienBase',
    factory: '0x3E84D913803b02A4a7f027165E8cA42C14C0FdE7',
    router: '0x8c1A3cF8f83074169FE5D7aD50B978e1cD6b37c7',
  },
  {
    name: 'SwapBased',
    factory: '0x04C9f118d21e8B767D2e50C946f0cC9F6C367300',
    router: '0xaaa3b1F1bd7BCc97fD1917c18ADE665C5D31F066',
  },
];

const V3_CANDIDATES = [
  {
    name: 'PancakeSwap V3',
    quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997' as Address,
    // Pancake's tiers are not Uniswap's: 0.25% where Uniswap has 0.30%.
    tiers: [100, 500, 2500, 10000],
  },
];

console.log('probing V2-style candidates (WETH/USDC)\n');

for (const cand of V2_CANDIDATES) {
  try {
    const pool = (await c.readContract({
      address: cand.factory,
      abi: v2Factory,
      functionName: 'getPair',
      args: [WETH.address, USDC.address],
    })) as Address;

    if (pool === '0x0000000000000000000000000000000000000000') {
      console.log(`  ${cand.name.padEnd(16)} no WETH/USDC pair`);
      continue;
    }

    const [reserves, token0] = await Promise.all([
      c.readContract({ address: pool, abi: v2Pair, functionName: 'getReserves' }),
      c.readContract({ address: pool, abi: v2Pair, functionName: 'token0' }),
    ]);
    const [r0, r1] = reserves as unknown as [bigint, bigint, number];
    const inIsToken0 = (token0 as string).toLowerCase() === WETH.address.toLowerCase();
    const rIn = inIsToken0 ? r0 : r1;
    const rOut = inIsToken0 ? r1 : r0;

    // 0.001 WETH. The derivation is exact at any size in principle, but these
    // pools are small enough that integer rounding on a large trade swamps the
    // basis point being measured.
    const amountIn = 10n ** 15n;

    let derivedFee: string;
    let routerOk = false;
    try {
      const amounts = (await c.readContract({
        address: cand.router,
        abi: v2Router,
        functionName: 'getAmountsOut',
        args: [amountIn, [WETH.address, USDC.address]],
      })) as readonly bigint[];
      const out = amounts[amounts.length - 1];
      routerOk = out > 0n;

      // in * (10000 - f) = out * rIn * 10000 / (rOut - out)
      const numerator = (out * rIn * 10_000n) / (rOut - out);
      const fee = 10_000n - numerator / amountIn;
      derivedFee = `${fee} bp`;
    } catch (e) {
      derivedFee = `router failed: ${(e as Error).message.split('\n')[0].slice(0, 40)}`;
    }

    const ethSide = Number(rIn) / 1e18;
    const usdSide = Number(rOut) / 1e6;
    console.log(
      `  ${cand.name.padEnd(16)} pool ${pool.slice(0, 10)}…  ` +
        `${ethSide.toFixed(1)} WETH / ${usdSide.toFixed(0)} USDC  ` +
        `router:${routerOk ? 'ok' : 'NO'}  fee ${derivedFee}`,
    );
  } catch (e) {
    console.log(`  ${cand.name.padEnd(16)} FAILED: ${(e as Error).message.split('\n')[0]}`);
  }
}

console.log('\nprobing V3-style candidates (0.1 WETH -> USDC)\n');

for (const cand of V3_CANDIDATES) {
  for (const fee of cand.tiers) {
    try {
      const res = (await c.readContract({
        address: cand.quoter,
        abi: v3Quoter,
        functionName: 'quoteExactInputSingle',
        args: [
          {
            tokenIn: WETH.address,
            tokenOut: USDC.address,
            amountIn: 10n ** 17n,
            fee,
            sqrtPriceLimitX96: 0n,
          },
        ],
      })) as unknown as [bigint, bigint, number, bigint];
      const out = Number(res[0]) / 1e6;
      console.log(
        `  ${cand.name.padEnd(16)} ${(fee / 10_000).toFixed(2).padStart(5)}%  ` +
          `${out.toFixed(2)} USDC  (px ${(out / 0.1).toFixed(2)})`,
      );
    } catch {
      console.log(`  ${cand.name.padEnd(16)} ${(fee / 10_000).toFixed(2).padStart(5)}%  no pool`);
    }
  }
}

// ── Uniswap V4 ──────────────────────────────────────────────────────────────
//
// V4 has no factory: a pool is identified by its key, so there is nothing to
// ask "does this pair exist". The only way to find out is to quote a plausible
// key and see whether the quoter reverts — which is the same approach the V3
// tiers already use, just with more of the key to guess.
//
// A key is (currency0, currency1, fee, tickSpacing, hooks) with the currencies
// sorted ascending. Hooks are the hard part: any address can be a hook, and a
// pool with hooks quotes differently. Only the hookless pools are enumerable.

const v4Quoter = parseAbi([
  'function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)',
]);

const V4_QUOTER = '0x0d5e0F971ED27FBfF6c2837bf31316121532048D' as Address;
const V4_TIERS: [number, number][] = [
  [100, 1],
  [500, 10],
  [3000, 60],
  [10000, 200],
];

console.log('\nprobing Uniswap V4 (0.1 WETH -> USDC, hookless pools only)\n');

const [c0, c1] =
  WETH.address.toLowerCase() < USDC.address.toLowerCase()
    ? [WETH.address, USDC.address]
    : [USDC.address, WETH.address];
const zeroForOne = c0.toLowerCase() === WETH.address.toLowerCase();

for (const [fee, tickSpacing] of V4_TIERS) {
  try {
    const res = (await c.simulateContract({
      address: V4_QUOTER,
      abi: v4Quoter,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          poolKey: {
            currency0: c0,
            currency1: c1,
            fee,
            tickSpacing,
            hooks: '0x0000000000000000000000000000000000000000',
          },
          zeroForOne,
          exactAmount: 10n ** 17n,
          hookData: '0x',
        },
      ],
    })) as unknown as { result: [bigint, bigint] };
    const out = Number(res.result[0]) / 1e6;
    console.log(
      `  Uniswap V4       ${(fee / 10_000).toFixed(2).padStart(5)}%/${String(tickSpacing).padStart(3)}  ` +
        `${out.toFixed(2)} USDC  (px ${(out / 0.1).toFixed(2)})`,
    );
  } catch {
    console.log(
      `  Uniswap V4       ${(fee / 10_000).toFixed(2).padStart(5)}%/${String(tickSpacing).padStart(3)}  no hookless pool`,
    );
  }
}

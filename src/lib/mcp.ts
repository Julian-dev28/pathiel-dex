/**
 * The router's MCP tools, shared by two servers.
 *
 * `/api/mcp` (hosted) registers them with no account: it can quote and build
 * unsigned transactions, and nothing more, because a public endpoint must
 * never see a private key. `scripts/mcp.ts` (local, stdio) registers them with
 * an account loaded from the user's own machine, which adds `get_wallet` and
 * `swap` — the only tools that sign.
 *
 * Both paths keep the trade page's guard rails: exact approvals, an on-chain
 * output floor, and a refusal on high price impact unless the caller has
 * explicitly accepted it.
 */

import { z } from 'zod';
import {
  createWalletClient,
  fallback,
  getAddress,
  http,
  isAddress,
  type Address,
  type PrivateKeyAccount,
  type WalletClient,
} from 'viem';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  CHAIN_LIST,
  DEFAULT_CHAIN,
  bySymbol,
  chainByKey,
  rpcUrlsFor,
  type ChainConfig,
  type ChainKey,
  type Token,
} from './chain';
import { client } from './quote';
import { toBase, fromBase, jsonSafe } from './format';
import { buildSwap, approvalTx, approvalLabel, pendingApprovals, minOut, ERC20 } from './execute';
import { QUOTE_TTL_MS } from './serve';
import { solveQuote, type Solved } from './solve';

/** Same threshold the trade page asks a person to acknowledge. */
const HIGH_IMPACT_BPS = -300;
const SWAP_DEADLINE_SECONDS = 600;

// Every chain's symbols; whether a symbol exists is checked on the chain chosen.
const symbols = [...new Set(CHAIN_LIST.flatMap((c) => c.tokens.map((t) => t.symbol)))] as [string, ...string[]];
const chainKeys = CHAIN_LIST.map((c) => c.key) as [ChainKey, ...ChainKey[]];
const chainArg = {
  chain: z
    .enum(chainKeys)
    .default(DEFAULT_CHAIN)
    .describe('Chain to trade on: "robinhood" (Robinhood Chain, 4663, the default), "base" (Base, 8453) or "xlayer" (X Layer, 196)'),
};
const pair = {
  ...chainArg,
  tokenIn: z.enum(symbols).describe('Symbol of the token to sell, as list_tokens gives it for the chain'),
  tokenOut: z.enum(symbols).describe('Symbol of the token to buy, as list_tokens gives it for the chain'),
  amount: z
    .string()
    .regex(/^\d*\.?\d+$/)
    .max(30)
    .describe('Amount of tokenIn to sell, in whole units (e.g. "1.5"), not base units'),
};
const routeArg = {
  route: z
    .string()
    .max(80)
    .optional()
    .describe('Route label from get_quote\'s `routes` list (e.g. "Uniswap V4 0.05%"). Omit to use the best route.'),
};
const guards = {
  slippageBps: z.number().int().min(1).max(500).default(50).describe('Maximum slippage in basis points (50 = 0.5%)'),
  acceptHighImpact: z
    .boolean()
    .default(false)
    .describe('Set true only after the user has agreed to a price impact worse than 3%'),
};

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(jsonSafe(v), null, 2) }] });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });
const human = (v: bigint, t: Token) => `${fromBase(v, t)} ${t.symbol}`;
const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0];

/** Parse and quote, or say why not. */
async function quote(chainKey: ChainKey, inSym: string, outSym: string, amount: string) {
  const chain = chainByKey(chainKey);
  const has = (s: string) => chain.tokens.some((t) => t.symbol === s);
  if (!has(inSym) || !has(outSym)) {
    return { error: `${!has(inSym) ? inSym : outSym} is not listed on ${chain.name}; call list_tokens` };
  }
  const tokenIn = bySymbol(inSym, chain);
  const tokenOut = bySymbol(outSym, chain);
  if (tokenIn.address === tokenOut.address) return { error: 'tokenIn and tokenOut are the same' };
  const amountIn = toBase(amount, tokenIn);
  if (amountIn <= 0n) return { error: 'amount must be greater than zero' };
  const { value } = await solveQuote(tokenIn, tokenOut, amountIn);
  if (!value) return { error: `no liquidity found for ${inSym}/${outSym} on ${chain.name}` };
  return { chain, tokenIn, tokenOut, amountIn, q: value };
}

/** The best route, plus every quoted Uniswap route, best output first. */
function routeChoices(q: Solved) {
  const best = q.route.single.allocations[0].venue;
  return q.venues
    .filter((v) => v.venue.id === best.id || v.venue.label.startsWith('Uniswap'))
    .sort((a, b) => (a.amountOutAtFull > b.amountOutAtFull ? -1 : 1));
}

/**
 * Price impact of the chosen venue: the fill rate at full size against the
 * rate at the smallest rung of the ladder. Negative means the size moves the
 * price against the trader.
 */
function impactBps(q: Solved, venueId: string): number | null {
  const rungs = q.venues.find((v) => v.venue.id === venueId)?.rungs;
  if (!rungs || rungs.length < 2) return null;
  const [first, last] = [rungs[0], rungs[rungs.length - 1]];
  if (first.amountIn === 0n || last.amountIn === 0n) return null;
  const small = Number(first.amountOut) / Number(first.amountIn);
  const full = Number(last.amountOut) / Number(last.amountIn);
  return small > 0 ? Math.round(((full - small) / small) * 10_000) : null;
}

/** Quote, apply the guards, check funds, and build the transactions in order. */
async function prepareSwap(args: {
  chain: ChainKey;
  tokenIn: string;
  tokenOut: string;
  amount: string;
  route?: string;
  wallet: Address;
  slippageBps: number;
  acceptHighImpact: boolean;
}) {
  const r = await quote(args.chain, args.tokenIn, args.tokenOut, args.amount);
  if ('error' in r) return { error: r.error! };
  const { chain, tokenIn, tokenOut, amountIn, q } = r;
  const from = args.wallet;

  let venue = q.route.single.allocations[0].venue;
  let expected = q.route.single.amountOut;
  if (args.route) {
    const choice = routeChoices(q).find((v) => v.venue.label.toLowerCase() === args.route!.toLowerCase());
    if (!choice) {
      return {
        error: `No route "${args.route}" for this trade. Routes: ${routeChoices(q)
          .map((v) => v.venue.label)
          .join('; ')}`,
      };
    }
    venue = choice.venue;
    expected = choice.amountOutAtFull;
  }
  const floor = minOut(expected, args.slippageBps);
  const impact = impactBps(q, venue.id);
  if (impact !== null && impact < HIGH_IMPACT_BPS && !args.acceptHighImpact) {
    return {
      error: `Price impact is ${(impact / 100).toFixed(2)}%: selling ${human(amountIn, tokenIn)} on ${venue.label} returns ${human(expected, tokenOut)}. Confirm with the user, then call again with acceptHighImpact: true, or try a smaller amount.`,
    };
  }

  const [balance, approvals] = await Promise.all([
    client(chain).readContract({ address: tokenIn.address, abi: ERC20, functionName: 'balanceOf', args: [from] }),
    pendingApprovals(client(chain), from, venue, amountIn),
  ]);
  if (balance < amountIn) {
    return { error: `${from} holds ${human(balance, tokenIn)}; the swap needs ${human(amountIn, tokenIn)}.` };
  }

  // One approval for most venues; two for Uniswap V4, whose router spends
  // through Permit2. Each is for exactly the amount being sold.
  const txs: { step: 'approve' | 'swap'; description: string; to: Address; data: `0x${string}`; value: bigint }[] =
    approvals.map((a) => ({
      step: 'approve' as const,
      description: `${approvalLabel(a)}: exactly ${human(amountIn, tokenIn)}`,
      ...approvalTx(a, amountIn),
    }));
  txs.push({
    step: 'swap' as const,
    description: `Swap ${human(amountIn, tokenIn)} for at least ${human(floor, tokenOut)}`,
    ...buildSwap(venue, amountIn, floor, from, SWAP_DEADLINE_SECONDS),
  });

  return {
    chain,
    tokenOut,
    txs,
    summary: {
      chain: chain.name,
      chainId: chain.id,
      from,
      venue: venue.label,
      path: venue.path.map((t) => t.symbol).join(' → '),
      sell: human(amountIn, tokenIn),
      expectedReceive: human(expected, tokenOut),
      minimumReceive: human(floor, tokenOut),
      slippageBps: args.slippageBps,
      priceImpactBps: impact,
      block: q.blockNumber,
    },
  };
}

export function registerTools(server: McpServer, account?: PrivateKeyAccount) {
  server.registerTool(
    'list_tokens',
    {
      title: 'List tokens',
      description:
        'Every token this router can quote and swap on the chosen chain — Robinhood Chain (4663, default: tokenized stocks and ETFs, USDG, WETH), Base (8453) or X Layer (196: wrapped xStocks, USDG, USDC, USD₮0, xETH, xBTC): symbol, name, address, decimals. Tokens are passed to the other tools by symbol.',
      inputSchema: z.object(chainArg),
    },
    async ({ chain }) => text(chainByKey(chain).tokens),
  );

  server.registerTool(
    'get_quote',
    {
      title: 'Get quote',
      description:
        'Quote selling `amount` of tokenIn for tokenOut across every DEX venue on the chain — on Robinhood Chain (default) Uniswap V2/V3/V4 and PancakeSwap V3, with two-hop routes through WETH or USDG; on Base Uniswap V2/V3, PancakeSwap V3, SushiSwap, BaseSwap and Aerodrome, through WETH or USDC; on X Layer Uniswap V2/V3/V4, through USDG, USDC or xETH. Returns the best single venue, whether splitting across venues would do better net of gas, price impact, and the block the prices were read at.',
      inputSchema: z.object(pair),
    },
    async ({ chain: chainKey, tokenIn: inSym, tokenOut: outSym, amount }) => {
      const r = await quote(chainKey, inSym, outSym, amount);
      if ('error' in r) return fail(r.error!);
      const { chain, tokenIn, tokenOut, amountIn, q } = r;
      const best = q.route.single.allocations[0];
      return text({
        chain: chain.name,
        sell: human(amountIn, tokenIn),
        block: q.blockNumber,
        bestVenue: {
          venue: best.venue.label,
          path: best.venue.path.map((t) => t.symbol).join(' → '),
          receive: human(q.route.single.amountOut, tokenOut),
          priceImpactBps: impactBps(q, best.venue.id),
        },
        split: {
          receive: human(q.route.split.amountOut, tokenOut),
          allocations: q.route.split.allocations.map((a) => `${a.share}% ${a.venue.label}`),
          edgeOverBestVenueBps: q.route.edgeBps,
          netOfGasBps: q.gas.gasAdjusted ? q.route.netEdgeBps : null,
        },
        recommended: q.route.chosen,
        venuesQuoted: q.venues.length,
        routes: routeChoices(q).map((v) => ({
          route: v.venue.label,
          path: v.venue.path.map((t) => t.symbol).join(' → '),
          receive: human(v.amountOutAtFull, tokenOut),
          vsBestBps:
            q.route.single.amountOut > 0n
              ? Number(((v.amountOutAtFull - q.route.single.amountOut) * 10_000n) / q.route.single.amountOut)
              : 0,
        })),
        note: 'Swaps execute on the best single venue unless build_swap/swap is given one of `routes` as `route`.',
      });
    },
  );

  server.registerTool(
    'build_swap',
    {
      title: 'Build swap',
      description:
        'Build the unsigned transactions to swap `amount` of tokenIn for tokenOut from `wallet` on the chosen chain (Robinhood Chain by default), routed through the best single venue, or through `route` if given. Returns any exact-amount approvals the wallet still needs first — one, or two for Uniswap V4 routes, which spend through Permit2 — then the swap. Send them in order from `wallet` on the chainId given, waiting for each approval to confirm; the swap must be mined within 10 minutes or it reverts. Nothing is signed or sent by this tool. The minimum output (slippage floor) is enforced on-chain. Refuses routes with more than 3% price impact unless acceptHighImpact is true.',
      inputSchema: z.object({
        ...pair,
        wallet: z
          .string()
          .refine((a) => isAddress(a), 'not an address')
          .describe('Address that holds tokenIn, signs both transactions, and receives tokenOut'),
        ...routeArg,
        ...guards,
      }),
    },
    async (args) => {
      const plan = await prepareSwap({ ...args, wallet: getAddress(args.wallet) });
      if ('error' in plan) return fail(plan.error!);
      return text({
        ...plan.summary,
        quoteValidForSeconds: QUOTE_TTL_MS / 1000,
        transactions: plan.txs.map((t) => ({
          ...t,
          chainId: plan.chain.id,
          from: plan.summary.from,
          value: `0x${t.value.toString(16)}`,
        })),
      });
    },
  );

  if (!account) return;

  // ── signing tools: local server only ──────────────────────────────────

  const wallets = new Map<number, WalletClient>();
  const walletFor = (chain: ChainConfig): WalletClient => {
    let w = wallets.get(chain.id);
    if (!w) {
      const urls = rpcUrlsFor(chain);
      w = createWalletClient({
        account,
        chain: chain.viem,
        transport: fallback(urls.map((url) => http(url, { timeout: 12_000 }))),
      });
      wallets.set(chain.id, w);
    }
    return w;
  };

  server.registerTool(
    'get_wallet',
    {
      title: 'Get wallet',
      description:
        'The address of the wallet this server trades from, and on the chosen chain its ETH balance (gas on both chains is paid in ETH) and every non-zero balance among the tokens it can route.',
      inputSchema: z.object(chainArg),
    },
    async ({ chain: chainKey }) => {
      const chain = chainByKey(chainKey);
      const c = client(chain);
      const [eth, balances] = await Promise.all([
        c.getBalance({ address: account.address }),
        c.multicall({
          contracts: chain.tokens.map((t) => ({
            address: t.address,
            abi: ERC20,
            functionName: 'balanceOf' as const,
            args: [account.address] as const,
          })),
          allowFailure: true,
        }),
      ]);
      return text({
        address: account.address,
        chain: chain.name,
        chainId: chain.id,
        eth: `${fromBase(eth, { ...chain.weth, symbol: 'ETH', name: 'Ether', address: '0x0000000000000000000000000000000000000000' })} ETH`,
        tokens: chain.tokens.flatMap((t, i) => {
          const b = balances[i];
          return b.status === 'success' && (b.result as bigint) > 0n ? [human(b.result as bigint, t)] : [];
        }),
      });
    },
  );

  server.registerTool(
    'swap',
    {
      title: 'Swap',
      description:
        'EXECUTES A REAL TRADE with the local wallet on the chosen chain (Robinhood Chain by default), spending real funds. Sells `amount` of tokenIn for tokenOut through the best single venue, or through `route` if given: sends any exact-amount approvals needed, waits for each, then sends the swap and waits for confirmation. The minimum output is enforced on-chain. Refuses routes with more than 3% price impact unless acceptHighImpact is true. Confirm the trade with the user (get_quote first) before calling.',
      inputSchema: z.object({ ...pair, ...routeArg, ...guards }),
    },
    async (args) => {
      const plan = await prepareSwap({ ...args, wallet: account.address });
      if ('error' in plan) return fail(plan.error!);
      const c = client(plan.chain);
      const wallet = walletFor(plan.chain);
      const explorer = plan.chain.explorer;

      const sent: { step: string; hash: string; explorer: string }[] = [];
      try {
        const before = await c.readContract({
          address: plan.tokenOut.address,
          abi: ERC20,
          functionName: 'balanceOf',
          args: [account.address],
        });

        let lastBlock: bigint | undefined;
        for (const tx of plan.txs) {
          if (tx.step === 'swap') {
            // Dry-run against the state the approval produced, so a swap that
            // would revert costs nothing rather than its gas.
            try {
              await c.call({ account: account.address, to: tx.to, data: tx.data, blockNumber: lastBlock });
            } catch (e) {
              return fail(`Swap would revert, not sent: ${firstLine(e)}. Sent so far: ${JSON.stringify(sent)}`);
            }
          }
          const hash = await wallet.sendTransaction({
            account,
            chain: plan.chain.viem,
            to: tx.to,
            data: tx.data,
            value: tx.value,
          });
          sent.push({ step: tx.step, hash, explorer: `${explorer}/tx/${hash}` });
          const receipt = await c.waitForTransactionReceipt({ hash, timeout: 120_000 });
          if (receipt.status !== 'success') {
            return fail(`${tx.step} transaction reverted: ${explorer}/tx/${hash}`);
          }
          lastBlock = receipt.blockNumber;
        }

        const after = await c.readContract({
          address: plan.tokenOut.address,
          abi: ERC20,
          functionName: 'balanceOf',
          args: [account.address],
          blockNumber: lastBlock,
        });

        return text({
          ...plan.summary,
          received: human(after - before, plan.tokenOut),
          transactions: sent,
        });
      } catch (e) {
        return fail(`Swap failed: ${firstLine(e)}. Sent so far: ${JSON.stringify(sent)}`);
      }
    },
  );
}

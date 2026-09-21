/**
 * Replaying real trades against the router.
 *
 * The fork tests prove the router's quote matches what the chain would pay.
 * They do not say whether the route it picks is any *good* — for that you need
 * a counterfactual, and the honest one is already on-chain: every swap someone
 * actually executed on Base is a decision made under the same conditions, with
 * real money, by someone who had their own router.
 *
 * So: read the Swap logs, take each trade, re-quote it as it stood one block
 * earlier, and compare. The result is a distribution rather than a number, and
 * it is the only claim in this project that is about routing *quality* rather
 * than routing *correctness*.
 *
 * Three biases matter, and all three are corrected here rather than mentioned
 * in a footnote:
 *
 *   1. **Quote at the parent block.** A trade's own swap is in the block it
 *      landed in, so quoting at that height prices the pool it already moved.
 *      The state the trader actually faced is the end of `block - 1`.
 *
 *   2. **Single-swap transactions only.** A swap log that is one leg of an
 *      aggregator's multi-hop route is not a complete trade. Comparing our
 *      whole-route output against one leg of theirs would flatter us enormously.
 *      Transactions containing more than one Swap log are discarded.
 *
 *   3. **Gross of gas.** Both sides pay gas and we do not know theirs, so the
 *      comparison is output-to-output. Our own extra-hop cost is *not* netted
 *      out either, which if anything favours the observed trade.
 */

import { parseAbiItem, decodeEventLog, type Address, type Log } from 'viem';
import { client, discover, quoteLadder, ladder, bestRoute, type Venue } from './quote';
import { CHAINS, byAddress, type Token } from './chain';

/** Uniswap V3 and its forks. Signed amounts: negative leaves the pool. */
export const V3_SWAP = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
);

/** Uniswap V2 forks and Solidly/Aerodrome share this shape. */
export const V2_SWAP = parseAbiItem(
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
);

/** A trade someone actually made. */
export type ObservedSwap = {
  blockNumber: bigint;
  txHash: `0x${string}`;
  pool: Address;
  tokenIn: Token;
  tokenOut: Token;
  amountIn: bigint;
  amountOut: bigint;
};

/** Pool address → the two tokens it holds, for decoding amounts to tokens. */
export type PoolIndex = Map<string, { token0: Token; token1: Token; family: Venue['family'] }>;

/**
 * Build a pool index from the router's own discovery.
 *
 * Reusing `discover` rather than a hardcoded pool list means the backtest
 * watches exactly the venues the router would route to — if a venue is added,
 * it starts being backtested with no further work.
 */
export async function buildPoolIndex(pairs: [Token, Token][]): Promise<PoolIndex> {
  const index: PoolIndex = new Map();

  for (const [a, b] of pairs) {
    const venues = await discover(a, b);
    for (const v of venues) {
      v.hops.forEach((h, i) => {
        // No address until the factory is asked; V4 pools have none at all.
        if (h.family === 'v3' || h.family === 'v4') return;
        const [x, y] = [v.path[i], v.path[i + 1]];
        // token0/token1 ordering is by address, which is how the pool reports
        // its amounts regardless of which way the trade went.
        const [token0, token1] =
          x.address.toLowerCase() < y.address.toLowerCase() ? [x, y] : [y, x];
        index.set(h.pool.toLowerCase(), { token0, token1, family: h.family });
      });
    }
  }

  return index;
}

/** Add V3 pools, whose addresses have to be resolved from the factory. */
export function addV3Pools(
  index: PoolIndex,
  pools: { pool: Address; a: Token; b: Token }[],
): PoolIndex {
  for (const { pool, a, b } of pools) {
    const [token0, token1] = a.address.toLowerCase() < b.address.toLowerCase() ? [a, b] : [b, a];
    index.set(pool.toLowerCase(), { token0, token1, family: 'v3' });
  }
  return index;
}

/**
 * Fetch and decode Swap logs across a set of pools.
 *
 * `getLogs` is filtered by address list rather than issued per pool: one range
 * query over twenty pools is one request, and public endpoints meter requests
 * far more tightly than they meter addresses in a filter.
 */
export async function fetchSwaps(
  index: PoolIndex,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<ObservedSwap[]> {
  const addresses = [...index.keys()] as Address[];
  if (addresses.length === 0) return [];

  // The dataset is Base swaps; see the header.
  const c = client(CHAINS.base);
  const [v3Logs, v2Logs] = await Promise.all([
    c.getLogs({ address: addresses, event: V3_SWAP, fromBlock, toBlock }).catch(() => []),
    c.getLogs({ address: addresses, event: V2_SWAP, fromBlock, toBlock }).catch(() => []),
  ]);

  // A transaction with more than one Swap is a multi-hop or split route, and
  // one of its legs is not a trade we can compare against. Counted across both
  // event shapes, since an aggregator can cross families in one transaction.
  const swapsPerTx = new Map<string, number>();
  for (const log of [...v3Logs, ...v2Logs] as Log[]) {
    const h = log.transactionHash!;
    swapsPerTx.set(h, (swapsPerTx.get(h) ?? 0) + 1);
  }

  const out: ObservedSwap[] = [];

  for (const log of v3Logs) {
    if (swapsPerTx.get(log.transactionHash!) !== 1) continue;
    const meta = index.get(log.address.toLowerCase());
    if (!meta) continue;
    try {
      const { args } = decodeEventLog({ abi: [V3_SWAP], data: log.data, topics: log.topics });
      const a0 = args.amount0 as bigint;
      const a1 = args.amount1 as bigint;
      // Exactly one side is positive (into the pool) and one negative (out).
      if (a0 === 0n || a1 === 0n) continue;
      const zeroIn = a0 > 0n;
      out.push({
        blockNumber: log.blockNumber!,
        txHash: log.transactionHash!,
        pool: log.address,
        tokenIn: zeroIn ? meta.token0 : meta.token1,
        tokenOut: zeroIn ? meta.token1 : meta.token0,
        amountIn: zeroIn ? a0 : a1,
        amountOut: zeroIn ? -a1 : -a0,
      });
    } catch {
      /* not the event we thought */
    }
  }

  for (const log of v2Logs) {
    if (swapsPerTx.get(log.transactionHash!) !== 1) continue;
    const meta = index.get(log.address.toLowerCase());
    if (!meta) continue;
    try {
      const { args } = decodeEventLog({ abi: [V2_SWAP], data: log.data, topics: log.topics });
      const in0 = args.amount0In as bigint;
      const in1 = args.amount1In as bigint;
      const out0 = args.amount0Out as bigint;
      const out1 = args.amount1Out as bigint;
      const zeroIn = in0 > 0n;
      const amountIn = zeroIn ? in0 : in1;
      const amountOut = zeroIn ? out1 : out0;
      if (amountIn === 0n || amountOut === 0n) continue;
      out.push({
        blockNumber: log.blockNumber!,
        txHash: log.transactionHash!,
        pool: log.address,
        tokenIn: zeroIn ? meta.token0 : meta.token1,
        tokenOut: zeroIn ? meta.token1 : meta.token0,
        amountIn,
        amountOut,
      });
    } catch {
      /* not the event we thought */
    }
  }

  return out.sort((a, b) => Number(a.blockNumber - b.blockNumber));
}

export type BacktestResult = {
  txHash: string;
  blockNumber: string;
  pair: string;
  amountIn: string;
  /** What the trade actually received on-chain. */
  actualOut: string;
  /** What this router's best single-venue route would have returned. */
  routerOut: string;
  /** Router advantage over the observed fill, in basis points. Negative = we lose. */
  edgeBps: number;
  routerVenue: string;
  routerHops: number;
  /** True when the router would have used a route the trade did not. */
  differentVenue: boolean;
};

/**
 * Re-quote one observed trade as it stood before it executed.
 *
 * Returns null when the router cannot quote the pair at that height, which
 * happens for tokens outside the table and for blocks past the endpoint's
 * history. A skipped sample is not a zero — averaging it in as one would bias
 * the result toward "no difference".
 */
export async function replay(swap: ObservedSwap): Promise<BacktestResult | null> {
  const at = swap.blockNumber - 1n;
  try {
    const curves = await quoteLadder(
      swap.tokenIn,
      swap.tokenOut,
      ladder(swap.amountIn, 6),
      undefined,
      at,
    );
    if (curves.length === 0) return null;

    const best = bestRoute(curves, swap.amountIn);
    const venue = best.single.allocations[0]?.venue;
    if (!venue || best.single.amountOut === 0n) return null;

    const edgeBps = Number(
      ((best.single.amountOut - swap.amountOut) * 10_000n) / swap.amountOut,
    );

    return {
      txHash: swap.txHash,
      blockNumber: swap.blockNumber.toString(),
      pair: `${swap.tokenIn.symbol}/${swap.tokenOut.symbol}`,
      amountIn: swap.amountIn.toString(),
      actualOut: swap.amountOut.toString(),
      routerOut: best.single.amountOut.toString(),
      edgeBps,
      routerVenue: venue.label,
      routerHops: venue.hops.length,
      differentVenue:
        venue.hops.length > 1 ||
        !venue.hops.some(
          (h) => h.family !== 'v3' && h.family !== 'v4' && h.pool.toLowerCase() === swap.pool.toLowerCase(),
        ),
    };
  } catch {
    return null;
  }
}

/** Median is the honest centre here: a couple of near-empty pools produce
 *  four-figure outliers that make a mean meaningless. */
export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function summarise(results: BacktestResult[]) {
  const edges = results.map((r) => r.edgeBps);
  const wins = results.filter((r) => r.edgeBps > 0);
  const losses = results.filter((r) => r.edgeBps < 0);
  return {
    samples: results.length,
    medianEdgeBps: median(edges),
    winRate: results.length ? wins.length / results.length : 0,
    wins: wins.length,
    losses: losses.length,
    ties: results.length - wins.length - losses.length,
    medianWinBps: median(wins.map((r) => r.edgeBps)),
    medianLossBps: median(losses.map((r) => r.edgeBps)),
    p25EdgeBps: percentile(edges, 25),
    p75EdgeBps: percentile(edges, 75),
    multiHopUsed: results.filter((r) => r.routerHops > 1).length,
  };
}

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round(((p / 100) * (s.length - 1)))));
  return s[i];
}

export const byAddressOrThrow = (a: string): Token => {
  const t = byAddress(a, 'base');
  if (!t) throw new Error(`token not in table: ${a}`);
  return t;
};

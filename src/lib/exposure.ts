/**
 * Execution risk: what a slippage tolerance actually costs.
 *
 * Every swap interface ships a default slippage of 0.5%, and almost nobody
 * changes it. That number is not a safety margin — it is a standing offer. A
 * sandwicher can push the pool until the victim receives exactly their minimum
 * and keep the difference, so the tolerance a trader grants *is* the bounty
 * they post. On WETH/USDC the price moves about 2.5bp over an inclusion window;
 * the default posts twenty times that.
 *
 * This module computes both halves of the trade-off:
 *
 *   - **Exposure**: quoted output minus the on-chain floor, in output tokens.
 *     This is the maximum a sandwich can extract, and it is exact rather than
 *     estimated — it is the difference the user themselves authorised.
 *
 *   - **Drift**: how much the pair's price actually moves over the time it
 *     takes to get included, measured from Swap logs rather than assumed. That
 *     is the tolerance genuinely needed.
 *
 * The measurement is nearly free. Uniswap V3 Swap events carry `sqrtPriceX96`,
 * so one `getLogs` call over a few hundred blocks reconstructs the entire price
 * series for a pool — no historical `eth_call` per block, no archive
 * dependency, no price feed.
 */

import { parseAbiItem, type Address } from 'viem';
import { client } from './quote';
import type { ChainConfig, Token } from './chain';

const V3_SWAP = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
);

/**
 * How long a transaction realistically waits before inclusion.
 *
 * Twelve seconds — long enough to cover a wallet's signing prompt and the
 * sequencer accepting the transaction. Slippage has to survive this window,
 * and nothing longer: a tolerance sized for a minute of drift is a minute of
 * bounty.
 *
 * It is a time, not a block count, because the chains disagree by twenty
 * times on what a block is: six blocks on Base, a hundred and twenty on
 * Robinhood Chain.
 */
const INCLUSION_MS = 12_000;

export const inclusionBlocks = (chain: ChainConfig): bigint =>
  BigInt(Math.ceil(INCLUSION_MS / chain.blockMs));

export type Drift = {
  pool: Address;
  /** Blocks the estimate looked back over. Wider means a thinner pool. */
  lookbackBlocks?: number;
  /** Pools the estimate combines. One for a direct pair, two via an intermediate. */
  legs?: number;
  observations: number;
  fromBlock: string;
  toBlock: string;
  /** Absolute price change over the inclusion window, in basis points. */
  p50: number;
  p95: number;
  p99: number;
  max: number;
};

const percentile = (sorted: number[], p: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1)))];

/**
 * Measure realised price drift for a pool from its own Swap events.
 *
 * `sqrtPriceX96` is the square root of the price, so the price ratio between
 * two observations is the square of their ratio. Done in floating point on
 * purpose: this is a statistic about volatility, not a number anyone is paid,
 * and the bigint the pool reports has far more precision than the estimate
 * deserves.
 */
/**
 * Escalating lookback windows.
 *
 * A busy pool has hundreds of windows in 600 blocks; a thin one has none. Rather
 * than pick a compromise that is too short for the quiet pairs and needlessly
 * long for the liquid ones, widen until there is a sample. The cost of a wider
 * window is that the estimate reaches further into the past — acceptable for a
 * pool that trades rarely, since that past is the only evidence there is.
 */
const LOOKBACK_MS = [20 * 60_000, 80 * 60_000] as const;

export async function measureDriftEscalating(pool: Address, chain: ChainConfig): Promise<Drift | null> {
  for (const ms of LOOKBACK_MS) {
    const d = await measureDrift(pool, chain, BigInt(Math.ceil(ms / chain.blockMs)));
    if (d) return d;
  }
  return null;
}

export async function measureDrift(pool: Address, chain: ChainConfig, lookback: bigint): Promise<Drift | null> {
  const c = client(chain);
  const window = inclusionBlocks(chain);
  const head = await c.getBlockNumber();
  const fromBlock = head - lookback;

  let logs;
  try {
    logs = await c.getLogs({ address: pool, event: V3_SWAP, fromBlock, toBlock: head });
  } catch {
    return null;
  }
  // A handful of dust trades is not a price series. Twenty windows is still a
  // small sample, but it is enough that a single odd print cannot set the
  // 95th percentile on its own.
  if (logs.length < 24) return null;

  // Last price seen in each block. Several swaps can land in one block, and
  // only the last one is the state the next block starts from.
  const byBlock = new Map<bigint, number>();
  for (const l of logs) {
    const sqrt = Number((l.args as { sqrtPriceX96?: bigint }).sqrtPriceX96 ?? 0n);
    if (sqrt > 0) byBlock.set(l.blockNumber!, sqrt);
  }

  const blocks = [...byBlock.keys()].sort((a, b) => Number(a - b));
  const moves: number[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const start = blocks[i];
    // The first observation at least an inclusion window later. Pools trade
    // irregularly, so this is "the next price after the window" rather than an
    // exact horizon — which is the price a trader would actually have faced.
    const end = blocks.find((b) => b >= start + window);
    if (end === undefined) break;
    const a = byBlock.get(start)!;
    const b = byBlock.get(end)!;
    moves.push(Math.abs(((b / a) ** 2 - 1) * 10_000));
  }

  if (moves.length < 20) return null;
  moves.sort((x, y) => x - y);

  return {
    pool,
    lookbackBlocks: Number(lookback),
    observations: moves.length,
    fromBlock: fromBlock.toString(),
    toBlock: head.toString(),
    p50: percentile(moves, 50),
    p95: percentile(moves, 95),
    p99: percentile(moves, 99),
    max: moves[moves.length - 1],
  };
}

export type Exposure = {
  /** Output the quote promised. */
  quotedOut: bigint;
  /** The on-chain floor this slippage produces. */
  floor: bigint;
  /** quotedOut − floor: the most a sandwich can take. */
  exposure: bigint;
  slippageBps: number;
  /** Exposure as a fraction of the trade, in basis points. Equals slippageBps. */
  exposureBps: number;
};

/**
 * What a given slippage tolerance is worth to an attacker.
 *
 * Deliberately not an estimate. A sandwicher's profit is bounded above by the
 * gap between what the pool would have paid and what the victim agreed to
 * accept, and that gap is arithmetic the user can check.
 */
export function exposureAt(quotedOut: bigint, slippageBps: number): Exposure {
  const bps = BigInt(Math.max(0, Math.min(5_000, Math.round(slippageBps))));
  const floor = (quotedOut * (10_000n - bps)) / 10_000n;
  return {
    quotedOut,
    floor,
    exposure: quotedOut - floor,
    slippageBps: Number(bps),
    exposureBps: quotedOut > 0n ? Number(((quotedOut - floor) * 10_000n) / quotedOut) : 0,
  };
}

/**
 * Combine the drift of two legs of a route.
 *
 * A two-hop price is the product of its legs, so log-returns add and — treating
 * the legs as independent — variances add. The percentiles are combined in
 * quadrature accordingly.
 *
 * The independence assumption is the weak part and is worth naming: both legs
 * usually share WETH, so a move in ETH shows up in each and the true drift is
 * higher than this. It is a floor on the risk, not a ceiling, which is the
 * direction an under-estimate must not go — so the caller doubles it for
 * headroom before recommending anything.
 */
export function combineDrift(a: Drift | null, b: Drift | null): Drift | null {
  if (!a) return b;
  if (!b) return a;
  const quad = (x: number, y: number) => Math.sqrt(x * x + y * y);
  return {
    pool: a.pool,
    legs: 2,
    observations: Math.min(a.observations, b.observations),
    fromBlock: a.fromBlock,
    toBlock: a.toBlock,
    p50: quad(a.p50, b.p50),
    p95: quad(a.p95, b.p95),
    p99: quad(a.p99, b.p99),
    max: quad(a.max, b.max),
  };
}

export type Recommendation = {
  recommendedBps: number;
  driftP95Bps: number;
  /** How much evidence the recommendation rests on. */
  observations: number;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  /** Basis points of exposure a wallet's stock 0.5% default would add. */
  savedVsDefaultBps: number;
};

/** The tolerance a stock wallet ships, and what this is measured against. */
export const DEFAULT_WALLET_SLIPPAGE_BPS = 50;

/**
 * Recommend a slippage tolerance from measured drift.
 *
 * Twice the 95th percentile, floored at 5bp and capped at 200bp. The doubling
 * is headroom for the tail the sample did not see; the floor stops a
 * recommendation so tight that ordinary block-to-block noise reverts the
 * transaction, which costs gas and helps nobody.
 *
 * When drift cannot be measured the recommendation is the conservative default
 * rather than a guess — an unmeasured pair is exactly where a confident number
 * would be most misleading.
 */
export function recommendSlippage(drift: Drift | null): Recommendation {
  if (!drift) {
    return {
      recommendedBps: DEFAULT_WALLET_SLIPPAGE_BPS,
      driftP95Bps: 0,
      observations: 0,
      confidence: 'low',
      reason: 'not enough recent trades to measure drift; using the conservative default',
      savedVsDefaultBps: 0,
    };
  }

  const n = drift.observations;

  /**
   * The multiplier widens as the sample shrinks.
   *
   * Twenty-three windows on a pool that barely trades is not the same evidence
   * as four hundred on WETH/USDC, and a tight recommendation drawn from the
   * first is a confident number resting on nothing. Below fifty observations
   * the recommendation is not allowed to go under the wallet default at all —
   * the whole point of this feature is to *reduce* risk, and it must not
   * increase it on the pairs it understands least.
   */
  const confidence: Recommendation['confidence'] = n >= 200 ? 'high' : n >= 50 ? 'medium' : 'low';
  const multiple = confidence === 'high' ? 2 : 3;
  const raw = drift.p95 * multiple;

  const recommendedBps =
    confidence === 'low'
      ? DEFAULT_WALLET_SLIPPAGE_BPS
      : Math.round(Math.min(200, Math.max(5, raw)));

  const reason =
    confidence === 'low'
      ? `only ${n} inclusion windows observed — too thin to justify tightening, ` +
        'so the conservative default stands'
      : `price moved ${drift.p95.toFixed(2)}bp or less in 95% of ${n} inclusion windows` +
        (drift.legs === 2 ? ', combined across both legs of the route' : '') +
        `; multiplied by ${multiple} for headroom`;

  return {
    recommendedBps,
    driftP95Bps: drift.p95,
    observations: n,
    confidence,
    reason,
    savedVsDefaultBps: Math.max(0, DEFAULT_WALLET_SLIPPAGE_BPS - recommendedBps),
  };
}

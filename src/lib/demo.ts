/**
 * Demo mode: a populated interface with no chain behind it.
 *
 * The trade terminal is honest about having nothing to show — no wallet means
 * no balances, and a fresh deployment has no fill history. That is correct and
 * it demos terribly, so this module supplies a portfolio and a fill history for
 * builds that ask for one.
 *
 * Three rules this module holds to, because the alternative is a finance site
 * publishing invented numbers as fact:
 *
 *   1. It is off unless `NEXT_PUBLIC_DEMO_MODE=1` is set at build time. There is
 *      no runtime toggle and no way for a request to switch it on.
 *   2. A connected wallet always wins. Sample balances render only when there is
 *      no real account to read, so nobody is ever shown a fabricated number in
 *      place of their own.
 *   3. Everything it returns is labelled `sample` where it renders. The label is
 *      quiet — a chip in the panel header, in the same vocabulary as `streaming`
 *      and `quiet` — but it is never absent.
 *
 * Determinism matters here beyond tidiness. These values render on the server
 * and again on the client; anything drawn from `Math.random()` or `Date.now()`
 * at module scope produces a hydration mismatch. Every figure below comes from
 * a seeded PRNG with a fixed seed, so both passes agree.
 */

import { bySymbol, type Token } from './chain';

/**
 * Build-time flag. Read through a named constant rather than inline so the
 * bundler can see a single literal and drop the demo tree entirely from a
 * production build that does not set it.
 */
export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === '1';

/** mulberry32: small, fast, and stable across engines — which is the only property that matters here. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform pick from a range, rounded to `places`. */
function span(rng: () => number, lo: number, hi: number, places = 4): number {
  const v = lo + rng() * (hi - lo);
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

/** A plausible 32-byte hash. Deterministic, and not a hash of anything real. */
function fakeHash(rng: () => number): string {
  let out = '0x';
  for (let i = 0; i < 64; i++) out += Math.floor(rng() * 16).toString(16);
  return out;
}

export type DemoHolding = {
  token: Token;
  /** Base units, the same representation every other balance in the app uses. */
  amount: bigint;
  /** Notional in USD, for the portfolio total. */
  usd: number;
};

export type DemoFill = {
  txHash: string;
  inSym: string;
  outSym: string;
  amountIn: string;
  amountOut: string;
  venue: string;
  /** Edge captured against the naive single-venue route, in basis points. */
  edgeBps: number;
  /** Seconds before page load. The view ticks this forward after mount. */
  agoSeconds: number;
};

/**
 * Prices used to turn holdings into a portfolio total.
 *
 * Static on purpose. A demo that fetches live prices to value invented holdings
 * produces a number that is half real and half not, which is worse than one
 * that is plainly neither.
 */
const DEMO_PRICES: Record<string, number> = {
  WETH: 4218.4,
  USDC: 1,
  cbBTC: 111_940,
  DAI: 1,
  cbETH: 4551.2,
  AERO: 1.34,
  DEGEN: 0.0121,
};

const HOLDING_PLAN: { symbol: string; lo: number; hi: number }[] = [
  { symbol: 'WETH', lo: 3.1, hi: 3.9 },
  { symbol: 'USDC', lo: 18_000, hi: 24_000 },
  { symbol: 'cbBTC', lo: 0.14, hi: 0.22 },
  { symbol: 'AERO', lo: 2_800, hi: 4_200 },
  { symbol: 'DEGEN', lo: 60_000, hi: 95_000 },
];

/** Base units without floating-point drift: split on the decimal point and pad. */
function toBaseUnits(human: number, decimals: number): bigint {
  const fixed = human.toFixed(decimals);
  const [whole, frac = ''] = fixed.split('.');
  return BigInt(whole + frac.padEnd(decimals, '0'));
}

/**
 * The sample portfolio.
 *
 * Sized to look like an active trader rather than a whale — roughly $60k, spread
 * across five positions with one memecoin tail. A demo balance large enough to
 * be impressive reads as fake; this one reads as somebody's actual wallet.
 */
export function demoHoldings(seed = 0x9e3779b9): DemoHolding[] {
  const rng = seeded(seed);
  return HOLDING_PLAN.map(({ symbol, lo, hi }) => {
    const token = bySymbol(symbol, 'base');
    const human = span(rng, lo, hi, Math.min(token.decimals, 6));
    return {
      token,
      amount: toBaseUnits(human, token.decimals),
      usd: human * (DEMO_PRICES[symbol] ?? 0),
    };
  });
}

export function demoPortfolioUsd(holdings: DemoHolding[]): number {
  return holdings.reduce((sum, h) => sum + h.usd, 0);
}

const FILL_PLAN: { inSym: string; outSym: string; venue: string; lo: number; hi: number }[] = [
  { inSym: 'WETH', outSym: 'USDC', venue: 'Aerodrome', lo: 0.4, hi: 1.2 },
  { inSym: 'USDC', outSym: 'cbBTC', venue: 'Uniswap V3', lo: 1_500, hi: 4_000 },
  { inSym: 'AERO', outSym: 'WETH', venue: 'Aerodrome', lo: 400, hi: 900 },
  { inSym: 'USDC', outSym: 'WETH', venue: 'Uniswap V3 + Aerodrome', lo: 2_000, hi: 6_500 },
  { inSym: 'cbBTC', outSym: 'USDC', venue: 'Uniswap V3', lo: 0.01, hi: 0.04 },
  { inSym: 'WETH', outSym: 'AERO', venue: 'Aerodrome', lo: 0.2, hi: 0.7 },
];

/**
 * Sample fills.
 *
 * The edge figures sit between 1 and 34 bp, which is the range the real backtest
 * in `data/backtest.jsonl` actually produces. Inventing a headline number the
 * solver has never hit would make the demo a claim about performance rather than
 * a picture of the layout, so the invented data stays inside the measured range.
 */
export function demoFills(seed = 0x85ebca6b): DemoFill[] {
  const rng = seeded(seed);
  let ago = 0;
  return FILL_PLAN.map(({ inSym, outSym, venue, lo, hi }) => {
    const tIn = bySymbol(inSym, 'base');
    const tOut = bySymbol(outSym, 'base');
    const amountIn = span(rng, lo, hi, Math.min(tIn.decimals, 4));
    const rate = (DEMO_PRICES[inSym] ?? 1) / (DEMO_PRICES[outSym] ?? 1);
    const edgeBps = span(rng, 1.2, 34, 1);
    const amountOut = amountIn * rate * (1 + edgeBps / 10_000);
    // Gaps of 40s to 11m, accumulating, so the list reads newest-first with
    // uneven spacing rather than a suspiciously regular cadence.
    ago += Math.floor(span(rng, 40, 660, 0));
    return {
      txHash: fakeHash(rng),
      inSym,
      outSym,
      amountIn: amountIn.toFixed(Math.min(tIn.decimals, 4)),
      amountOut: amountOut.toFixed(Math.min(tOut.decimals, 4)),
      venue,
      edgeBps,
      agoSeconds: ago,
    };
  });
}

/** `2m 14s ago`, `47s ago`, `1h 3m ago`. */
export function agoLabel(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

/** USD with thousands separators and two decimals. */
export function usd(v: number): string {
  return v.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

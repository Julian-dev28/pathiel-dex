/**
 * The perp side of the same assets, read from Hyperliquid.
 *
 * This router quotes stocks on three chains. The same names also trade as
 * perpetuals, and not in Hyperliquid's own perp universe: the equities live in
 * a builder-deployed HIP-3 dex called `xyz`, which the API treats as a separate
 * namespace. A query without a `dex` field returns core crypto only and looks
 * exactly like a chain with no stocks on it.
 *
 * What is read here is public and unauthenticated — mark price, funding, open
 * interest, leverage — so it costs nothing and commits to nothing. Nothing in
 * this module signs, sends or holds anything.
 *
 * Two things to keep in view when showing these numbers next to a spot quote:
 *
 *   1. **A different trust boundary.** A spot quote here is read from pool
 *      state: the pool is the price. A perp mark comes from an oracle run by
 *      the dex's deployer, who also sets the market's parameters. That is a
 *      third party's number, not a chain's, and the interface should say so
 *      rather than presenting both as the same kind of fact.
 *   2. **Funding is hourly.** Hyperliquid quotes a per-hour rate; annualising
 *      it for display means ×24×365, and a basis that looks enormous next to a
 *      spot price is usually a funding rate someone annualised twice.
 */

import { canonical } from './assets';

const INFO_URL = 'https://api.hyperliquid.xyz/info';

/**
 * The HIP-3 dex carrying the equities. It is ~98% of all builder-deployed
 * volume; the other nine list markets and trade almost nothing.
 */
export const STOCK_PERP_DEX = 'xyz';

/**
 * Crypto majors worth carrying alongside the stocks, from Hyperliquid's core
 * universe. Deliberately short: this is a stock product, and a list that grows
 * into every listed coin buries the thing it is for.
 */
export const MAJOR_PERPS = ['BTC', 'ETH', 'SOL', 'AAVE', 'NEAR'] as const;

export type PerpMarket = {
  /** The asset, shared with the spot side: `xyz:NVDA` is `NVDA`. */
  symbol: string;
  /** The HIP-3 dex it trades on, or '' for Hyperliquid's own universe. */
  dex: string;
  /** Oracle mark, in dollars. */
  markUsd: number;
  /** Funding paid per hour, as a fraction. Positive means longs pay shorts. */
  fundingHourly: number;
  openInterestUsd: number;
  dayVolumeUsd: number;
  maxLeverage: number;
};

/** What the info endpoint returns for a universe and its contexts. */
type MetaAndCtxs = [
  { universe: { name: string; maxLeverage: number }[] },
  { markPx?: string; funding?: string; openInterest?: string; dayNtlVlm?: string }[],
];

/**
 * Pair a universe with its contexts. They arrive as two arrays lined up by
 * index rather than as one list of objects, so a market whose context is
 * missing is dropped rather than read from its neighbour.
 */
export function parseMarkets([meta, ctxs]: MetaAndCtxs, dex: string): PerpMarket[] {
  const out: PerpMarket[] = [];
  meta.universe.forEach((m, i) => {
    const ctx = ctxs[i];
    if (!ctx) return;
    const markUsd = Number(ctx.markPx ?? 0);
    if (!markUsd) return;
    out.push({
      // HIP-3 markets carry their dex as a prefix; the asset is what follows.
      symbol: canonical(m.name.includes(':') ? m.name.slice(m.name.indexOf(':') + 1) : m.name),
      dex,
      markUsd,
      fundingHourly: Number(ctx.funding ?? 0),
      openInterestUsd: Number(ctx.openInterest ?? 0) * markUsd,
      dayVolumeUsd: Number(ctx.dayNtlVlm ?? 0),
      maxLeverage: m.maxLeverage,
    });
  });
  return out;
}

async function metaAndCtxs(dex: string): Promise<MetaAndCtxs> {
  const res = await fetch(INFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs', ...(dex ? { dex } : {}) }),
  });
  if (!res.ok) throw new Error(`hyperliquid ${dex || 'core'}: ${res.status}`);
  return (await res.json()) as MetaAndCtxs;
}

/**
 * Every perp market worth showing: the whole `xyz` equity book, plus the
 * handful of core majors above.
 *
 * The two universes are fetched together and returned as one list, stocks
 * first. A caller that wants only one of them filters on `dex`.
 */
export async function fetchPerpMarkets(): Promise<PerpMarket[]> {
  const [stocks, core] = await Promise.all([
    metaAndCtxs(STOCK_PERP_DEX).then((d) => parseMarkets(d, STOCK_PERP_DEX)),
    metaAndCtxs('').then((d) => parseMarkets(d, '')),
  ]);
  const majors = new Set<string>(MAJOR_PERPS);
  return [...stocks, ...core.filter((m) => majors.has(m.symbol))];
}

/** Annualised funding, for display. Hyperliquid's rate is per hour. */
export const annualisedFunding = (m: PerpMarket): number => m.fundingHourly * 24 * 365;

/**
 * The perp's premium over spot, in basis points.
 *
 * Positive means the perp is dearer than the pool — longs are paying up for
 * leverage, and the carry trade is to buy the token and short the perp. The
 * number is only as good as both sides being the same asset, which is what the
 * canonical symbol is for.
 */
export function basisBps(markUsd: number, spotUsd: number): number {
  if (spotUsd <= 0) return 0;
  return ((markUsd - spotUsd) / spotUsd) * 10_000;
}

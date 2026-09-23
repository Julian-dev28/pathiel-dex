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

/**
 * A market as its universe describes it.
 *
 * `szDecimals` is needed to price an order: Hyperliquid rejects a price with
 * more than `6 - szDecimals` decimal places, and it differs per market.
 */
export type UniverseEntry = { name: string; maxLeverage: number; szDecimals: number };

/** What the info endpoint returns for a universe and its contexts. */
type MetaAndCtxs = [
  { universe: UniverseEntry[] },
  { markPx?: string; funding?: string; openInterest?: string; dayNtlVlm?: string }[],
];

/**
 * Pair a universe with its contexts. They arrive as two arrays lined up by
 * index rather than as one list of objects, so a market whose context is
 * missing is dropped rather than read from its neighbour.
 */
export function parseMarkets([meta, ctxs]: MetaAndCtxs, dex: string): PerpMarket[] {
  const out: PerpMarket[] = [];
  if (!Array.isArray(meta?.universe) || !Array.isArray(ctxs)) return out;
  meta.universe.forEach((m, i) => {
    const ctx = ctxs[i];
    if (!ctx || typeof m?.name !== 'string') return;
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
  const body = await res.json();
  // A 200 carrying something other than [meta, contexts] — an error object, an
  // empty body — would otherwise destructure into "is not iterable" from deep
  // inside a page render. The sibling reader in balances.ts guards the same
  // API the same way.
  if (!Array.isArray(body) || !Array.isArray(body[0]?.universe) || !Array.isArray(body[1])) {
    throw new Error(`hyperliquid ${dex || 'core'}: unexpected response shape`);
  }
  return body as MetaAndCtxs;
}

/**
 * Every perp market worth showing: the whole `xyz` equity book, plus the
 * handful of core majors above.
 *
 * The two universes are fetched together and returned as one list, stocks
 * first. A caller that wants only one of them filters on `dex`.
 */
export async function fetchPerpMarkets(): Promise<PerpMarket[]> {
  // Settled, not all: the core universe contributes five majors and the `xyz`
  // book is the product. A failure fetching the decoration should not throw
  // away the equities, and vice versa.
  const [stocks, core] = await Promise.allSettled([
    metaAndCtxs(STOCK_PERP_DEX).then((d) => parseMarkets(d, STOCK_PERP_DEX)),
    metaAndCtxs('').then((d) => parseMarkets(d, '')),
  ]);
  if (stocks.status === 'rejected' && core.status === 'rejected') throw stocks.reason;
  const majors = new Set<string>(MAJOR_PERPS);
  return [
    ...(stocks.status === 'fulfilled' ? stocks.value : []),
    ...(core.status === 'fulfilled' ? core.value.filter((m) => majors.has(m.symbol)) : []),
  ];
}

/**
 * One dex's universe, in the order the exchange indexes it.
 *
 * The position in this list is half of a market's asset id, so the order is
 * not incidental and must not be sorted on the way through.
 */
export async function fetchUniverse(dex: string): Promise<UniverseEntry[]> {
  const [meta] = await metaAndCtxs(dex);
  return meta.universe;
}

/** Annualised funding, for display. Hyperliquid's rate is per hour. */
export const annualisedFunding = (m: PerpMarket): number => m.fundingHourly * 24 * 365;

/**
 * The perp mark against what buying the token actually costs, in basis points.
 *
 * Deliberately not called a basis. A basis compares two mids; the spot side
 * here is an executable price — what a real buy of a stated size returns from
 * the pools, inclusive of the venue's fee and its slippage. Against a 0.30%
 * tier that is thirty basis points of cost sitting inside the comparison,
 * which is larger than the premium being measured and would flip its sign
 * while looking perfectly smooth.
 *
 * So: positive means the perp is dearer than buying the token outright, fees
 * and all — which is the question a trader choosing between the two actually
 * has. It is not a funding-arbitrage basis and must not be presented as one.
 */
export function perpVsBuyBps(markUsd: number, spotBuyUsd: number): number {
  if (spotBuyUsd <= 0) return 0;
  return ((markUsd - spotBuyUsd) / spotBuyUsd) * 10_000;
}

/** A market with the spot side of the same asset on one chain, ready to show. */
export type PerpRow = PerpMarket & {
  /** What one unit costs on the selected chain, or null if it is not listed there. */
  spotBuyUsd: number | null;
  /**
   * Why there is no price, when there is none.
   *
   * `unlisted` means this router has no pool for the asset on this chain.
   * `unavailable` means it has one and the quote did not come back — a cold
   * multicall, a rate limit, a timeout. Collapsing the two into null told a
   * first-time visitor that twenty-two of twenty-three assets were not listed
   * on a chain that trades all of them.
   */
  spotStatus: 'priced' | 'unlisted' | 'unavailable';
  /** Null, not zero, when there is no spot price to compare the mark against. */
  vsSpotBuyBps: number | null;
  fundingAnnual: number;
};

/**
 * The table: stocks first, then the core majors, each block by open interest.
 *
 * `spot` is keyed by canonical symbol and holds only the assets this router
 * lists on the chain being shown. A missing entry stays missing all the way to
 * the screen — an asset with no pool here has no basis, and quoting one against
 * a zero would invent a 10,000bp discount out of an absence.
 */
export function perpRows(
  markets: PerpMarket[],
  spot: Map<string, number>,
  /** Assets this router lists here whose quote failed, as opposed to absent ones. */
  unavailable: Set<string> = new Set(),
): PerpRow[] {
  const stockFirst = (m: PerpMarket) => (m.dex === STOCK_PERP_DEX ? 0 : 1);
  return [...markets]
    .sort((a, b) => stockFirst(a) - stockFirst(b) || b.openInterestUsd - a.openInterestUsd)
    .map((m) => {
      const spotBuyUsd = spot.get(m.symbol) ?? null;
      return {
        ...m,
        spotBuyUsd,
        spotStatus:
          spotBuyUsd !== null ? 'priced' : unavailable.has(m.symbol) ? 'unavailable' : 'unlisted',
        vsSpotBuyBps: spotBuyUsd === null ? null : perpVsBuyBps(m.markUsd, spotBuyUsd),
        fundingAnnual: annualisedFunding(m),
      };
    });
}

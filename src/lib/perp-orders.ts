/**
 * Orders that are still resting, and getting rid of them.
 *
 * A limit order on Hyperliquid is `Gtc`: it sits in the book until it fills or
 * somebody cancels it. This app could place one and then offered no way to take
 * it back — the customer's only recourse was Hyperliquid's own interface, for an
 * order this app had signed. That is not a feature gap, it is an unfinished
 * trade.
 *
 * Two things make cancelling fiddlier than placing:
 *
 *  1. **A cancel needs the asset id, and the exchange reports a coin.** Rather
 *     than guessing how a HIP-3 market names itself in that field, the orders are
 *     read one dex at a time, so the dex is known from the question rather than
 *     parsed out of the answer, and the symbol is resolved inside it.
 *  2. **The response shape is the venue's, not ours.** Every field is read
 *     defensively: an order that cannot be understood well enough to cancel is
 *     dropped rather than shown with a button that would send nonsense.
 */

import type { Address } from 'viem';
import { resolveMarket } from './perp-order';
import { STOCK_PERP_DEX } from './perps';

const INFO_URL = 'https://api.hyperliquid.xyz/info';

/** The dexes this app trades: Hyperliquid's own universe, and the stock dex. */
const DEXES = ['', STOCK_PERP_DEX] as const;

export type OpenOrder = {
  /** '' for Hyperliquid's own universe. */
  dex: string;
  symbol: string;
  /** What a cancel has to name alongside the id. */
  assetId: number;
  oid: number;
  side: 'buy' | 'sell';
  /** Still unfilled. */
  sizeLeft: number;
  origSize: number;
  limitUsd: number;
  placedAt: number;
  reduceOnly: boolean;
};

type RawOrder = {
  coin?: string;
  side?: string;
  limitPx?: string | number;
  sz?: string | number;
  origSz?: string | number;
  oid?: number;
  timestamp?: number;
  reduceOnly?: boolean;
};

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

/**
 * Every resting order this account has, across both dexes.
 *
 * `side` comes back as Hyperliquid's own `A`/`B` — ask and bid — which is sell
 * and buy respectively. Reading it as a word would silently label every order
 * backwards.
 */
export async function openOrders(user: Address): Promise<OpenOrder[]> {
  const perDex = await Promise.all(
    DEXES.map(async (dex) => {
      const res = await fetch(INFO_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'frontendOpenOrders', user, ...(dex ? { dex } : {}) }),
      });
      if (!res.ok) return [];
      const raw = (await res.json()) as RawOrder[];
      if (!Array.isArray(raw)) return [];

      const orders = await Promise.all(
        raw.map(async (o): Promise<OpenOrder | null> => {
          if (typeof o.oid !== 'number' || !o.coin) return null;
          // The coin may or may not carry a dex prefix; the dex is known from
          // the request either way, so anything before a colon is dropped.
          const symbol = o.coin.includes(':') ? o.coin.split(':').pop()! : o.coin;
          const market = await resolveMarket(symbol, dex).catch(() => null);
          if (!market) return null;
          return {
            dex,
            symbol: market.symbol,
            assetId: market.assetId,
            oid: o.oid,
            side: o.side === 'A' ? 'sell' : 'buy',
            sizeLeft: num(o.sz),
            origSize: num(o.origSz ?? o.sz),
            limitUsd: num(o.limitPx),
            placedAt: o.timestamp ?? 0,
            reduceOnly: o.reduceOnly === true,
          };
        }),
      );
      return orders.filter((o): o is OpenOrder => o !== null);
    }),
  );
  return perDex.flat().sort((a, b) => b.placedAt - a.placedAt);
}

/** What a cancel says: which market, which order. */
export const cancelAction = (orders: { assetId: number; oid: number }[]): Record<string, unknown> => ({
  type: 'cancel',
  cancels: orders.map((o) => ({ a: o.assetId, o: o.oid })),
});

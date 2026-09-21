/**
 * Client-side view of /api/quote.
 *
 * The route serialises bigints as decimal strings because JSON cannot carry
 * them. Rather than sprinkling BigInt() across the components, the whole
 * payload is revived once here, so everything downstream works in base units
 * and no display code ever sees a float.
 */

import type { ChainKey, Token } from './chain';
import type { Venue, Rung } from './quote';

export type ApiAllocation = { venue: Venue; amountIn: bigint; amountOut: bigint; share: number };
export type ApiRoute = {
  allocations: ApiAllocation[];
  amountIn: bigint;
  amountOut: bigint;
  gasEstimate: bigint;
};
export type ApiVenue = {
  venue: Venue;
  gasEstimate: bigint;
  amountOutAtFull: bigint;
  multiHop: boolean;
  rungs: Rung[];
};

export type QuoteResponse = {
  tokenIn: Token;
  tokenOut: Token;
  amountIn: bigint;
  blockNumber: bigint;
  quotedAt: number;
  expiresAt: number;
  cached: boolean;
  latencyMs: number;
  gas: {
    gasPriceWei: bigint;
    gasPerExtraHop: bigint;
    hopCostInOutputToken: bigint;
    gasAdjusted: boolean;
  };
  route: {
    single: ApiRoute;
    split: ApiRoute;
    chosen: 'single' | 'split';
    edgeBps: number;
    netEdgeBps: number;
  };
  venues: ApiVenue[];
};

/** Field names whose values are always base-unit integers. */
const BIGINT_KEYS = new Set([
  'amountIn',
  'amountOut',
  'gasEstimate',
  'amountOutAtFull',
  'gasPriceWei',
  'gasPerExtraHop',
  'hopCostInOutputToken',
  'blockNumber',
]);

function revive(v: unknown, key?: string): unknown {
  if (Array.isArray(v)) return v.map((x) => revive(x, key));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x, k)]));
  }
  if (typeof v === 'string' && key && BIGINT_KEYS.has(key) && /^\d+$/.test(v)) return BigInt(v);
  return v;
}

export async function fetchQuote(
  chain: ChainKey,
  inSym: string,
  outSym: string,
  amount: string,
  signal?: AbortSignal,
): Promise<QuoteResponse> {
  const url = `/api/quote?chain=${chain}&in=${encodeURIComponent(inSym)}&out=${encodeURIComponent(outSym)}&amount=${encodeURIComponent(amount)}`;
  const res = await fetch(url, { signal, cache: 'no-store' });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `quote failed (${res.status})`);
  return revive(body) as QuoteResponse;
}

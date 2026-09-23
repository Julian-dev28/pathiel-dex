/**
 * One question, three chains: where should this trade actually happen?
 *
 * The router already answers "what is the best route on this chain". The chain
 * itself was the part the user had to decide, and deciding it well means
 * knowing all three prices and what it costs to get there — which is exactly
 * the work a person cannot do by hand across three block explorers and a
 * bridge.
 *
 * So a chain becomes a route. Holding dollars on Base and wanting NVDA, the
 * candidates are: buy on Base, or cross to Robinhood Chain and buy there, or
 * cross to X Layer and buy there. Each candidate is priced end to end — the
 * crossing and the swap together — and they are ranked by the only thing that
 * matters, how much of the asset ends up in the wallet.
 *
 * Two things this deliberately does not do:
 *
 *   - **It does not net out gas.** Three chains price gas in three different
 *     tokens, two of which are not the dollar being spent. Quoting a total that
 *     silently converted OKB into dollars at a fourth price would be a worse
 *     lie than leaving it out and saying so.
 *   - **It does not execute.** A plan is a comparison. Executing one is a
 *     bridge deposit the user signs and then a swap they sign, and both belong
 *     to the caller.
 */

import { formatUnits, parseUnits, type Address } from 'viem';
import { CHAINS, type ChainKey, type Token } from './chain';
import { quoteLadder, ladder, bestRoute } from './quote';
import { unifiedAssets, listingOn } from './assets';
import { bridgeQuote, type BridgeQuote } from './bridge';

/** One way of ending up holding the asset. */
export type Plan = {
  /** Where the swap would happen. */
  chain: ChainKey;
  /** The crossing this plan needs, or null when the money is already there. */
  bridge: BridgeQuote | null;
  token: Token;
  /** Dollars actually reaching the pool, after any crossing. */
  spendUsd: number;
  /** Units of the asset received. */
  unitsOut: number;
  /** What one unit costs all-in, including the crossing. */
  effectivePriceUsd: number;
  /** The venue the router picked on that chain. */
  venue: string;
  /** Seconds before the position exists; zero when no crossing is needed. */
  etaSeconds: number;
  /** Why this plan could not be priced, when it could not. */
  unavailable?: string;
};

/**
 * Best first, by units received.
 *
 * Units rather than price, because the two only agree when every plan spends
 * the same dollars — and they do not: a crossing takes its cut before the pool
 * sees the money. Units received is what the user ends up holding, so it is
 * what decides.
 *
 * Plans that could not be priced sort last whatever they claim.
 */
export function rankPlans(plans: Plan[]): Plan[] {
  return [...plans].sort((a, b) => {
    if (a.unavailable && b.unavailable) return a.chain.localeCompare(b.chain);
    if (a.unavailable) return 1;
    if (b.unavailable) return -1;
    return b.unitsOut - a.unitsOut;
  });
}

/** How much better the best plan is than the next one, in basis points. */
export function edgeOverNextBps(ranked: Plan[]): number {
  const [best, next] = ranked.filter((p) => !p.unavailable);
  if (!best || !next || next.unitsOut <= 0) return 0;
  return ((best.unitsOut - next.unitsOut) / next.unitsOut) * 10_000;
}

/**
 * Price buying `usdAmount` of an asset from every chain that lists it.
 *
 * `fromChain` is where the money is now. That chain needs no crossing, which is
 * usually worth 10–30bp and is exactly the sort of advantage that is invisible
 * until both sides are priced together.
 */
export async function planBuy(opts: {
  wallet: Address;
  asset: string;
  fromChain: ChainKey;
  usdAmount: number;
}): Promise<Plan[]> {
  const { wallet, asset, fromChain, usdAmount } = opts;
  const found = unifiedAssets().find((a) => a.symbol === asset.toUpperCase());
  if (!found) throw new Error(`no listed asset: ${asset}`);

  const origin = CHAINS[fromChain];
  const plans = await Promise.all(
    found.listings.map(async ({ chain: key }): Promise<Plan | null> => {
      const chain = CHAINS[key];
      const token = listingOn(found, key);
      // The chain's own dollar is not an asset to buy with itself.
      if (!token || token.symbol === chain.usd.symbol) return null;

      const base: Plan = {
        chain: key,
        bridge: null,
        token,
        spendUsd: usdAmount,
        unitsOut: 0,
        effectivePriceUsd: 0,
        venue: '',
        etaSeconds: 0,
      };

      let spendable = parseUnits(String(usdAmount), chain.usd.decimals);

      if (key !== fromChain) {
        const quote = await bridgeQuote(
          wallet,
          origin,
          origin.usd,
          { kind: 'chain', chain, token: chain.usd },
          parseUnits(String(usdAmount), origin.usd.decimals),
        ).catch(() => null);
        if (!quote) return { ...base, unavailable: 'no bridge route' };
        base.bridge = quote;
        base.etaSeconds = quote.etaSeconds;
        base.spendUsd = Number(quote.amountOutFormatted);
        spendable = parseUnits(quote.amountOutFormatted, chain.usd.decimals);
      }

      try {
        const curves = await quoteLadder(chain.usd, token, ladder(spendable, 4));
        if (curves.length === 0) return { ...base, unavailable: 'no pool on this chain' };
        const best = bestRoute(curves, spendable);
        const unitsOut = Number(formatUnits(best.single.amountOut, token.decimals));
        if (unitsOut <= 0) return { ...base, unavailable: 'no liquidity at this size' };
        return {
          ...base,
          unitsOut,
          // All-in: the dollars that left the wallet, not the ones that arrived.
          effectivePriceUsd: usdAmount / unitsOut,
          venue: best.single.allocations[0]?.venue.label ?? '',
        };
      } catch (e) {
        return { ...base, unavailable: e instanceof Error ? e.message : 'quote failed' };
      }
    }),
  );

  return rankPlans(plans.filter((p): p is Plan => p !== null));
}

/**
 * Cross-venue arbitrage.
 *
 * Two venues quoting the same pair rarely agree exactly. When they disagree
 * enough, buying on the cheaper one and selling on the dearer one returns more
 * than it costs — the classic two-legged arb.
 *
 * The interesting part is not *whether* an arb exists but *how big* it should
 * be. Both legs move against you as size grows: the buy leg pays more per unit
 * and the sell leg receives less. Profit is therefore concave in size, rising
 * from zero, peaking, and falling back through zero. The optimum is where the
 * marginal legs cross, and taking "as much as possible" is how a naive
 * searcher turns a real edge into a loss.
 *
 * Because both directions are already quoted as ladders, the search is a sweep
 * over the rungs rather than an on-chain simulation: for each candidate size,
 * push it through the forward curve, push the result back through the reverse
 * curve, and see what returns.
 *
 * A caveat this module states rather than hides: on Base these opportunities
 * are contested by searchers with better latency and are usually closed within
 * a block. A scanner run from a web request will mostly report nothing, and
 * "nothing" is the honest answer rather than a broken feature.
 */

import { interpolate, type VenueCurve, type Venue } from './quote';
import type { Token } from './chain';

export type ArbLeg = { venue: string; venueId: string; hops: number };

export type ArbOpportunity = {
  buy: ArbLeg;
  sell: ArbLeg;
  /** Size of the first leg, in tokenIn base units. */
  size: bigint;
  /** tokenIn returned after both legs. */
  returned: bigint;
  /** returned − size, before gas. Positive means the round trip made money. */
  grossProfit: bigint;
  grossBps: number;
  /** Gas for both legs, priced in tokenIn. */
  gasCost: bigint;
  netProfit: bigint;
  netBps: number;
  profitable: boolean;
};

/**
 * Round-trip a size through a forward curve and back through a reverse curve.
 *
 * Returns 0n when either leg is dry rather than throwing: a curve with no depth
 * at this size is a route that does not exist, not an error.
 */
function roundTrip(forward: VenueCurve, reverse: VenueCurve, size: bigint): bigint {
  const mid = interpolate(forward, size);
  if (mid <= 0n) return 0n;
  return interpolate(reverse, mid);
}

/**
 * Sizes to test.
 *
 * The forward ladder's rungs, plus midpoints between them. The optimum is
 * usually not on a rung, and a geometric ladder is coarse enough near the peak
 * that landing on the wrong side of it materially changes the answer.
 */
function candidateSizes(forward: VenueCurve): bigint[] {
  const rungs = forward.rungs.map((r) => r.amountIn).filter((s) => s > 0n);
  const out: bigint[] = [];
  for (let i = 0; i < rungs.length; i++) {
    out.push(rungs[i]);
    if (i + 1 < rungs.length) out.push((rungs[i] + rungs[i + 1]) / 2n);
  }
  return [...new Set(out)].sort((a, b) => (a < b ? -1 : 1));
}

/**
 * Find the best two-venue round trip.
 *
 * `forwardCurves` quote tokenIn→tokenOut and `reverseCurves` quote
 * tokenOut→tokenIn. A venue is allowed to appear on both legs only if it is a
 * *different* venue — buying and selling in the same pool is a fee payment, not
 * an arb, and it always loses.
 *
 * `gasCostInTokenIn` is the cost of both legs expressed in the input token, so
 * the caller supplies it: only the caller knows the gas price and the input
 * token's price in ETH.
 */
export function findArb(
  forwardCurves: VenueCurve[],
  reverseCurves: VenueCurve[],
  gasCostInTokenIn: bigint,
): ArbOpportunity | null {
  let best: ArbOpportunity | null = null;

  for (const forward of forwardCurves) {
    for (const reverse of reverseCurves) {
      // Same pool both ways is a guaranteed loss of two fees.
      if (samePool(forward.venue, reverse.venue)) continue;

      for (const size of candidateSizes(forward)) {
        const returned = roundTrip(forward, reverse, size);
        if (returned <= 0n) continue;

        const grossProfit = returned - size;
        // Only positive round trips are candidates; a negative one is just a
        // pair of trades in the wrong direction.
        if (grossProfit <= 0n) continue;

        const netProfit = grossProfit - gasCostInTokenIn;
        const grossBps = Number((grossProfit * 10_000n) / size);
        const netBps = Number((netProfit * 10_000n) / size);

        if (best === null || netProfit > best.netProfit) {
          best = {
            buy: leg(forward.venue),
            sell: leg(reverse.venue),
            size,
            returned,
            grossProfit,
            grossBps,
            gasCost: gasCostInTokenIn,
            netProfit,
            netBps,
            profitable: netProfit > 0n,
          };
        }
      }
    }
  }

  return best;
}

const leg = (v: Venue): ArbLeg => ({ venue: v.label, venueId: v.id, hops: v.hops.length });

/** True when both routes touch exactly the same single pool. */
function samePool(a: Venue, b: Venue): boolean {
  if (a.id === b.id) return true;
  if (a.hops.length !== 1 || b.hops.length !== 1) return false;
  const ha = a.hops[0];
  const hb = b.hops[0];
  if (ha.family === 'v3' || hb.family === 'v3') {
    // V3 hops carry no address, so identity is (deployment, fee tier).
    return (
      ha.family === 'v3' &&
      hb.family === 'v3' &&
      ha.fee === hb.fee &&
      ha.dex === hb.dex
    );
  }
  if (ha.family === 'v4' || hb.family === 'v4') {
    // V4 pools are named by their key, not an address.
    return ha.family === 'v4' && hb.family === 'v4' && JSON.stringify(ha.key) === JSON.stringify(hb.key);
  }
  return ha.pool.toLowerCase() === hb.pool.toLowerCase();
}

/**
 * Largest trade whose price impact stays within `maxImpactBps`.
 *
 * "How much can this pair absorb" is the question a desk asks before it asks
 * anything else, and no interface answers it. Binary search over the curve,
 * measuring impact against the smallest rung — the closest thing to a mid price
 * available from the same pool at the same block.
 */
export type Capacity = {
  size: bigint;
  /** True when the whole ladder fits the budget, so this is a lower bound. */
  atLeast: boolean;
};

export function capacity(curve: VenueCurve, maxImpactBps: number): bigint {
  const rungs = curve.rungs;
  if (rungs.length < 2) return 0n;

  const first = rungs[0];
  if (first.amountIn === 0n || first.amountOut === 0n) return 0n;

  // Cross-multiplied rather than computing each rate and comparing them.
  //
  // The obvious form divides amountOut by amountIn first, and on an 18-decimal
  // input against a 6-decimal output that quotient truncates to zero before it
  // is ever compared — every budget then reports a capacity of nothing.
  // Comparing
  //
  //     out / size   against   firstOut / firstIn
  //
  // by cross-multiplication keeps the whole thing in integers:
  //
  //     impact = (size * firstOut - out * firstIn) / (size * firstOut)
  const impactAt = (size: bigint): number => {
    const out = interpolate(curve, size);
    if (out <= 0n || size <= 0n) return Number.POSITIVE_INFINITY;
    const denominator = size * first.amountOut;
    if (denominator === 0n) return Number.POSITIVE_INFINITY;
    const numerator = denominator - out * first.amountIn;
    return Number((numerator * 10_000n) / denominator);
  };

  const top = rungs[rungs.length - 1].amountIn;
  // The whole ladder fits the budget, so the true capacity is somewhere above
  // it and this is a lower bound. Callers that care use `capacityOf`.
  if (impactAt(top) <= maxImpactBps) return top;

  let lo = first.amountIn;
  let hi = top;
  if (impactAt(lo) > maxImpactBps) return 0n;

  // 40 halvings is far past the precision the ladder itself carries.
  for (let i = 0; i < 40 && hi - lo > 1n; i++) {
    const mid = (lo + hi) / 2n;
    if (impactAt(mid) <= maxImpactBps) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * How much of the optimal execution happens away from the single best venue.
 *
 * Zero means one pool is the whole market and a router earns nothing here. High
 * values mean liquidity is scattered and routing is the product. It is the
 * number that says whether this project is worth running on a given pair, which
 * is worth publishing precisely because it is sometimes unflattering.
 */
/** `capacity`, plus whether the answer was bounded by the ladder's own top. */
export function capacityOf(curve: VenueCurve, maxImpactBps: number): Capacity {
  const size = capacity(curve, maxImpactBps);
  const top = curve.rungs.length ? curve.rungs[curve.rungs.length - 1].amountIn : 0n;
  return { size, atLeast: size > 0n && size >= top };
}

export function fragmentation(
  allocations: { venue: Venue; amountIn: bigint }[],
  bestSingleVenueId: string,
  totalIn: bigint,
): number {
  if (totalIn <= 0n || allocations.length === 0) return 0;
  const away = allocations
    .filter((a) => a.venue.id !== bestSingleVenueId)
    .reduce((sum, a) => sum + a.amountIn, 0n);
  return Number((away * 10_000n) / totalIn) / 100;
}

export const tokenLabel = (t: Token) => t.symbol;

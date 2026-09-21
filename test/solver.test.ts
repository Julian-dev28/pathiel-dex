/**
 * Unit tests for the routing maths.
 *
 * These deliberately use no network. The fork tests in `contracts/` prove the
 * quoter agrees with the chain; these prove the parts that are pure arithmetic
 * behave at the edges the chain rarely visits — empty pools, one-wei trades,
 * ladders that collapse, curves that are flat. Those are where a router either
 * returns nonsense or divides by zero, and both are much easier to catch here
 * than against a live pool.
 */

import { describe, it, expect } from 'vitest';
import {
  v2AmountOut,
  v2ChainOut,
  ladder,
  interpolate,
  splitRoute,
  bestRoute,
  encodeV3Path,
  type VenueCurve,
  type Venue,
  type V2State,
} from '@/lib/quote';
import { minOut } from '@/lib/execute';
import { capacity, fragmentation } from '@/lib/arb';
import { exposureAt, recommendSlippage } from '@/lib/exposure';
import { toBase, fromBase } from '@/lib/format';
import { CHAIN_LIST, bySymbol } from '@/lib/chain';

// The routing maths is chain-independent; Base's tokens are used for its units.
const WETH = bySymbol('WETH', 'base');
const USDC = bySymbol('USDC', 'base');

const venue = (id: string): Venue => ({
  id,
  label: id,
  family: 'v3',
  path: [WETH, USDC],
  hops: [{ family: 'v3', fee: 500, dex: 0 }],
});

/** A synthetic constant-product curve, so expectations are exact. */
function cpCurve(id: string, reserveIn: bigint, reserveOut: bigint, sizes: bigint[]): VenueCurve {
  const s: V2State = { reserveIn, reserveOut, feeBps: 30 };
  return {
    venue: venue(id),
    rungs: sizes.map((amountIn) => ({ amountIn, amountOut: v2AmountOut(amountIn, s) })),
    gasEstimate: 100_000n,
  };
}

describe('v2AmountOut', () => {
  const pool: V2State = { reserveIn: 1_000n * 10n ** 18n, reserveOut: 2_000_000n * 10n ** 6n, feeBps: 30 };

  it('matches the constant-product formula exactly', () => {
    const amountIn = 10n ** 18n;
    const inAfterFee = amountIn * 9970n;
    const expected = (inAfterFee * pool.reserveOut) / (pool.reserveIn * 10_000n + inAfterFee);
    expect(v2AmountOut(amountIn, pool)).toBe(expected);
  });

  it('charges each fork its own fee', () => {
    const amountIn = 10n ** 18n;
    const at30 = v2AmountOut(amountIn, { ...pool, feeBps: 30 });
    const at25 = v2AmountOut(amountIn, { ...pool, feeBps: 25 });
    // BaseSwap's 25bp must return more than Uniswap's 30bp on the same reserves.
    expect(at25).toBeGreaterThan(at30);
    // And the gap should be roughly 5bp of the output, not some other magnitude.
    const gapBps = Number(((at25 - at30) * 10_000n) / at30);
    expect(gapBps).toBeGreaterThanOrEqual(4);
    expect(gapBps).toBeLessThanOrEqual(6);
  });

  it('never returns more than the pool holds', () => {
    const huge = 10n ** 30n;
    expect(v2AmountOut(huge, pool)).toBeLessThan(pool.reserveOut);
  });

  it('returns zero rather than dividing by zero on an empty pool', () => {
    expect(v2AmountOut(10n ** 18n, { reserveIn: 0n, reserveOut: 0n, feeBps: 30 })).toBe(0n);
    expect(v2AmountOut(10n ** 18n, { ...pool, reserveOut: 0n })).toBe(0n);
    expect(v2AmountOut(0n, pool)).toBe(0n);
    expect(v2AmountOut(-1n, pool)).toBe(0n);
  });

  it('is monotone in size', () => {
    let prev = 0n;
    for (let i = 1n; i < 20n; i++) {
      const out = v2AmountOut(i * 10n ** 17n, pool);
      expect(out).toBeGreaterThan(prev);
      prev = out;
    }
  });

  it('is concave: the second unit buys less than the first', () => {
    const one = v2AmountOut(10n ** 18n, pool);
    const two = v2AmountOut(2n * 10n ** 18n, pool);
    expect(two - one).toBeLessThan(one);
  });
});

describe('v2ChainOut', () => {
  const a: V2State = { reserveIn: 1_000n * 10n ** 18n, reserveOut: 2_000_000n * 10n ** 6n, feeBps: 30 };
  const b: V2State = { reserveIn: 5_000_000n * 10n ** 6n, reserveOut: 5_000_000n * 10n ** 18n, feeBps: 30 };

  it('applies the formula once per hop', () => {
    const amountIn = 10n ** 18n;
    expect(v2ChainOut(amountIn, [a, b])).toBe(v2AmountOut(v2AmountOut(amountIn, a), b));
  });

  it('a single-hop chain equals the single-hop formula', () => {
    expect(v2ChainOut(10n ** 18n, [a])).toBe(v2AmountOut(10n ** 18n, a));
  });

  it('propagates a dead hop as zero rather than throwing', () => {
    const dead: V2State = { reserveIn: 0n, reserveOut: 0n, feeBps: 30 };
    expect(v2ChainOut(10n ** 18n, [a, dead])).toBe(0n);
    expect(v2ChainOut(10n ** 18n, [dead, a])).toBe(0n);
  });

  it('loses more to fees than a direct route would', () => {
    // Two hops pay the fee twice; this is why multi-hop only wins when the
    // direct pool is thin enough for impact to dominate the extra fee.
    const twoHop = v2ChainOut(10n ** 18n, [a, a]);
    const oneHop = v2AmountOut(10n ** 18n, a);
    expect(twoHop).toBeLessThan(oneHop);
  });
});

describe('ladder', () => {
  it('ends at the requested amount', () => {
    const l = ladder(1024n);
    expect(l[l.length - 1]).toBe(1024n);
  });

  it('is strictly increasing', () => {
    const l = ladder(10n ** 18n);
    for (let i = 1; i < l.length; i++) expect(l[i]).toBeGreaterThan(l[i - 1]);
  });

  it('halves downward from the top', () => {
    const l = ladder(1024n, 4);
    expect(l).toEqual([128n, 256n, 512n, 1024n]);
  });

  it('collapses without duplicates when the amount is tiny', () => {
    // 3 wei over 12 rungs would produce a run of zeros and repeated ones.
    const l = ladder(3n);
    expect(l).toEqual([...new Set(l)]);
    expect(l.every((v) => v > 0n)).toBe(true);
    expect(l[l.length - 1]).toBe(3n);
  });

  it('returns nothing for a zero trade', () => {
    expect(ladder(0n)).toEqual([]);
  });
});

describe('interpolate', () => {
  const sizes = ladder(10n ** 18n);
  const curve = cpCurve('a', 1_000n * 10n ** 18n, 2_000_000n * 10n ** 6n, sizes);

  it('reproduces sampled points exactly', () => {
    for (const r of curve.rungs) {
      expect(interpolate(curve, r.amountIn)).toBe(r.amountOut);
    }
  });

  it('underestimates between samples, never over', () => {
    // Piecewise-linear on a concave curve is a lower bound. That direction is
    // load-bearing: the splitter must never believe a venue is deeper than it is.
    const s: V2State = { reserveIn: 1_000n * 10n ** 18n, reserveOut: 2_000_000n * 10n ** 6n, feeBps: 30 };
    for (let i = 1; i < curve.rungs.length; i++) {
      const mid = (curve.rungs[i - 1].amountIn + curve.rungs[i].amountIn) / 2n;
      expect(interpolate(curve, mid)).toBeLessThanOrEqual(v2AmountOut(mid, s));
    }
  });

  it('scales linearly below the smallest rung', () => {
    const first = curve.rungs[0];
    expect(interpolate(curve, first.amountIn / 2n)).toBe(first.amountOut / 2n);
  });

  it('handles zero, negative and empty input', () => {
    expect(interpolate(curve, 0n)).toBe(0n);
    expect(interpolate(curve, -5n)).toBe(0n);
    expect(interpolate({ ...curve, rungs: [] }, 10n)).toBe(0n);
  });

  it('extrapolates above the top rung without going backwards', () => {
    const top = curve.rungs[curve.rungs.length - 1];
    expect(interpolate(curve, top.amountIn * 2n)).toBeGreaterThanOrEqual(top.amountOut);
  });
});

describe('splitRoute', () => {
  const sizes = ladder(100n * 10n ** 18n);

  it('allocates the entire input', () => {
    const curves = [
      cpCurve('deep', 10_000n * 10n ** 18n, 20_000_000n * 10n ** 6n, sizes),
      cpCurve('thin', 100n * 10n ** 18n, 200_000n * 10n ** 6n, sizes),
    ];
    const amountIn = 100n * 10n ** 18n;
    const r = splitRoute(curves, amountIn);
    const allocated = r.allocations.reduce((a, x) => a + x.amountIn, 0n);
    expect(allocated).toBe(amountIn);
  });

  it('gives the deeper pool the larger share', () => {
    const curves = [
      cpCurve('deep', 10_000n * 10n ** 18n, 20_000_000n * 10n ** 6n, sizes),
      cpCurve('thin', 100n * 10n ** 18n, 200_000n * 10n ** 6n, sizes),
    ];
    const r = splitRoute(curves, 100n * 10n ** 18n);
    const deep = r.allocations.find((a) => a.venue.id === 'deep')!;
    const thin = r.allocations.find((a) => a.venue.id === 'thin');
    expect(deep.amountIn).toBeGreaterThan(thin?.amountIn ?? 0n);
  });

  it('beats any single venue when two pools are equally deep', () => {
    // Two identical pools: splitting halves the impact on each, so the total
    // must exceed routing everything through one of them.
    const curves = [
      cpCurve('a', 500n * 10n ** 18n, 1_000_000n * 10n ** 6n, sizes),
      cpCurve('b', 500n * 10n ** 18n, 1_000_000n * 10n ** 6n, sizes),
    ];
    const amountIn = 100n * 10n ** 18n;
    const split = splitRoute(curves, amountIn);
    expect(split.amountOut).toBeGreaterThan(interpolate(curves[0], amountIn));
  });

  it('routes everything to one venue when only one exists', () => {
    const curves = [cpCurve('only', 1_000n * 10n ** 18n, 2_000_000n * 10n ** 6n, sizes)];
    const r = splitRoute(curves, 10n * 10n ** 18n);
    expect(r.allocations).toHaveLength(1);
    expect(r.allocations[0].share).toBe(100);
  });

  it('returns an empty route rather than throwing on no venues', () => {
    const r = splitRoute([], 10n ** 18n);
    expect(r.allocations).toEqual([]);
    expect(r.amountOut).toBe(0n);
  });

  it('handles a zero-size trade', () => {
    const curves = [cpCurve('a', 1_000n * 10n ** 18n, 2_000_000n * 10n ** 6n, sizes)];
    expect(splitRoute(curves, 0n).amountOut).toBe(0n);
  });

  it('shares sum to about 100 percent', () => {
    const curves = [
      cpCurve('a', 500n * 10n ** 18n, 1_000_000n * 10n ** 6n, sizes),
      cpCurve('b', 400n * 10n ** 18n, 800_000n * 10n ** 6n, sizes),
      cpCurve('c', 100n * 10n ** 18n, 200_000n * 10n ** 6n, sizes),
    ];
    const r = splitRoute(curves, 100n * 10n ** 18n);
    const total = r.allocations.reduce((a, x) => a + x.share, 0);
    expect(total).toBeGreaterThan(99.5);
    expect(total).toBeLessThanOrEqual(100.5);
  });
});

describe('bestRoute', () => {
  const sizes = ladder(100n * 10n ** 18n);
  const amountIn = 100n * 10n ** 18n;

  it('picks a single venue when the split gains nothing', () => {
    const curves = [cpCurve('only', 10_000n * 10n ** 18n, 20_000_000n * 10n ** 6n, sizes)];
    const r = bestRoute(curves, amountIn);
    expect(r.chosen).toBe('single');
    expect(r.single.allocations).toHaveLength(1);
  });

  it('picks the split when two equal pools make it clearly worth it', () => {
    const curves = [
      cpCurve('a', 200n * 10n ** 18n, 400_000n * 10n ** 6n, sizes),
      cpCurve('b', 200n * 10n ** 18n, 400_000n * 10n ** 6n, sizes),
    ];
    const r = bestRoute(curves, amountIn);
    expect(r.chosen).toBe('split');
    expect(r.edgeBps).toBeGreaterThan(1);
  });

  it('refuses a split whose gain is smaller than the gas it costs', () => {
    const curves = [
      cpCurve('a', 200n * 10n ** 18n, 400_000n * 10n ** 6n, sizes),
      cpCurve('b', 200n * 10n ** 18n, 400_000n * 10n ** 6n, sizes),
    ];
    const free = bestRoute(curves, amountIn, 0n);
    // Charge an absurd amount of gas per extra hop and the same split must
    // stop being recommended. This is the check that stops the router from
    // flattering itself with a gain the user never sees.
    const expensive = bestRoute(curves, amountIn, free.split.amountOut);
    expect(free.chosen).toBe('split');
    expect(expensive.chosen).toBe('single');
    expect(expensive.netEdgeBps).toBeLessThan(free.netEdgeBps);
  });

  it('reports a zero edge rather than dividing by zero when nothing quotes', () => {
    const r = bestRoute([], amountIn);
    expect(r.edgeBps).toBe(0);
    expect(r.netEdgeBps).toBe(0);
    expect(r.single.amountOut).toBe(0n);
  });
});

describe('minOut', () => {
  it('applies slippage in basis points', () => {
    expect(minOut(10_000n, 50)).toBe(9_950n);
    expect(minOut(10_000n, 100)).toBe(9_900n);
  });

  it('returns the quote unchanged at zero slippage', () => {
    expect(minOut(12_345n, 0)).toBe(12_345n);
  });

  it('floors rather than rounds, so the guard is never above the quote', () => {
    expect(minOut(3n, 50)).toBeLessThanOrEqual(3n);
  });

  it('clamps absurd tolerances instead of going negative', () => {
    expect(minOut(10_000n, 99_999)).toBeGreaterThanOrEqual(0n);
    expect(minOut(10_000n, -50)).toBe(10_000n);
  });
});

describe('encodeV3Path', () => {
  it('packs a single hop as token,fee,token', () => {
    const path = encodeV3Path([WETH, USDC], [500]);
    // 20 + 3 + 20 bytes = 43 bytes = 86 hex chars after 0x
    expect(path.length).toBe(2 + 86);
    expect(path.toLowerCase()).toContain(WETH.address.slice(2).toLowerCase());
    expect(path.toLowerCase()).toContain(USDC.address.slice(2).toLowerCase());
    expect(path.toLowerCase()).toContain('0001f4'); // 500 as uint24
  });

  it('packs two hops as token,fee,token,fee,token', () => {
    const DAI = bySymbol('DAI', 'base');
    const path = encodeV3Path([WETH, USDC, DAI], [500, 100]);
    // 20 + 3 + 20 + 3 + 20 = 66 bytes = 132 hex chars
    expect(path.length).toBe(2 + 132);
    expect(path.toLowerCase()).toContain('000064'); // 100 as uint24
  });
});

describe('token table', () => {
  it.each(CHAIN_LIST.map((c) => [c.name, c] as const))('%s has no duplicate symbols or addresses', (_, chain) => {
    const symbols = chain.tokens.map((t) => t.symbol);
    const addresses = chain.tokens.map((t) => t.address.toLowerCase());
    expect(new Set(symbols).size).toBe(symbols.length);
    expect(new Set(addresses).size).toBe(addresses.length);
    expect(chain.tokens.every((t) => t.chainId === chain.id)).toBe(true);
  });

  it('rejects an unknown symbol loudly', () => {
    expect(() => bySymbol('NOTATOKEN')).toThrow(/unknown token/);
  });

  it('resolves a symbol on the chain asked for, Robinhood Chain by default', () => {
    expect(bySymbol('WETH').chainId).toBe(4663);
    expect(bySymbol('WETH', 'base').chainId).toBe(8453);
    expect(() => bySymbol('USDC')).toThrow(/Robinhood Chain/);
  });

  it('looks tokens up case-insensitively', () => {
    expect(bySymbol('weth', 'base').address).toBe(WETH.address);
  });
});

describe('amount parsing', () => {
  it('accepts what formatUnits produces, including dust', () => {
    // The MAX button fills the input with fromBase(balance). If toBase cannot
    // read that back, MAX silently stops the quote — which is exactly what
    // happened when MAX used the display formatter and it emitted "1.5e-7".
    for (const raw of [1n, 12n, 10n ** 6n, 10n ** 18n, 123456789012345678n]) {
      const text = fromBase(raw, WETH);
      expect(text).not.toMatch(/e/i);
      expect(toBase(text, WETH)).toBe(raw);
    }
  });

  it('rejects junk rather than guessing', () => {
    expect(toBase('', WETH)).toBe(0n);
    expect(toBase('abc', WETH)).toBe(0n);
    expect(toBase('1.2.3', WETH)).toBe(0n);
    expect(toBase('1e18', WETH)).toBe(0n);
  });

  it('ignores thousands separators', () => {
    expect(toBase('1,000', USDC)).toBe(1_000_000_000n);
  });
});

describe('capacity', () => {
  const sizes = ladder(100n * 10n ** 18n);

  // 18-decimal in, 6-decimal out: the shape that broke the first implementation,
  // where dividing amountOut by amountIn truncated to zero and every budget
  // reported a capacity of nothing.
  const curve: VenueCurve = (() => {
    const s: V2State = {
      reserveIn: 5_000n * 10n ** 18n,
      reserveOut: 12_000_000n * 10n ** 6n,
      feeBps: 30,
    };
    return {
      venue: venue('deep'),
      rungs: sizes.map((amountIn) => ({ amountIn, amountOut: v2AmountOut(amountIn, s) })),
      gasEstimate: 100_000n,
    };
  })();

  it('returns a non-zero size across a decimal mismatch', () => {
    expect(capacity(curve, 50)).toBeGreaterThan(0n);
  });

  it('is monotone in the impact budget', () => {
    expect(capacity(curve, 100)).toBeGreaterThanOrEqual(capacity(curve, 10));
  });

  it('never exceeds the top of the ladder', () => {
    const top = curve.rungs[curve.rungs.length - 1].amountIn;
    expect(capacity(curve, 10_000)).toBeLessThanOrEqual(top);
  });

  it('the size it returns really is within budget', () => {
    for (const budget of [10, 50, 100]) {
      const size = capacity(curve, budget);
      if (size === 0n) continue;
      const first = curve.rungs[0];
      const out = interpolate(curve, size);
      const denominator = size * first.amountOut;
      const impact = Number(((denominator - out * first.amountIn) * 10_000n) / denominator);
      // One basis point of slack for the search landing on a boundary.
      expect(impact).toBeLessThanOrEqual(budget + 1);
    }
  });

  it('is zero for a curve with too few rungs to measure', () => {
    expect(capacity({ ...curve, rungs: [] }, 50)).toBe(0n);
    expect(capacity({ ...curve, rungs: [curve.rungs[0]] }, 50)).toBe(0n);
  });
});

describe('fragmentation', () => {
  it('is zero when everything routes to the best venue', () => {
    expect(fragmentation([{ venue: venue('a'), amountIn: 100n }], 'a', 100n)).toBe(0);
  });

  it('is the share going elsewhere', () => {
    const allocs = [
      { venue: venue('a'), amountIn: 70n },
      { venue: venue('b'), amountIn: 30n },
    ];
    expect(fragmentation(allocs, 'a', 100n)).toBeCloseTo(30);
  });

  it('handles an empty split without dividing by zero', () => {
    expect(fragmentation([], 'a', 100n)).toBe(0);
    expect(fragmentation([{ venue: venue('a'), amountIn: 1n }], 'a', 0n)).toBe(0);
  });
});

describe('exposure', () => {
  it('is exactly the gap the user authorised', () => {
    const e = exposureAt(1_000_000n, 50);
    expect(e.floor).toBe(995_000n);
    expect(e.exposure).toBe(5_000n);
    expect(e.exposureBps).toBe(50);
  });

  it('is zero at zero slippage', () => {
    expect(exposureAt(1_000_000n, 0).exposure).toBe(0n);
  });

  it('grows with the tolerance', () => {
    expect(exposureAt(1_000_000n, 100).exposure).toBeGreaterThan(
      exposureAt(1_000_000n, 10).exposure,
    );
  });

  it('handles a zero quote without dividing by zero', () => {
    const e = exposureAt(0n, 50);
    expect(e.exposure).toBe(0n);
    expect(e.exposureBps).toBe(0);
  });
});

describe('recommendSlippage', () => {
  const drift = (p95: number, observations = 400) => ({
    pool: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    observations,
    fromBlock: '1',
    toBlock: '2',
    p50: p95 / 4,
    p95,
    p99: p95 * 1.4,
    max: p95 * 2,
  });

  it('doubles measured drift when the sample is large', () => {
    expect(recommendSlippage(drift(20, 400)).recommendedBps).toBe(40);
    expect(recommendSlippage(drift(20, 400)).confidence).toBe('high');
  });

  it('widens the multiplier when the sample is only moderate', () => {
    // Same drift, less evidence, so more headroom.
    expect(recommendSlippage(drift(20, 100)).recommendedBps).toBe(60);
    expect(recommendSlippage(drift(20, 100)).confidence).toBe('medium');
  });

  it('refuses to tighten below the default on a thin sample', () => {
    // The feature exists to reduce risk. On the pairs it understands least it
    // must not increase it, however calm the handful of observations looked.
    const r = recommendSlippage(drift(0.01, 23));
    expect(r.confidence).toBe('low');
    expect(r.recommendedBps).toBe(50);
    expect(r.savedVsDefaultBps).toBe(0);
    expect(r.reason).toMatch(/too thin/);
  });

  it('floors at 5bp so ordinary noise does not revert the trade', () => {
    expect(recommendSlippage(drift(0.1, 400)).recommendedBps).toBe(5);
  });

  it('caps at 200bp rather than recommending something absurd', () => {
    expect(recommendSlippage(drift(500, 400)).recommendedBps).toBe(200);
  });

  it('falls back to the conservative default when drift is unmeasurable', () => {
    const r = recommendSlippage(null);
    expect(r.recommendedBps).toBe(50);
    expect(r.savedVsDefaultBps).toBe(0);
    expect(r.confidence).toBe('low');
    expect(r.reason).toMatch(/not enough/);
  });

  it('reports what tightening from the wallet default saves', () => {
    // p95 2.5bp on a large sample doubles to 5bp, saving 45bp of exposure.
    expect(recommendSlippage(drift(2.5, 400)).savedVsDefaultBps).toBe(45);
  });

  it('never recommends more exposure than the wallet default', () => {
    for (const [p95, n] of [[0.01, 23], [4, 400], [50, 100], [500, 400]] as [number, number][]) {
      expect(recommendSlippage(drift(p95, n)).recommendedBps).toBeLessThanOrEqual(200);
    }
  });
});

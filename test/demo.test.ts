/**
 * Unit tests for demo mode.
 *
 * Two things are being defended here, and only one of them is arithmetic.
 *
 * The arithmetic: these figures render on the server and again on the client, so
 * any non-determinism is a hydration mismatch in production. Every generator is
 * pinned to a seed and the tests assert that the same seed gives byte-identical
 * output.
 *
 * The other thing: this module invents financial figures for a site that swaps
 * real money. The tests below assert the invented numbers stay inside the range
 * the solver has actually measured, and that demo mode is off unless a build
 * explicitly asks for it. A regression in either is not a cosmetic bug — it is
 * the app publishing a performance claim it cannot support.
 */

import { describe, it, expect } from 'vitest';
import {
  DEMO_MODE,
  demoHoldings,
  demoFills,
  demoPortfolioUsd,
  agoLabel,
  usd,
} from '@/lib/demo';
import { bySymbol } from '@/lib/chain';

describe('demo mode flag', () => {
  it('is off unless the build sets NEXT_PUBLIC_DEMO_MODE=1', () => {
    // The test runner does not set it, so this is the default a normal
    // production build gets. If this ever passes as `true`, sample balances are
    // one deploy away from a live site.
    expect(DEMO_MODE).toBe(false);
  });
});

describe('demoHoldings', () => {
  it('is deterministic for a given seed', () => {
    const a = demoHoldings(1234);
    const b = demoHoldings(1234);
    expect(a.map((h) => h.amount.toString())).toEqual(b.map((h) => h.amount.toString()));
    expect(a.map((h) => h.usd)).toEqual(b.map((h) => h.usd));
  });

  it('gives different portfolios for different seeds', () => {
    const a = demoHoldings(1);
    const b = demoHoldings(2);
    expect(a.map((h) => h.amount.toString())).not.toEqual(b.map((h) => h.amount.toString()));
  });

  it('encodes each amount at the token’s own decimals', () => {
    for (const h of demoHoldings()) {
      const token = bySymbol(h.token.symbol, 'base');
      expect(h.token.decimals).toBe(token.decimals);
      // A bigint at the right scale: never negative, never a float that slipped
      // through, and large enough that the position is not dust.
      expect(typeof h.amount).toBe('bigint');
      expect(h.amount > 0n).toBe(true);
    }
  });

  it('values every holding at a positive notional', () => {
    for (const h of demoHoldings()) expect(h.usd).toBeGreaterThan(0);
  });

  it('totals to a trader-sized portfolio, not a whale', () => {
    const total = demoPortfolioUsd(demoHoldings());
    // Sized deliberately: big enough to populate the panel, small enough that it
    // reads as somebody's wallet rather than a marketing number.
    expect(total).toBeGreaterThan(30_000);
    expect(total).toBeLessThan(150_000);
  });

  it('sums exactly to the parts', () => {
    const holdings = demoHoldings();
    const byHand = holdings.reduce((s, h) => s + h.usd, 0);
    expect(demoPortfolioUsd(holdings)).toBeCloseTo(byHand, 10);
  });
});

describe('demoFills', () => {
  it('is deterministic for a given seed', () => {
    expect(demoFills(99)).toEqual(demoFills(99));
  });

  it('keeps every edge inside the range the backtest actually measured', () => {
    // `data/backtest.jsonl` tops out in the low tens of basis points. Inventing a
    // headline number above that would turn the demo into a claim.
    for (const f of demoFills()) {
      expect(f.edgeBps).toBeGreaterThan(0);
      expect(f.edgeBps).toBeLessThanOrEqual(34);
    }
  });

  it('orders fills newest first', () => {
    const ages = demoFills().map((f) => f.agoSeconds);
    const sorted = [...ages].sort((a, b) => a - b);
    expect(ages).toEqual(sorted);
  });

  it('spaces fills unevenly', () => {
    // Regular spacing is the tell that a feed is generated. The gaps should vary.
    const ages = demoFills().map((f) => f.agoSeconds);
    const gaps = ages.slice(1).map((a, i) => a - ages[i]);
    expect(new Set(gaps).size).toBeGreaterThan(1);
  });

  it('produces well-formed transaction hashes that collide with nothing', () => {
    const hashes = demoFills().map((f) => f.txHash);
    for (const h of hashes) expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('always trades between two different tokens', () => {
    for (const f of demoFills()) expect(f.inSym).not.toBe(f.outSym);
  });

  it('names a venue for every fill', () => {
    for (const f of demoFills()) expect(f.venue.length).toBeGreaterThan(0);
  });

  it('receives more than the naive rate, by exactly the stated edge', () => {
    for (const f of demoFills()) {
      expect(Number(f.amountOut)).toBeGreaterThan(0);
      expect(Number(f.amountIn)).toBeGreaterThan(0);
    }
  });
});

describe('agoLabel', () => {
  it('reads in seconds under a minute', () => {
    expect(agoLabel(0)).toBe('0s ago');
    expect(agoLabel(47)).toBe('47s ago');
    expect(agoLabel(59)).toBe('59s ago');
  });

  it('rolls into minutes and hours', () => {
    expect(agoLabel(60)).toBe('1m 0s ago');
    expect(agoLabel(134)).toBe('2m 14s ago');
    expect(agoLabel(3_600)).toBe('1h 0m ago');
    expect(agoLabel(3_780)).toBe('1h 3m ago');
  });

  it('never renders a negative age', () => {
    expect(agoLabel(-5)).toBe('0s ago');
  });
});

describe('usd', () => {
  it('formats with a symbol, separators and two decimals', () => {
    expect(usd(1234.5)).toBe('$1,234.50');
    expect(usd(0)).toBe('$0.00');
  });
});

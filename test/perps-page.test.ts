/**
 * Unit tests for the rows behind /perps.
 *
 * No network: the route fetches Hyperliquid and quotes pools, and what is worth
 * testing is what happens to those two numbers once they meet. The rule that
 * earns a test is the absence one — a perp whose asset has no pool on the
 * selected chain must carry no basis at all, because a basis computed against a
 * missing price reads as a 10,000bp discount rather than as "not listed here".
 */

import { describe, it, expect } from 'vitest';
import { perpRows, STOCK_PERP_DEX, type PerpMarket } from '@/lib/perps';

const market = (m: Partial<PerpMarket> & Pick<PerpMarket, 'symbol'>): PerpMarket => ({
  dex: STOCK_PERP_DEX,
  markUsd: 100,
  fundingHourly: 0,
  openInterestUsd: 0,
  dayVolumeUsd: 0,
  maxLeverage: 5,
  ...m,
});

describe('perpRows', () => {
  it('leaves an unlisted asset without a spot price or a basis', () => {
    const [row] = perpRows([market({ symbol: 'SNDK' })], new Map());
    expect(row.spotBuyUsd).toBeNull();
    expect(row.vsSpotBuyBps).toBeNull();
  });

  it('quotes the basis against the spot price when there is one', () => {
    const [row] = perpRows([market({ symbol: 'NVDA', markUsd: 101 })], new Map([['NVDA', 100]]));
    expect(row.spotBuyUsd).toBe(100);
    expect(row.vsSpotBuyBps).toBeCloseTo(100, 6);
  });

  it('annualises the hourly funding rate exactly once', () => {
    const [row] = perpRows([market({ symbol: 'NVDA', fundingHourly: 0.00001 })], new Map());
    expect(row.fundingAnnual).toBeCloseTo(0.00001 * 24 * 365, 12);
  });

  it('puts the stocks before the core majors, each by open interest', () => {
    const rows = perpRows(
      [
        market({ symbol: 'BTC', dex: '', openInterestUsd: 4e9 }),
        market({ symbol: 'NVDA', openInterestUsd: 1e8 }),
        market({ symbol: 'ETH', dex: '', openInterestUsd: 3e9 }),
        market({ symbol: 'META', openInterestUsd: 9e7 }),
      ],
      new Map(),
    );
    expect(rows.map((r) => r.symbol)).toEqual(['NVDA', 'META', 'BTC', 'ETH']);
  });

  it('does not reorder the markets it was given', () => {
    const markets = [market({ symbol: 'A', dex: '' }), market({ symbol: 'B' })];
    perpRows(markets, new Map());
    expect(markets.map((m) => m.symbol)).toEqual(['A', 'B']);
  });
});

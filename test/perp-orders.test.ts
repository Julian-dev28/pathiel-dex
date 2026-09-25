/**
 * Reading the orders that are still resting.
 *
 * The shape of this response belongs to Hyperliquid, so the tests are about the
 * two places a misreading would be silent and expensive: `side`, which arrives
 * as `A`/`B` and would label every order backwards if read as a word, and the
 * asset id, which a cancel has to carry and which is resolved from the dex the
 * question was asked about rather than parsed out of the coin field.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openOrders, cancelAction } from '@/lib/perp-orders';

const USER = '0x1111111111111111111111111111111111111111' as const;

const UNIVERSE = {
  xyz: [
    { name: 'xyz:AAPL', maxLeverage: 5, szDecimals: 2 },
    { name: 'xyz:TSLA', maxLeverage: 5, szDecimals: 2 },
    { name: 'xyz:NVDA', maxLeverage: 5, szDecimals: 2 },
  ],
  core: [{ name: 'BTC', maxLeverage: 40, szDecimals: 5 }],
};

/** Orders keyed by the dex they are asked for, so each request gets its own. */
let resting: { xyz: unknown[]; core: unknown[] };

beforeEach(() => {
  resting = { xyz: [], core: [] };
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { type: string; dex?: string };
    const which = body.dex === 'xyz' ? 'xyz' : 'core';
    if (body.type === 'frontendOpenOrders') {
      return { ok: true, json: async () => resting[which] };
    }
    return { ok: true, json: async () => [{ universe: UNIVERSE[which] }, []] };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('resting orders', () => {
  it('reads an ask as a sell and a bid as a buy', async () => {
    resting.xyz = [
      { coin: 'xyz:NVDA', side: 'A', limitPx: '250.5', sz: '0.4', origSz: '1', oid: 7, timestamp: 5 },
      { coin: 'xyz:TSLA', side: 'B', limitPx: '400', sz: '2', origSz: '2', oid: 8, timestamp: 9 },
    ];
    const orders = await openOrders(USER);
    expect(orders.map((o) => [o.symbol, o.side])).toEqual([
      ['TSLA', 'buy'],
      ['NVDA', 'sell'],
    ]);
  });

  it('carries the asset id a cancel needs', async () => {
    resting.xyz = [{ coin: 'xyz:NVDA', side: 'B', limitPx: '250', sz: '1', oid: 7, timestamp: 1 }];
    const [order] = await openOrders(USER);
    // Third in `xyz`'s universe, which is what makes it 110002.
    expect(order.assetId).toBe(110002);
    expect(cancelAction([order])).toEqual({ type: 'cancel', cancels: [{ a: 110002, o: 7 }] });
  });

  it('takes a coin with no dex prefix as readily as one with', async () => {
    resting.xyz = [{ coin: 'NVDA', side: 'B', limitPx: '250', sz: '1', oid: 7, timestamp: 1 }];
    expect((await openOrders(USER))[0].assetId).toBe(110002);
  });

  it('reads both dexes, newest first', async () => {
    resting.xyz = [{ coin: 'xyz:NVDA', side: 'B', limitPx: '250', sz: '1', oid: 7, timestamp: 10 }];
    resting.core = [{ coin: 'BTC', side: 'A', limitPx: '90000', sz: '0.1', oid: 8, timestamp: 20 }];
    const orders = await openOrders(USER);
    expect(orders.map((o) => [o.dex, o.oid])).toEqual([
      ['', 8],
      ['xyz', 7],
    ]);
  });

  // An order it cannot name is an order it cannot cancel, and a Cancel button
  // that sends the wrong asset id is worse than no row at all.
  it('drops an order it cannot resolve rather than guessing', async () => {
    resting.xyz = [
      { coin: 'xyz:WHAT', side: 'B', limitPx: '1', sz: '1', oid: 7, timestamp: 1 },
      { coin: 'xyz:NVDA', side: 'B', limitPx: '250', sz: '1', oid: 8, timestamp: 2 },
    ];
    expect((await openOrders(USER)).map((o) => o.oid)).toEqual([8]);
  });

  it('drops an order with no id, which nothing could act on', async () => {
    resting.xyz = [{ coin: 'xyz:NVDA', side: 'B', limitPx: '250', sz: '1', timestamp: 1 }];
    expect(await openOrders(USER)).toEqual([]);
  });

  it('falls back to the remaining size when the original is missing', async () => {
    resting.xyz = [{ coin: 'xyz:NVDA', side: 'B', limitPx: '250', sz: '0.4', oid: 7, timestamp: 1 }];
    const [order] = await openOrders(USER);
    expect([order.sizeLeft, order.origSize]).toEqual([0.4, 0.4]);
  });

  it('is empty when nothing rests', async () => {
    expect(await openOrders(USER)).toEqual([]);
  });
});

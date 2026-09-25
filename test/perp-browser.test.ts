/**
 * The browser path signs the same bytes as the key path.
 *
 * That is the whole point of this file. A wallet cannot be handed a private
 * key, so `prepareOrder` builds the EIP-712 payload and the signature comes
 * back from somewhere else — and a payload that drifts from what `buildOrder`
 * signs does not fail loudly. It produces a well-formed order the exchange
 * silently rejects, in front of a user who is trying to trade. So each case
 * below builds the same order twice, once through each path, and compares the
 * action, the nonce and the signature.
 *
 * The nonce is a millisecond clock, so it is pinned; the universe and the mark
 * price come from a stubbed `fetch`, so nothing here touches the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex, TypedDataDefinition } from 'viem';
import { signTypedData } from 'viem/accounts';
import { splitSignature } from '@/lib/hl-sign';
import {
  explainExchangeError,
  prepareCancel,
  prepareOrder,
} from '@/lib/perp-browser';
import { buildCancel, buildOrder } from '@/lib/perp-order';

const KEY: Hex = '0x0123456789012345678901234567890123456789012345678901234567890123';
const NONCE = 1_700_000_000_000;

/** NVDA third in `xyz`'s universe, which is what makes it asset 110002. */
const UNIVERSE = {
  xyz: [
    { name: 'xyz:AAPL', maxLeverage: 5, szDecimals: 2 },
    { name: 'xyz:TSLA', maxLeverage: 5, szDecimals: 2 },
    { name: 'xyz:NVDA', maxLeverage: 5, szDecimals: 2 },
  ],
  core: [{ name: 'BTC', maxLeverage: 40, szDecimals: 5 }],
};
const CTXS = {
  xyz: [{ markPx: '255.10' }, { markPx: '412.50' }, { markPx: '181.23' }],
  core: [{ markPx: '64000.0' }],
};

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NONCE);
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const { dex } = JSON.parse(init.body) as { dex?: string };
    const which = dex === 'xyz' ? 'xyz' : 'core';
    return { ok: true, json: async () => [{ universe: UNIVERSE[which] }, CTXS[which]] };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Sign a prepared order the way the wallet will, and assemble the request. */
const walletSign = async (prepared: Awaited<ReturnType<typeof prepareOrder>>) =>
  prepared.finalize(
    // The cast is what a wallet does for free: the contract types the payload
    // loosely so any signer takes it, and viem wants its own narrow shape.
    await signTypedData({ privateKey: KEY, ...(prepared.typedData as TypedDataDefinition) }),
  );

describe('splitSignature', () => {
  // `splitSignature` lives in hl-sign.ts, but it is the browser path that made
  // the recovery id a question: a wallet is free to return either convention.
  const R = `0x${'ab'.repeat(32)}`;
  const S = `0x${'cd'.repeat(32)}`;
  const withV = (v: string) => `${R}${S.slice(2)}${v}` as Hex;

  it('lifts a raw recovery id of 0 or 1 to 27 or 28', () => {
    expect(splitSignature(withV('00'))).toEqual({ r: R, s: S, v: 27 });
    expect(splitSignature(withV('01'))).toEqual({ r: R, s: S, v: 28 });
  });

  it('leaves a signature that already says 27 or 28 alone', () => {
    expect(splitSignature(withV('1b')).v).toBe(27);
    expect(splitSignature(withV('1c')).v).toBe(28);
  });

  it('refuses a signature that is not 65 bytes', () => {
    // The compact EIP-2098 form used to slice into v: NaN, serialise as null,
    // and be rejected by the exchange without saying why.
    expect(() => splitSignature(`${R}${S.slice(2)}` as Hex)).toThrow(/65-byte/);
  });
});

/**
 * The invariant the whole review card rests on.
 *
 * The user is shown `summary` and signs `action`. Nothing asserted that the
 * two describe the same order, which is how a limit order sized off the mark
 * shipped green: the signature test fed `summary`'s own numbers to both sides,
 * so any mispricing cancelled out. These read the signed bytes instead.
 */
describe('the summary describes the order that gets signed', () => {
  const signedOrder = (p: Awaited<ReturnType<typeof prepareOrder>>) => {
    const req = p.finalize(`0x${'11'.repeat(65)}` as Hex);
    return (req.action.orders as { a: number; b: boolean; p: string; s: string; t: unknown }[])[0];
  };

  it('agrees on asset, side, size and price for a market order', async () => {
    const prepared = await prepareOrder({ asset: 'NVDA', side: 'buy', usd: 1000 });
    const order = signedOrder(prepared);
    expect(order.a).toBe(prepared.summary.assetId);
    expect(order.b).toBe(prepared.summary.side === 'buy');
    expect(Number(order.s)).toBe(prepared.summary.size);
    expect(Number(order.p)).toBe(prepared.summary.priceUsd);
  });

  it('agrees for a limit order, which is where they used to differ', async () => {
    // A limit far from the mark: sized off the mark this signed 65% more than
    // the dollars asked for, while the summary and the gate saw the smaller
    // number.
    const prepared = await prepareOrder({ asset: 'NVDA', side: 'buy', usd: 1000, limitPrice: 300 });
    const order = signedOrder(prepared);
    expect(Number(order.s)).toBe(prepared.summary.size);
    expect(Number(order.p)).toBe(prepared.summary.priceUsd);
    expect(Number(order.s) * Number(order.p)).toBeLessThanOrEqual(1000);
  });

  it('never signs more notional than the dollars asked for', async () => {
    // Rounding to nearest handed back a fifth again on a coarse market.
    for (const usd of [25, 100, 1000, 7_777]) {
      for (const limitPrice of [undefined, 150, 300]) {
        const prepared = await prepareOrder({ asset: 'NVDA', side: 'buy', usd, limitPrice });
        expect(prepared.summary.notionalUsd).toBeLessThanOrEqual(usd);
      }
    }
  });
});

describe('prepareOrder', () => {
  it('prices a market order as an Ioc limit through the book', async () => {
    const prepared = await prepareOrder({ asset: 'NVDA', side: 'buy', usd: 1000 });
    expect(prepared.summary).toEqual({
      market: 'xyz:NVDA',
      assetId: 110_002,
      side: 'buy',
      size: 5.49,
      markUsd: 181.23,
      // 50bp through the book, rounded to 5 significant figures.
      priceUsd: 182.14,
      notionalUsd: 5.49 * 182.14,
      orderType: 'market (IOC through the book)',
      maxLeverage: 5,
    });
  });

  it('takes a limit price as given, and calls it Gtc', async () => {
    const prepared = await prepareOrder({ asset: 'NVDA', side: 'sell', usd: 1000, limitPrice: 190 });
    expect(prepared.summary.priceUsd).toBe(190);
    expect(prepared.summary.orderType).toBe('limit (Gtc)');
  });

  it('resolves a core market too', async () => {
    const prepared = await prepareOrder({ asset: 'BTC', side: 'buy', usd: 1000 });
    expect(prepared.summary.market).toBe('core:BTC');
    expect(prepared.summary.assetId).toBe(0);
  });

  it('refuses an asset that trades nowhere', async () => {
    await expect(prepareOrder({ asset: 'ZZZZ', side: 'buy', usd: 100 })).rejects.toThrow('no perp market');
  });
});

describe('the wallet path against the key path', () => {
  const cases = [
    { name: 'a market buy', intent: { asset: 'NVDA', side: 'buy', usd: 1000 } as const, tif: 'Ioc' as const },
    {
      name: 'a limit sell, reduce-only',
      intent: { asset: 'NVDA', side: 'sell', usd: 1000, limitPrice: 190, reduceOnly: true } as const,
      tif: 'Gtc' as const,
    },
    { name: 'a core market buy', intent: { asset: 'BTC', side: 'buy', usd: 5000 } as const, tif: 'Ioc' as const },
  ];

  for (const { name, intent, tif } of cases) {
    it(`signs ${name} byte-identically`, async () => {
      const prepared = await prepareOrder(intent);
      const fromWallet = await walletSign(prepared);

      const fromKey = await buildOrder(
        KEY,
        {
          asset: prepared.summary.assetId,
          isBuy: intent.side === 'buy',
          size: prepared.summary.size,
          price: prepared.summary.priceUsd,
          reduceOnly: intent.reduceOnly ?? false,
          tif,
        },
        { nonce: NONCE },
      );

      expect(fromWallet.action).toEqual(fromKey.action);
      expect(fromWallet.nonce).toBe(fromKey.nonce);
      expect(fromWallet.signature).toEqual(fromKey.signature);
    });
  }

  it('signs over the nonce it hands back, not the clock at signing time', async () => {
    const prepared = await prepareOrder({ asset: 'NVDA', side: 'buy', usd: 1000 });
    vi.spyOn(Date, 'now').mockReturnValue(NONCE + 60_000);
    const signed = await walletSign(prepared);
    expect(signed.nonce).toBe(NONCE);
    expect(signed.signature).toEqual(
      (await buildOrder(KEY, { asset: 110_002, isBuy: true, size: 5.49, price: 182.14, tif: 'Ioc' }, { nonce: NONCE }))
        .signature,
    );
  });
});

/**
 * Cancelling, which is the other half of placing a limit order.
 *
 * A `Gtc` order rests until somebody takes it back, and the browser had no way
 * to. These check the cancel is the same action the key path sends and that it
 * names the order it was handed — a cancel carrying the wrong asset id is
 * accepted by nothing and explains itself to no one.
 */
describe('cancelling a resting order', () => {
  const order = {
    dex: 'xyz',
    symbol: 'NVDA',
    assetId: 110002,
    oid: 987654321,
    side: 'buy' as const,
    sizeLeft: 0.4,
    origSize: 1,
    limitUsd: 210.5,
    placedAt: NONCE,
    reduceOnly: false,
  };

  it('signs the bytes the key path signs', async () => {
    const prepared = prepareCancel(order);
    const browser = await walletSign(prepared);
    const viaKey = await buildCancel(KEY, [{ asset: order.assetId, oid: order.oid }]);
    expect(browser.action).toEqual(viaKey.action);
    expect(browser.nonce).toBe(viaKey.nonce);
    expect(browser.signature).toEqual(viaKey.signature);
  });

  it('cancels the order it was given, not the market', () => {
    const { action } = prepareCancel(order).finalize(`0x${'11'.repeat(65)}` as Hex);
    expect(action).toEqual({ type: 'cancel', cancels: [{ a: 110002, o: 987654321 }] });
  });

  it('shows what is being cancelled rather than what would be bought', () => {
    expect(prepareCancel(order).summary).toEqual({
      market: 'xyz:NVDA',
      side: 'buy',
      sizeLeft: 0.4,
      limitUsd: 210.5,
    });
  });
});

describe('orders the exchange would refuse anyway', () => {
  // A signature spent on an order that cannot be accepted is the one failure
  // this path can prevent outright.
  it('refuses a notional under the exchange minimum before signing', async () => {
    await expect(prepareOrder({ asset: 'NVDA', side: 'buy', usd: 5, dex: 'xyz' })).rejects.toThrow(
      /under \$10/,
    );
  });

  // The check is on the rounded size, priced where the order will rest. $10.40
  // of a two-decimal market marked at $181.23 buys 0.05 at the $182.13 a market
  // order reaches to — $9.11, which the venue would have thrown out after the
  // customer had already signed for it.
  it('measures the minimum on the size that will actually be sent', async () => {
    await expect(
      prepareOrder({ asset: 'NVDA', side: 'buy', usd: 10.4, dex: 'xyz' }),
    ).rejects.toThrow(/works out at \$9\.11/);
  });

  it('takes an order that clears it', async () => {
    const prepared = await prepareOrder({ asset: 'NVDA', side: 'buy', usd: 25, dex: 'xyz' });
    expect(prepared.summary.notionalUsd).toBeGreaterThanOrEqual(10);
  });
});

describe('what the exchange says, in terms someone can act on', () => {
  it('explains an account Hyperliquid has never seen', () => {
    expect(explainExchangeError('User or API Wallet 0xabc does not exist.')).toMatch(
      /never been funded on Hyperliquid/,
    );
  });

  it('explains a margin shortfall', () => {
    expect(explainExchangeError('Insufficient margin to place order')).toMatch(/Reduce the size/);
  });

  // A wrong explanation is worse than the venue's own words.
  it('passes anything else through unchanged', () => {
    expect(explainExchangeError('Price must be divisible by tick size')).toBe(
      'Price must be divisible by tick size',
    );
  });
});

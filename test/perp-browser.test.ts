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
import { prepareOrder } from '@/lib/perp-browser';
import { buildOrder } from '@/lib/perp-order';

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
});

describe('prepareOrder', () => {
  it('prices a market order as an Ioc limit through the book', async () => {
    const prepared = await prepareOrder({ asset: 'NVDA', side: 'buy', usd: 1000 });
    expect(prepared.summary).toEqual({
      market: 'xyz:NVDA',
      assetId: 110_002,
      side: 'buy',
      size: 5.52,
      markUsd: 181.23,
      // 50bp through the book, rounded to 5 significant figures.
      priceUsd: 182.14,
      notionalUsd: 5.52 * 182.14,
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
      (await buildOrder(KEY, { asset: 110_002, isBuy: true, size: 5.52, price: 182.14, tif: 'Ioc' }, { nonce: NONCE }))
        .signature,
    );
  });
});

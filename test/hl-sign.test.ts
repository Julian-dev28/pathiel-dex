/**
 * The signing scheme, against the official SDK's own vectors.
 *
 * Every hash and signature asserted here was copied out of
 * `tests/signing_test.py` in hyperliquid-dex/hyperliquid-python-sdk, which is
 * the implementation the exchange is built against. They are quoted exactly as
 * that file prints them — eth_utils strips leading zeros from r and s, hence
 * `pad` — so that a diff against the source is a diff of digits, not of
 * formatting. A test that asserted our own output back at us would prove
 * nothing: a wrong signature is rejected by the exchange with no diagnostic.
 */

import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { actionHash, floatToWire, signL1Action, signUserAction, SIGNATURE_CHAIN_ID } from '@/lib/hl-sign';

const KEY: Hex = '0x0123456789012345678901234567890123456789012345678901234567890123';

const pad = (h: string): Hex => `0x${h.slice(2).padStart(64, '0')}`;

const orderAction = (wire: Record<string, unknown>) => ({ type: 'order', orders: [wire], grouping: 'na' });

describe('actionHash', () => {
  it('matches the production phantom agent connectionId', () => {
    const action = orderAction({
      a: 4,
      b: true,
      p: '1670.1',
      s: '0.0147',
      r: false,
      t: { limit: { tif: 'Ioc' } },
    });
    expect(actionHash(action, null, 1677777606040, null)).toBe(
      '0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908',
    );
  });
});

describe('signL1Action', () => {
  it('signs a dummy action', async () => {
    const action = { type: 'dummy', num: 100000000000 };
    expect(await signL1Action(KEY, action, 0)).toEqual({
      r: pad('0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298'),
      s: pad('0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8'),
      v: 27,
    });
    expect(await signL1Action(KEY, action, 0, { isMainnet: false })).toEqual({
      r: pad('0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510'),
      s: pad('0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613'),
      v: 28,
    });
  });

  it('signs an order', async () => {
    const action = orderAction({ a: 1, b: true, p: '100', s: '100', r: false, t: { limit: { tif: 'Gtc' } } });
    expect(await signL1Action(KEY, action, 0)).toEqual({
      r: pad('0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e'),
      s: pad('0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e'),
      v: 28,
    });
    expect(await signL1Action(KEY, action, 0, { isMainnet: false })).toEqual({
      r: pad('0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54'),
      s: pad('0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5'),
      v: 27,
    });
  });

  it('signs an order with a cloid', async () => {
    const action = orderAction({
      a: 1,
      b: true,
      p: '100',
      s: '100',
      r: false,
      t: { limit: { tif: 'Gtc' } },
      c: '0x00000000000000000000000000000001',
    });
    expect(await signL1Action(KEY, action, 0)).toEqual({
      r: pad('0x41ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3'),
      s: pad('0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da'),
      v: 27,
    });
  });

  it('signs a trigger order', async () => {
    const action = orderAction({
      a: 1,
      b: true,
      p: '100',
      s: '100',
      r: false,
      t: { trigger: { isMarket: true, triggerPx: '103', tpsl: 'sl' } },
    });
    expect(await signL1Action(KEY, action, 0)).toEqual({
      r: pad('0x98343f2b5ae8e26bb2587daad3863bc70d8792b09af1841b6fdd530a2065a3f9'),
      s: pad('0x6b5bb6bb0633b710aa22b721dd9dee6d083646a5f8e581a20b545be6c1feb405'),
      v: 27,
    });
  });

  // A vault changes the hash, not the payload, which is why it is signed and
  // tested here even though nothing in this app trades one.
  it('signs with a vault address', async () => {
    const action = { type: 'dummy', num: 100000000000 };
    const vaultAddress = '0x1719884eb866cb12b2287399b15f7db5e7d775ea' as const;
    expect(await signL1Action(KEY, action, 0, { vaultAddress })).toEqual({
      r: pad('0x3c548db75e479f8012acf3000ca3a6b05606bc2ec0c29c50c515066a326239'),
      s: pad('0x4d402be7396ce74fbba3795769cda45aec00dc3125a984f2a9f23177b190da2c'),
      v: 28,
    });
    expect(await signL1Action(KEY, action, 0, { vaultAddress, isMainnet: false })).toEqual({
      r: pad('0xe281d2fb5c6e25ca01601f878e4d69c965bb598b88fac58e475dd1f5e56c362b'),
      s: pad('0x7ddad27e9a238d045c035bc606349d075d5c5cd00a6cd1da23ab5c39d4ef0f60'),
      v: 27,
    });
  });

  it('signs a scheduleCancel, with and without a time', async () => {
    expect(await signL1Action(KEY, { type: 'scheduleCancel' }, 0)).toEqual({
      r: pad('0x6cdfb286702f5917e76cd9b3b8bf678fcc49aec194c02a73e6d4f16891195df9'),
      s: pad('0x6557ac307fa05d25b8d61f21fb8a938e703b3d9bf575f6717ba21ec61261b2a0'),
      v: 27,
    });
    expect(await signL1Action(KEY, { type: 'scheduleCancel', time: 123456789 }, 0)).toEqual({
      r: pad('0x609cb20c737945d070716dcc696ba030e9976fcf5edad87afa7d877493109d55'),
      s: pad('0x16c685d63b5c7a04512d73f183b3d7a00da5406ff1f8aad33f8ae2163bab758b'),
      v: 28,
    });
  });
});

describe('signUserAction', () => {
  /**
   * The only user-signed vectors the SDK publishes are for usdSend and
   * withdraw. Neither action is built anywhere in this codebase and neither
   * ever will be — see the note in `perp-order.ts` — but the typed-data
   * machinery they exercise is the same one approveAgent and sendAsset go
   * through, so the vector is worth more here than the action is dangerous:
   * these are four field names and a signature, not a code path.
   */
  it('matches the SDK usdSend vector', async () => {
    const action = {
      signatureChainId: SIGNATURE_CHAIN_ID,
      hyperliquidChain: 'Testnet',
      destination: '0x5e9ee1089755c3435139848e47e6635505d5a13a',
      amount: '1',
      time: 1687816341423,
    } as const;
    const fields = [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'destination', type: 'string' },
      { name: 'amount', type: 'string' },
      { name: 'time', type: 'uint64' },
    ];
    expect(await signUserAction(KEY, action, fields, 'HyperliquidTransaction:UsdSend')).toEqual({
      r: pad('0x637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073'),
      s: pad('0x11a6a24900e6e314136d2592e2f8d502cd89b7c15b198e1bee043c9589f9fad7'),
      v: 27,
    });
  });
});

describe('the signer is the key that was passed', () => {
  it('recovers the agent address from an L1 action', async () => {
    const { recoverTypedDataAddress } = await import('viem');
    const action = orderAction({ a: 110001, b: true, p: '100', s: '1', r: false, t: { limit: { tif: 'Ioc' } } });
    const sig = await signL1Action(KEY, action, 1700000000000);
    const recovered = await recoverTypedDataAddress({
      domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' },
      types: {
        Agent: [
          { name: 'source', type: 'string' },
          { name: 'connectionId', type: 'bytes32' },
        ],
      },
      primaryType: 'Agent',
      message: { source: 'a', connectionId: actionHash(action, null, 1700000000000, null) },
      signature: { r: sig.r, s: sig.s, v: BigInt(sig.v) },
    });
    expect(recovered).toBe(privateKeyToAccount(KEY).address);
  });
});

describe('floatToWire', () => {
  it('drops trailing zeros and refuses what it cannot represent', () => {
    expect(floatToWire(100)).toBe('100');
    expect(floatToWire(1670.1)).toBe('1670.1');
    expect(floatToWire(0.0147)).toBe('0.0147');
    expect(floatToWire(-0)).toBe('0');
    expect(() => floatToWire(0.000000001)).toThrow();
  });
});

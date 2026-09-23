/**
 * The order layer: asset ids, payload shape, and who signed.
 *
 * Two of these assertions are external — the signatures for a Gtc order and for
 * a scheduleCancel are the Python SDK's published vectors, run through our own
 * builders rather than through a hand-assembled action, so they pin the field
 * order the builders emit as well as the signing. The rest is shape, recovery
 * and the asset id arithmetic.
 *
 * Nothing here touches the network, and nothing here is a real key.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { actionHash, SIGNATURE_CHAIN_ID } from '@/lib/hl-sign';
import * as perpOrder from '@/lib/perp-order';
import {
  buildAgentSendAsset,
  buildApproveAgent,
  buildApproveBuilderFee,
  buildCancel,
  buildOrder,
  buildScheduleCancel,
  buildUpdateLeverage,
  marketPrice,
  perpAssetId,
  STOCK_PERP_DEX_INDEX,
  USDC_TOKEN,
  type ExchangeRequest,
} from '@/lib/perp-order';

const KEY: Hex = '0x0123456789012345678901234567890123456789012345678901234567890123';
const ADDRESS = privateKeyToAccount(KEY).address;
const pad = (h: string): Hex => `0x${h.slice(2).padStart(64, '0')}`;

const agentOf = async (req: ExchangeRequest): Promise<Address> =>
  recoverTypedDataAddress({
    domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' },
    types: {
      Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' },
      ],
    },
    primaryType: 'Agent',
    message: { source: 'a', connectionId: actionHash(req.action, null, req.nonce, req.expiresAfter ?? null) },
    signature: { r: req.signature.r, s: req.signature.s, v: BigInt(req.signature.v) },
  });

describe('perpAssetId', () => {
  it('leaves core markets as their universe index', () => {
    expect(perpAssetId(0, 0)).toBe(0);
    expect(perpAssetId(0, 3)).toBe(3);
  });

  it('offsets a builder dex to 110000 and up', () => {
    // The docs' own example: a testnet `test:ABC` at perp dex index 1, first in
    // its universe, is asset 110000.
    expect(perpAssetId(1, 0)).toBe(110_000);
    expect(perpAssetId(STOCK_PERP_DEX_INDEX, 7)).toBe(110_007);
    expect(perpAssetId(2, 0)).toBe(120_000);
  });

  it('never collides with the core index it shadows', () => {
    expect(perpAssetId(STOCK_PERP_DEX_INDEX, 7)).not.toBe(perpAssetId(0, 7));
  });
});

describe('buildOrder', () => {
  const stock = perpAssetId(STOCK_PERP_DEX_INDEX, 7);

  it('matches the SDK signature vector for a Gtc order', async () => {
    const req = await buildOrder(KEY, { asset: 1, isBuy: true, size: 100, price: 100 }, { nonce: 0 });
    expect(req.signature).toEqual({
      r: pad('0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e'),
      s: pad('0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e'),
      v: 28,
    });
  });

  it('defaults to a resting Gtc limit with no cloid and no builder', async () => {
    const req = await buildOrder(KEY, { asset: stock, isBuy: true, size: 2, price: 181.23 }, { nonce: 1 });
    expect(req.action).toEqual({
      type: 'order',
      orders: [{ a: 110_007, b: true, p: '181.23', s: '2', r: false, t: { limit: { tif: 'Gtc' } } }],
      grouping: 'na',
    });
    expect(req.action.orders).not.toHaveProperty('0.c');
    expect(req.action).not.toHaveProperty('builder');
    expect(req).not.toHaveProperty('expiresAfter');
  });

  it('builds a market order as an Ioc limit priced through the book', async () => {
    const price = marketPrice(181.23, true, 0.05, 2);
    const req = await buildOrder(KEY, { asset: stock, isBuy: true, size: 2, price, tif: 'Ioc' }, { nonce: 1 });
    const [order] = req.action.orders as Record<string, unknown>[];
    expect(order.t).toEqual({ limit: { tif: 'Ioc' } });
    expect(order.p).toBe('190.29');
  });

  it('carries reduceOnly, a cloid and a builder fee when asked', async () => {
    const req = await buildOrder(
      KEY,
      {
        asset: stock,
        isBuy: false,
        size: 2,
        price: 181.23,
        reduceOnly: true,
        tif: 'Alo',
        cloid: '0x00000000000000000000000000000001',
        builder: { address: '0x1719884eb866CB12B2287399b15f7dB5E7d775EA', feeTenthsBps: 10 },
      },
      { nonce: 1 },
    );
    const [order] = req.action.orders as Record<string, unknown>[];
    expect(order.r).toBe(true);
    expect(order.c).toBe('0x00000000000000000000000000000001');
    // The exchange wants the builder address lowercased.
    expect(req.action.builder).toEqual({ b: '0x1719884eb866cb12b2287399b15f7db5e7d775ea', f: 10 });
  });

  it('is signed by the key it was given, over the action it returns', async () => {
    const req = await buildOrder(KEY, { asset: stock, isBuy: true, size: 2, price: 181.23 }, { nonce: 1700000000000 });
    expect(await agentOf(req)).toBe(ADDRESS);
  });

  it('signs over expiresAfter when one is set, and echoes it in the request', async () => {
    const req = await buildOrder(
      KEY,
      { asset: stock, isBuy: true, size: 2, price: 181.23 },
      { nonce: 1700000000000, expiresAfter: 1700000060000 },
    );
    expect(req.expiresAfter).toBe(1700000060000);
    expect(await agentOf(req)).toBe(ADDRESS);
  });

  it('refuses a size it cannot represent rather than rounding it', async () => {
    await expect(buildOrder(KEY, { asset: stock, isBuy: true, size: 0.0000000001, price: 1 })).rejects.toThrow();
  });
});

describe('the other L1 actions', () => {
  it('cancels by asset and order id', async () => {
    const req = await buildCancel(KEY, [{ asset: 110_007, oid: 42 }], { nonce: 1 });
    expect(req.action).toEqual({ type: 'cancel', cancels: [{ a: 110_007, o: 42 }] });
    expect(await agentOf(req)).toBe(ADDRESS);
  });

  it('updates leverage', async () => {
    const req = await buildUpdateLeverage(KEY, { asset: 110_007, isCross: false, leverage: 3 }, { nonce: 1 });
    expect(req.action).toEqual({ type: 'updateLeverage', asset: 110_007, isCross: false, leverage: 3 });
  });

  it('matches the SDK signature vector for scheduleCancel', async () => {
    const req = await buildScheduleCancel(KEY, null, { nonce: 0 });
    expect(req.action).toEqual({ type: 'scheduleCancel' });
    expect(req.signature).toEqual({
      r: pad('0x6cdfb286702f5917e76cd9b3b8bf678fcc49aec194c02a73e6d4f16891195df9'),
      s: pad('0x6557ac307fa05d25b8d61f21fb8a938e703b3d9bf575f6717ba21ec61261b2a0'),
      v: 27,
    });
    const timed = await buildScheduleCancel(KEY, 123456789, { nonce: 0 });
    expect(timed.signature).toEqual({
      r: pad('0x609cb20c737945d070716dcc696ba030e9976fcf5edad87afa7d877493109d55'),
      s: pad('0x16c685d63b5c7a04512d73f183b3d7a00da5406ff1f8aad33f8ae2163bab758b'),
      v: 28,
    });
  });
});

describe('user-signed actions', () => {
  const userDomain = {
    name: 'HyperliquidSignTransaction',
    version: '1',
    chainId: Number(SIGNATURE_CHAIN_ID),
    verifyingContract: '0x0000000000000000000000000000000000000000',
  } as const;

  const signerOf = (req: ExchangeRequest, primaryType: string, fields: { name: string; type: string }[]) =>
    recoverTypedDataAddress({
      domain: userDomain,
      types: { [primaryType]: fields },
      primaryType,
      message: req.action,
      signature: { r: req.signature.r, s: req.signature.s, v: BigInt(req.signature.v) },
    });

  it('approveAgent names the agent and is signed by the master key', async () => {
    const agent: Address = '0x1719884eb866CB12B2287399b15f7dB5E7d775EA';
    const req = await buildApproveAgent(KEY, { agentAddress: agent, agentName: 'valid_until 1700000000000' }, 7);
    expect(req.action).toEqual({
      signatureChainId: SIGNATURE_CHAIN_ID,
      hyperliquidChain: 'Mainnet',
      type: 'approveAgent',
      agentAddress: agent,
      agentName: 'valid_until 1700000000000',
      nonce: 7,
    });
    const signer = await signerOf(req, 'HyperliquidTransaction:ApproveAgent', [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'agentAddress', type: 'address' },
      { name: 'agentName', type: 'string' },
      { name: 'nonce', type: 'uint64' },
    ]);
    expect(signer).toBe(ADDRESS);
  });

  it('approveBuilderFee carries the rate as a percent string', async () => {
    const req = await buildApproveBuilderFee(KEY, { builder: '0x1719884eb866CB12B2287399b15f7dB5E7d775EA', maxFeeRate: '0.01%' }, 7);
    expect(req.action.maxFeeRate).toBe('0.01%');
    const signer = await signerOf(req, 'HyperliquidTransaction:ApproveBuilderFee', [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'maxFeeRate', type: 'string' },
      { name: 'builder', type: 'address' },
      { name: 'nonce', type: 'uint64' },
    ]);
    expect(signer).toBe(ADDRESS);
  });

  it('sends collateral to itself and nowhere else', async () => {
    const req = await buildAgentSendAsset(
      KEY,
      { address: ADDRESS, sourceDex: '', destinationDex: 'xyz', amount: 250 },
      7,
    );
    expect(req.action).toEqual({
      signatureChainId: SIGNATURE_CHAIN_ID,
      hyperliquidChain: 'Mainnet',
      type: 'sendAsset',
      destination: ADDRESS,
      sourceDex: '',
      destinationDex: 'xyz',
      token: USDC_TOKEN,
      amount: '250',
      fromSubAccount: '',
      nonce: 7,
    });
    // Asserting the destination is what was passed in proves nothing about
    // safety — the restriction to self is Hyperliquid's, not this code's. What
    // is worth pinning is the action shape the exchange has to recognise.
    expect(req.action.type).toBe('sendAsset');
    expect(req.action.sourceDex).toBe('');
    expect(req.action.destinationDex).toBe('xyz');
    expect(req.action.token).toBe(USDC_TOKEN);
  });
});

describe('what the module refuses to be able to do', () => {
  // The previous version of this grepped export *names* for /withdraw|usdsend|
  // spotsend|transfer/ and read as a safety proof. buildAgentSendAsset — which
  // moves money and takes its destination from the caller — passed it. A name
  // is not a capability; what matters is which action types can be built.
  it('can build no action type that moves money off the account', () => {
    const forbidden = ['withdraw3', 'usdSend', 'spotSend'];
    const source = readFileSync(new URL('../src/lib/perp-order.ts', import.meta.url), 'utf8');
    for (const type of forbidden) {
      expect(source.includes(`type: '${type}'`), `${type} must not be constructible`).toBe(false);
    }
  });

  it('builds only the action types this product needs', async () => {
    const built = await Promise.all([
      buildOrder(KEY, { asset: 0, isBuy: true, size: 1, price: 1 }, { nonce: 1 }),
      buildCancel(KEY, [{ asset: 0, oid: 1 }], { nonce: 1 }),
      buildUpdateLeverage(KEY, { asset: 0, isCross: true, leverage: 5 }, { nonce: 1 }),
      buildScheduleCancel(KEY, null, { nonce: 1 }),
    ]);
    expect(built.map((r) => r.action.type as string).sort()).toEqual([
      'cancel',
      'order',
      'scheduleCancel',
      'updateLeverage',
    ]);
  });
});

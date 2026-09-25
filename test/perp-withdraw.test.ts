/**
 * The exit from perp margin.
 *
 * The property worth testing is the one that makes this safe to exist at all:
 * the destination is the signing account and cannot be anything else. Everything
 * else here is about the payload being the bytes Hyperliquid hashes — verified
 * live against the venue, which accepted it and complained only that the
 * throwaway account had never deposited.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { prepareWithdrawal, MIN_WITHDRAW_USD, WITHDRAW_FEE_USD } from '@/lib/perp-withdraw';

const OWNER = '0xAbC0000000000000000000000000000000000001' as const;

afterEach(() => vi.restoreAllMocks());

describe('withdrawing margin', () => {
  it('sends to the owner, lower-cased the way the exchange hashes it', () => {
    const { action } = prepareWithdrawal(OWNER, 50).finalize(`0x${'11'.repeat(65)}`);
    expect(action.destination).toBe(OWNER.toLowerCase());
    expect(action.type).toBe('withdraw3');
  });

  // The signed message and the posted action have to carry the same amount
  // string, or the exchange hashes something the signature does not cover.
  it('signs the same amount string it posts', () => {
    const prepared = prepareWithdrawal(OWNER, 12.5);
    const { action } = prepared.finalize(`0x${'11'.repeat(65)}`);
    expect(prepared.typedData.message.amount).toBe(action.amount);
    expect(action.amount).toBe('12.5');
  });

  // The amount is a string the exchange hashes, and the trailing-zero strip
  // that makes it one runs on the whole string: a round hundred must not come
  // out as a dollar.
  it.each([
    [100, '100'],
    [20, '20'],
    [12.5, '12.5'],
    [100.5, '100.5'],
    [3.0001, '3.0001'],
  ])('writes $%s as "%s"', (usd, expected) => {
    const { action } = prepareWithdrawal(OWNER, usd).finalize(`0x${'11'.repeat(65)}`);
    expect(action.amount).toBe(expected);
  });

  it('signs the same time it posts as the nonce', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const prepared = prepareWithdrawal(OWNER, 20);
    const req = prepared.finalize(`0x${'11'.repeat(65)}`);
    expect(prepared.typedData.message.time).toBe(1_700_000_000_000);
    expect(req.nonce).toBe(1_700_000_000_000);
    expect(req.action.time).toBe(1_700_000_000_000);
  });

  it('names the four fields the exchange hashes, in its order', () => {
    const types = prepareWithdrawal(OWNER, 20).typedData.types as Record<
      string,
      { name: string }[]
    >;
    expect(types['HyperliquidTransaction:Withdraw'].map((f) => f.name)).toEqual([
      'hyperliquidChain',
      'destination',
      'amount',
      'time',
    ]);
  });

  it('says what will actually arrive after the flat fee', () => {
    expect(prepareWithdrawal(OWNER, 50).summary.arrivingUsd).toBe(50 - WITHDRAW_FEE_USD);
  });

  // A flat fee makes a small withdrawal absurd rather than merely expensive.
  it('refuses an amount the fee would eat', () => {
    expect(() => prepareWithdrawal(OWNER, MIN_WITHDRAW_USD - 0.01)).toThrow(/not worth moving/);
    expect(() => prepareWithdrawal(OWNER, 0)).toThrow(/not worth moving/);
  });
});

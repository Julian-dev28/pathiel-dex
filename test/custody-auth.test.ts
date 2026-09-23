/**
 * Tests for sign-in and for authorising a withdrawal.
 *
 * Written against the attacks rather than the happy path: a signature is a
 * bearer credential, so what matters is which ones are refused. Real keys and
 * real signatures throughout — a mocked verifier would prove only that the
 * mock agrees with itself, which is the failure mode every audit in this
 * project has already found once.
 */

import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { getAddress } from 'viem';
import {
  AuthError,
  MemoryNonces,
  SESSION_TTL_MS,
  SIGN_IN_TTL_MS,
  isExpired,
  signInMessage,
  verifySignIn,
  type SignInRequest,
} from '@/lib/custody/auth';
import {
  MemoryLedger,
  userAccount,
} from '@/lib/custody/ledger';
import { creditDeposit } from '@/lib/custody/accounts';
import {
  WithdrawalError,
  abandonWithdrawal,
  confirmWithdrawal,
  needsTravelRuleData,
  AUTHORISATION_TTL_MS,
  requestWithdrawal,
  withdrawalMessage,
  type WithdrawalRequest,
} from '@/lib/custody/withdrawals';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const account = privateKeyToAccount(KEY);
const OTHER = privateKeyToAccount(
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
);

const DOMAIN = 'pathiel.example';
const NOW = 1_700_000_000_000;

const request = (over: Partial<SignInRequest> = {}): SignInRequest => ({
  address: account.address,
  nonce: 'nonce-1',
  issuedAt: NOW,
  domain: DOMAIN,
  chainId: 8453,
  ...over,
});

const signIn = async (req: SignInRequest) => account.signMessage({ message: signInMessage(req) });

describe('signing in with a wallet', () => {
  it('accepts a fresh signature over an issued nonce', async () => {
    const nonces = new MemoryNonces();
    const req = request({ nonce: await nonces.issue(account.address) });
    const session = await verifySignIn(nonces, {
      request: req,
      signature: await signIn(req),
      expectedDomain: DOMAIN,
      now: NOW,
    });
    expect(session.userId).toBe(getAddress(account.address));
    expect(session.expiresAt).toBe(NOW + SESSION_TTL_MS);
  });

  it('refuses a signature farmed on another site', async () => {
    // The whole reason the domain is in the message: a signature collected by
    // someone else's page must not open an account here.
    const nonces = new MemoryNonces();
    const req = request({ nonce: await nonces.issue(account.address), domain: 'evil.example' });
    await expect(
      verifySignIn(nonces, {
        request: req,
        signature: await signIn(req),
        expectedDomain: DOMAIN,
        now: NOW,
      }),
    ).rejects.toThrow(/issued for evil.example/);
  });

  it('refuses the same signature twice', async () => {
    const nonces = new MemoryNonces();
    const req = request({ nonce: await nonces.issue(account.address) });
    const signature = await signIn(req);
    await verifySignIn(nonces, { request: req, signature, expectedDomain: DOMAIN, now: NOW });
    await expect(
      verifySignIn(nonces, { request: req, signature, expectedDomain: DOMAIN, now: NOW }),
    ).rejects.toThrow(/already used/);
  });

  it('refuses a nonce it never issued', async () => {
    const nonces = new MemoryNonces();
    const req = request({ nonce: 'made-up' });
    await expect(
      verifySignIn(nonces, {
        request: req,
        signature: await signIn(req),
        expectedDomain: DOMAIN,
        now: NOW,
      }),
    ).rejects.toThrow(/never issued/);
  });

  it('refuses an expired message', async () => {
    const nonces = new MemoryNonces();
    const req = request({ nonce: await nonces.issue(account.address) });
    await expect(
      verifySignIn(nonces, {
        request: req,
        signature: await signIn(req),
        expectedDomain: DOMAIN,
        now: NOW + SIGN_IN_TTL_MS + 1,
      }),
    ).rejects.toThrow(/expired/);
  });

  it('refuses one issued in the future', async () => {
    const nonces = new MemoryNonces();
    const req = request({ nonce: await nonces.issue(account.address), issuedAt: NOW + 600_000 });
    await expect(
      verifySignIn(nonces, {
        request: req,
        signature: await signIn(req),
        expectedDomain: DOMAIN,
        now: NOW,
      }),
    ).rejects.toThrow(/not yet valid/);
  });

  it('refuses a signature from a different address', async () => {
    const nonces = new MemoryNonces();
    const req = request({ nonce: await nonces.issue(account.address) });
    const signature = await OTHER.signMessage({ message: signInMessage(req) });
    await expect(
      verifySignIn(nonces, { request: req, signature, expectedDomain: DOMAIN, now: NOW }),
    ).rejects.toThrow(AuthError);
  });

  it('does not burn the nonce on a failed attempt', async () => {
    // Otherwise anyone could lock a customer out by replaying a bad request.
    const nonces = new MemoryNonces();
    const nonce = await nonces.issue(account.address);
    const req = request({ nonce });
    const forged = await OTHER.signMessage({ message: signInMessage(req) });
    await expect(
      verifySignIn(nonces, { request: req, signature: forged, expectedDomain: DOMAIN, now: NOW }),
    ).rejects.toThrow();
    // The real customer can still use it.
    await expect(
      verifySignIn(nonces, {
        request: req,
        signature: await signIn(req),
        expectedDomain: DOMAIN,
        now: NOW,
      }),
    ).resolves.toMatchObject({ userId: getAddress(account.address) });
  });

  it('says in the message that signing in moves no money', async () => {
    // If a sign-in and a payment authorisation ever read alike in a wallet,
    // the phishing writes itself.
    expect(signInMessage(request())).toContain('does not authorise a withdrawal');
  });

  it('expires a session', () => {
    const session = { userId: 'x', address: account.address, issuedAt: NOW, expiresAt: NOW + 10 };
    expect(isExpired(session, NOW + 9)).toBe(false);
    expect(isExpired(session, NOW + 10)).toBe(true);
  });
});

describe('authorising a withdrawal', () => {
  const funded = async () => {
    const ledger = new MemoryLedger();
    await creditDeposit(ledger, {
      userId: getAddress(account.address),
      asset: 'USDC',
      amount: 1_000_000_000n,
      venue: 'base',
      txHash: '0xdep', occurrence: 0, from: '0xsender',
    });
    return ledger;
  };

  const withdrawal = (over: Partial<WithdrawalRequest> = {}): WithdrawalRequest => ({
    id: 'w1',
    userId: getAddress(account.address),
    asset: 'USDC',
    amount: 100_000_000n,
    destination: OTHER.address,
    venue: 'base',
    issuedAt: NOW,
    valueSgd: 100,
    ...over,
  });

  const sign = (req: WithdrawalRequest) =>
    account.signMessage({ message: withdrawalMessage(req) });

  it('reserves the amount once the customer has signed for it', async () => {
    const ledger = await funded();
    const req = withdrawal();
    await requestWithdrawal(ledger, req, await sign(req), NOW);
    expect(await ledger.balance(userAccount(req.userId, 'USDC'))).toBe(900_000_000n);
  });

  it('refuses a payment the session holder did not sign', async () => {
    // The attack this exists for: a stolen session should be able to read a
    // balance and not to move it.
    const ledger = await funded();
    const req = withdrawal();
    const forged = await OTHER.signMessage({ message: withdrawalMessage(req) });
    await expect(requestWithdrawal(ledger, req, forged, NOW)).rejects.toThrow(AuthError);
    expect(await ledger.balance(userAccount(req.userId, 'USDC'))).toBe(1_000_000_000n);
  });

  it('refuses a signature for a different destination', async () => {
    // Sign for one address, submit another: the signature must not carry over.
    const ledger = await funded();
    const signed = withdrawal();
    const signature = await sign(signed);
    const swapped = { ...signed, destination: account.address };
    await expect(requestWithdrawal(ledger, swapped, signature, NOW)).rejects.toThrow(AuthError);
  });

  it('refuses the same signature submitted under a new request id', async () => {
    // Found by probing rather than by review: with the id absent from the
    // signed text, one authorisation reserved the amount again under every new
    // id until the balance ran out, and each reservation could then be paid.
    const ledger = await funded();
    const first = withdrawal({ id: 'w1', amount: 500_000_000n });
    const signature = await sign(first);
    await requestWithdrawal(ledger, first, signature, NOW);
    await expect(
      requestWithdrawal(ledger, { ...first, id: 'w2' }, signature, NOW),
    ).rejects.toThrow(AuthError);
    expect(await ledger.balance(userAccount(first.userId, 'USDC'))).toBe(500_000_000n);
  });

  it('refuses an authorisation older than the window', async () => {
    // A signature over a payment is not a standing instruction.
    const ledger = await funded();
    const req = withdrawal();
    const signature = await sign(req);
    await expect(
      requestWithdrawal(ledger, req, signature, NOW + AUTHORISATION_TTL_MS + 1),
    ).rejects.toThrow(/expired/);
  });

  it('refuses one dated in the future', async () => {
    const ledger = await funded();
    const req = withdrawal({ issuedAt: NOW + 600_000 });
    await expect(requestWithdrawal(ledger, req, await sign(req), NOW)).rejects.toThrow(/future/);
  });

  it('refuses a signature for a different amount', async () => {
    const ledger = await funded();
    const signed = withdrawal();
    const signature = await sign(signed);
    await expect(
      requestWithdrawal(ledger, { ...signed, amount: 900_000_000n }, signature, NOW),
    ).rejects.toThrow(AuthError);
  });

  it('names the destination and amount in the text the wallet shows', async () => {
    const req = withdrawal();
    const message = withdrawalMessage(req);
    expect(message).toContain(req.destination);
    expect(message).toContain('100000000 USDC');
    expect(message).toContain('cannot be reversed');
  });

  it('refuses more than the balance, with a usable message', async () => {
    const ledger = await funded();
    const req = withdrawal({ amount: 2_000_000_000n });
    await expect(requestWithdrawal(ledger, req, await sign(req))).rejects.toThrow(WithdrawalError);
    expect(await ledger.balance(userAccount(req.userId, 'USDC'))).toBe(1_000_000_000n);
  });

  it('requires beneficiary information above the MAS travel-rule threshold', async () => {
    const ledger = await funded();
    const big = withdrawal({ valueSgd: 2_000 });
    expect(needsTravelRuleData(big)).toBe(true);
    await expect(requestWithdrawal(ledger, big, await sign(big), NOW)).rejects.toThrow(/beneficiary/);

    const named = withdrawal({ valueSgd: 2_000, beneficiary: { name: 'A Person' } });
    await expect(requestWithdrawal(ledger, named, await sign(named), NOW)).resolves.toBeTruthy();
  });

  it('collects nothing extra below the threshold', async () => {
    // Data not held cannot leak.
    const ledger = await funded();
    const small = withdrawal({ valueSgd: 100 });
    expect(needsTravelRuleData(small)).toBe(false);
    await expect(requestWithdrawal(ledger, small, await sign(small), NOW)).resolves.toBeTruthy();
  });

  it('keeps owing the money until the payment confirms', async () => {
    const ledger = await funded();
    const req = withdrawal();
    await requestWithdrawal(ledger, req, await sign(req), NOW);
    const owedWhileInFlight = await ledger.allEntries('USDC');
    expect(
      owedWhileInFlight.reduce((n, e) => (e.account.startsWith('user:') ? n + e.amount : n), 0n),
    ).toBe(1_000_000_000n);

    await confirmWithdrawal(ledger, req, '0xout');
    const after = await ledger.allEntries('USDC');
    expect(after.reduce((n, e) => (e.account.startsWith('user:') ? n + e.amount : n), 0n)).toBe(
      900_000_000n,
    );
  });

  it('returns the money when the payment never happened', async () => {
    const ledger = await funded();
    const req = withdrawal();
    await requestWithdrawal(ledger, req, await sign(req), NOW);
    await abandonWithdrawal(ledger, req, 'broadcast failed');
    expect(await ledger.balance(userAccount(req.userId, 'USDC'))).toBe(1_000_000_000n);
  });
});

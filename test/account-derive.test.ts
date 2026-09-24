/**
 * Tests for the derived trading account.
 *
 * The property that matters is permanence: the same wallet and the same
 * message must produce the same account in three years, on another device, or
 * the customer's funds are stranded at an address nobody can reach. Everything
 * else here is about refusing to derive an account from something that is not
 * a signature, because a valid-looking address derived from junk is a black
 * hole with a copy button next to it.
 */

import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, type Hex } from 'viem';
import {
  ACCOUNT_DISCLOSURES,
  ACCOUNT_LABEL,
  AccountKeyring,
  DerivationError,
  accountAddress,
  accountMessage,
  canonicalSignature,
  deriveAccount,
} from '@/lib/account/derive';

const owner = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const other = privateKeyToAccount(
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
);

const signFor = (who: typeof owner) =>
  who.signMessage({ message: accountMessage(who.address) });

describe('deriving the account', () => {
  it('gives the same account every time, which is the whole promise', async () => {
    // Sign in on a new laptop in three years: same address, same funds.
    const signature = await signFor(owner);
    expect(accountAddress(signature)).toBe(accountAddress(signature));
    expect(deriveAccount(signature).address).toBe(deriveAccount(signature).address);
  });

  it('gives a different account to a different wallet', async () => {
    expect(accountAddress(await signFor(owner))).not.toBe(accountAddress(await signFor(other)));
  });

  it('is not the owner address', async () => {
    // The funding wallet and the trading account are different addresses; a
    // customer sending to their own wallet by mistake is the failure here.
    const signature = await signFor(owner);
    expect(accountAddress(signature)).not.toBe(owner.address);
  });

  it('changes completely if the label is ever versioned', async () => {
    // The only rotation available: v2 derives a different account, which is
    // why the label is a constant rather than a template.
    const signature = await signFor(owner);
    const v2 = await owner.signMessage({
      message: accountMessage(owner.address).replace(ACCOUNT_LABEL, 'Pathiel trading account v2'),
    });
    expect(accountAddress(v2)).not.toBe(accountAddress(signature));
  });

  it('refuses anything that is not a 65-byte signature', () => {
    // Deriving from junk yields a real address with no recoverable key — a
    // black hole with a copy button next to it.
    for (const bad of ['0x', '0xdeadbeef', `0x${'11'.repeat(64)}`, 'not hex'] as Hex[]) {
      expect(() => deriveAccount(bad)).toThrow(DerivationError);
    }
  });

  it('derives the key from the whole signature', async () => {
    // Pinned against the construction rather than restating it: the key is
    // keccak of the signature, so an implementation that hashed only part of
    // it, or salted it differently, would diverge here.
    const signature = await signFor(owner);
    expect(deriveAccount(signature).address).toBe(
      privateKeyToAccount(keccak256(signature)).address,
    );
  });
});

describe('one signature, whichever way a wallet writes it', () => {
  /**
   * The bug this prevents loses the money without looking like anything.
   * Two encodings of the same signature are the same authorisation; hashed
   * raw they gave two different accounts, so a customer who funded one and
   * later signed in through a different wallet or connector would find an
   * empty account and no explanation.
   */
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

  const withRawRecoveryId = (sig: Hex): Hex => {
    const tail = sig.slice(130);
    return (sig.slice(0, 130) + (tail === '1b' ? '00' : '01')) as Hex;
  };

  const withHighS = (sig: Hex): Hex => {
    const body = sig.slice(2);
    const s = N - BigInt(`0x${body.slice(64, 128)}`);
    const v = body.slice(128) === '1b' ? '1c' : '1b';
    return `0x${body.slice(0, 64)}${s.toString(16).padStart(64, '0')}${v}` as Hex;
  };

  it('derives the same account whether v is 27/28 or 0/1', async () => {
    const sig = (await signFor(owner)) as Hex;
    expect(accountAddress(withRawRecoveryId(sig))).toBe(accountAddress(sig));
  });

  it('derives the same account from the malleable form of the signature', async () => {
    // For every valid s there is an equivalent n − s with the recovery bit
    // flipped. Most wallets normalise; nothing obliges them to.
    const sig = (await signFor(owner)) as Hex;
    expect(accountAddress(withHighS(sig))).toBe(accountAddress(sig));
  });

  it('puts a signature into one canonical form', async () => {
    const sig = (await signFor(owner)) as Hex;
    const canonical = canonicalSignature(sig);
    expect(canonicalSignature(withRawRecoveryId(sig))).toBe(canonical);
    expect(canonicalSignature(withHighS(sig))).toBe(canonical);
    // Already canonical input is returned unchanged, lowercased.
    expect(canonicalSignature(canonical)).toBe(canonical);
    expect(canonical.slice(130)).toMatch(/^1b|1c$/);
  });

  it('refuses a recovery id it cannot interpret rather than guessing', async () => {
    // An EIP-155 style v, or a wallet doing something else entirely. Guessing
    // derives an account the customer can never return to.
    const sig = (await signFor(owner)) as Hex;
    const odd = (sig.slice(0, 130) + '25') as Hex;
    expect(() => deriveAccount(odd)).toThrow(/unexpected recovery id/);
  });

  it('refuses a smart-contract wallet signature instead of inventing an account', () => {
    // EIP-1271 validates rather than recovers; there is no key behind it.
    expect(() => deriveAccount('0xdead' as Hex)).toThrow(DerivationError);
  });
});

describe('what the customer is asked to sign', () => {
  it('names the owner, so one signature cannot serve another account', async () => {
    expect(accountMessage(owner.address)).toContain(owner.address);
  });

  it('says it moves no funds, and says who controls the account', () => {
    // A customer signing this is creating the thing that holds their money.
    const message = accountMessage(owner.address);
    expect(message).toContain('does not move any funds');
    expect(message).toContain('Anyone who obtains this signature controls that account');
  });

  it('states the three things that must be said before funding', () => {
    expect(ACCOUNT_DISCLOSURES).toHaveLength(3);
    expect(ACCOUNT_DISCLOSURES.join(' ')).toMatch(/cannot be rotated/);
    expect(ACCOUNT_DISCLOSURES.join(' ')).toMatch(/Withdrawing back to your own wallet/);
  });
});

describe('the keyring', () => {
  it('holds the account until it is locked', async () => {
    const keyring = new AccountKeyring();
    expect(keyring.unlocked).toBe(false);
    expect(keyring.current()).toBeNull();

    const signature = await signFor(owner);
    const account = keyring.unlock(signature);
    expect(keyring.unlocked).toBe(true);
    expect(keyring.current()?.address).toBe(account.address);

    keyring.lock();
    expect(keyring.unlocked).toBe(false);
    expect(keyring.current()).toBeNull();
  });

  it('re-derives the same account after locking', async () => {
    // Signing out forgets the key; it does not abandon the funds.
    const keyring = new AccountKeyring();
    const signature = await signFor(owner);
    const before = keyring.unlock(signature).address;
    keyring.lock();
    expect(keyring.unlock(signature).address).toBe(before);
  });

  it('never exposes the key through the public surface', () => {
    // The key must not be reachable by name from application code: what is
    // easy to read is easy to log, and a logged key is a drained account.
    const keyring = new AccountKeyring();
    expect(Object.keys(keyring)).not.toContain('privateKey');
    expect(JSON.stringify(keyring)).not.toMatch(/0x[0-9a-f]{64}/i);
  });
});

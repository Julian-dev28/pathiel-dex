/**
 * One account, derived from a signature, controlled by nobody else.
 *
 * This is the Hyperliquid shape without an exchange underneath it. The
 * customer signs one message with their own wallet; that signature
 * deterministically produces a keypair; they fund its address once and then
 * trade every chain and the perp venue from it without another popup. No
 * pooled wallet, no ledger of liabilities, no custody — the funds sit at an
 * address whose key only their wallet can reproduce.
 *
 * **It is permanent, not a session.** The same wallet signing the same message
 * yields the same key on any device, in any browser, in three years. "Session"
 * only describes how long the key is held in memory; the account outlives it.
 * The address is the same on Base, Robinhood Chain and X Layer, and doubles as
 * the Hyperliquid account.
 *
 * What the customer is trusting, stated plainly because they deserve to know
 * before they fund it:
 *
 *   - **The signature is the password, and it cannot be changed.** Anyone who
 *     obtains it derives the key forever. There is no rotation — only moving
 *     the funds to a new account under a new label (`ACCOUNT_LABEL` below,
 *     which is versioned for exactly that reason).
 *   - **The key lives in the page.** An XSS bug on this origin reaches the
 *     funds. It is held in memory, never written to storage, and discarded on
 *     sign-out, which narrows the window without closing it.
 *   - **It is a trading float, not a vault.** The right amount to keep here is
 *     what you intend to trade, and the withdrawal path back to the funding
 *     wallet is always open.
 *
 * The derivation deliberately mirrors what other terminals do rather than
 * inventing a scheme: hash the signature to get 32 bytes of entropy. The
 * signature over a fixed message is itself unpredictable to anyone without the
 * wallet, and hashing it removes any structure the curve might leak.
 */

import { keccak256, type Address, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

/**
 * The message that defines the account.
 *
 * Versioned, because the version is the only rotation available: if a
 * signature is ever exposed, `v2` derives a different account and the funds
 * are moved there. Changing any character of this text changes every
 * customer's address, so it is a constant rather than a template.
 */
export const ACCOUNT_LABEL = 'Pathiel trading account v1';

export function accountMessage(owner: Address): string {
  return [
    ACCOUNT_LABEL,
    '',
    `Owner: ${owner}`,
    '',
    'Signing this creates your trading account and lets this page sign trades',
    'for it without asking again. It does not move any funds.',
    '',
    'Anyone who obtains this signature controls that account. Do not sign this',
    'message on a site you do not trust, and do not share it.',
  ].join('\n');
}

export class DerivationError extends Error {}

/**
 * Derive the trading account from the owner's signature.
 *
 * The signature must be over `accountMessage(owner)` — the caller obtains it
 * from the wallet. Nothing here talks to a wallet, which keeps this pure and
 * testable, and keeps the one dangerous value out of a module that also does
 * network calls.
 */
export function deriveAccount(signature: Hex): PrivateKeyAccount {
  // A 65-byte signature. Anything else is a wallet returning a shape we did
  // not expect, and deriving an account from it would produce a valid-looking
  // address nobody can reach again.
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new DerivationError('expected a 65-byte signature to derive the account from');
  }
  return privateKeyToAccount(keccak256(signature));
}

/** The account's address, which is where the customer sends funds. */
export const accountAddress = (signature: Hex): Address => deriveAccount(signature).address;

/**
 * Hold the key for as long as the tab is open, and no longer.
 *
 * Deliberately not localStorage or sessionStorage: a key written to disk
 * outlives the tab, survives a crash into a browser profile backup, and is
 * readable by anything that can reach the origin later. Memory means a reload
 * asks for the signature again, which is the correct trade — one extra
 * signature against a key that is gone when the tab closes.
 */
export class AccountKeyring {
  private account: PrivateKeyAccount | null = null;

  unlock(signature: Hex): PrivateKeyAccount {
    this.account = deriveAccount(signature);
    return this.account;
  }

  /** The account, or null when this tab has not been unlocked. */
  current(): PrivateKeyAccount | null {
    return this.account;
  }

  /** Signing out forgets the key; the account and its funds are untouched. */
  lock(): void {
    this.account = null;
  }

  get unlocked(): boolean {
    return this.account !== null;
  }
}

/**
 * What the interface must tell someone before they fund this.
 *
 * Kept here, beside the derivation, so that the warning and the mechanism
 * cannot drift apart. A page that renders an account address without saying
 * these three things is asking for money under a misapprehension.
 */
export const ACCOUNT_DISCLOSURES = [
  'This account is derived from your signature. The same wallet and message always recreate it, on any device.',
  'Anyone who obtains that signature controls this account permanently — it cannot be rotated, only replaced.',
  'Keep here what you intend to trade. Withdrawing back to your own wallet is always available.',
] as const;

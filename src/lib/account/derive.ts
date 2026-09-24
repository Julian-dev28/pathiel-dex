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

/** The order of the secp256k1 curve; `s` above half of it has an equivalent below. */
const CURVE_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * The one signature, whichever way a wallet chose to write it.
 *
 * Two encodings of the same signature are the same authorisation, and hashing
 * them raw would give two different accounts — so the customer funds one,
 * signs in later through a different wallet or connector, and finds an empty
 * account while their money sits at an address this page no longer derives.
 * Nothing about it would look broken.
 *
 * Two ways that happens, both legal:
 *
 *   - **The recovery id.** Some wallets return 27/28 and some return 0/1.
 *   - **Malleability.** For every valid `s` there is an equivalent `n − s`
 *     with the recovery bit flipped. Most implementations normalise to the
 *     lower half; nothing obliges them to.
 *
 * So the signature is put in one form before it becomes a key: `v` as 27/28,
 * `s` in the lower half. Both encodings then derive the same account.
 */
export function canonicalSignature(signature: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new DerivationError('expected a 65-byte signature to derive the account from');
  }
  const body = signature.slice(2).toLowerCase();
  const r = body.slice(0, 64);
  let s = BigInt(`0x${body.slice(64, 128)}`);
  let v = parseInt(body.slice(128, 130), 16);

  if (v < 27) v += 27;
  if (v !== 27 && v !== 28) {
    // An EIP-155 style `v`, or a wallet doing something this cannot interpret.
    // Guessing would derive an account the customer can never return to.
    throw new DerivationError(`unexpected recovery id ${v} in the signature`);
  }
  if (s > CURVE_N / 2n) {
    s = CURVE_N - s;
    v = v === 27 ? 28 : 27;
  }
  return `0x${r}${s.toString(16).padStart(64, '0')}${v.toString(16).padStart(2, '0')}` as Hex;
}

/**
 * Derive the trading account from the owner's signature.
 *
 * The signature must be over `accountMessage(owner)` — the caller obtains it
 * from the wallet. Nothing here talks to a wallet, which keeps this pure and
 * testable, and keeps the one dangerous value out of a module that also does
 * network calls.
 *
 * A smart-contract wallet cannot produce a signature of this shape at all
 * (EIP-1271 validates rather than recovers), and is refused by the length
 * check rather than silently given an account nobody holds the key to.
 */
export function deriveAccount(signature: Hex): PrivateKeyAccount {
  return privateKeyToAccount(keccak256(canonicalSignature(signature)));
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

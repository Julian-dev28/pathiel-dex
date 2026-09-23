/**
 * Signing in with a wallet, and what that signature is allowed to mean.
 *
 * The customer proves control of an address by signing a message; that is the
 * whole of authentication here. There is no password to steal and no email to
 * reset, which removes a class of attacks and introduces a different one: a
 * signature is a bearer credential. Whoever holds it can present it. So the
 * message says who it is for, when it was issued, when it stops counting, and
 * carries a nonce that can only be used once.
 *
 * Follows EIP-4361 (Sign-In With Ethereum) rather than inventing a format.
 * Wallets render it legibly, users have seen it before, and — the reason that
 * matters — a message with a stated domain cannot be harvested by another site
 * and replayed here.
 *
 * Two things this deliberately does not do:
 *
 *   - **It does not authorise moving money.** A session proves who is asking.
 *     A withdrawal names a destination and an amount, and is signed
 *     separately; see `withdrawals.ts`. A stolen session should not be able to
 *     send funds anywhere, and here it cannot.
 *   - **It does not derive keys.** Nothing about this signature controls an
 *     address holding customer funds. Those live in the venue's segregated
 *     wallets, which is the point of the custodial model.
 */

import { verifyMessage, getAddress, isAddress, type Address } from 'viem';

/** How long a sign-in message stays valid. Long enough to read, short enough
 *  that one harvested from a log is worthless by the time it is used. */
export const SIGN_IN_TTL_MS = 5 * 60_000;

/** How long a session lasts before the customer signs again. */
export const SESSION_TTL_MS = 24 * 60 * 60_000;

export class AuthError extends Error {}

export type SignInRequest = {
  address: Address;
  /** Single use, issued by the server, and checked off when spent. */
  nonce: string;
  issuedAt: number;
  /** The host the customer is actually on. */
  domain: string;
  /** Chain the wallet is connected to, recorded but not trusted for anything. */
  chainId: number;
};

/**
 * The message the wallet renders.
 *
 * Plain text on purpose: the customer should be able to read exactly what they
 * are agreeing to, and "signing in" should not look like the same act as
 * authorising a payment. If these two ever render identically in a wallet, the
 * phishing writes itself.
 */
export function signInMessage(req: SignInRequest): string {
  const expiry = new Date(req.issuedAt + SIGN_IN_TTL_MS).toISOString();
  return [
    `${req.domain} wants you to sign in with your Ethereum account:`,
    req.address,
    '',
    'Signing in proves you control this address. It does not move any funds and',
    'does not authorise a withdrawal.',
    '',
    `URI: https://${req.domain}`,
    'Version: 1',
    `Chain ID: ${req.chainId}`,
    `Nonce: ${req.nonce}`,
    `Issued At: ${new Date(req.issuedAt).toISOString()}`,
    `Expiration Time: ${expiry}`,
  ].join('\n');
}

export type Session = {
  /** The customer id throughout the ledger: their checksummed address. */
  userId: string;
  address: Address;
  issuedAt: number;
  expiresAt: number;
};

/**
 * Nonces that have been issued and not yet spent.
 *
 * An interface because the storage belongs to the deployment, and because the
 * one property that matters — `spend` returns true at most once for a given
 * nonce, even when called concurrently — is a property of the store. An
 * implementation that reads then deletes has a race, and the race is a replay.
 */
export interface NonceStore {
  issue(address: Address): Promise<string>;
  /** True if this nonce was outstanding for this address, and now is not. */
  spend(address: Address, nonce: string): Promise<boolean>;
}

/**
 * Verify a signed sign-in and produce a session.
 *
 * Every check here has a specific attack behind it: the domain stops a
 * signature farmed on another site, the expiry stops an old one being kept,
 * the nonce stops the same one being used twice, and the address comparison is
 * checksum-insensitive because wallets disagree about casing and a user should
 * not be locked out by it.
 */
export async function verifySignIn(
  nonces: NonceStore,
  args: { request: SignInRequest; signature: `0x${string}`; expectedDomain: string; now?: number },
): Promise<Session> {
  const { request, signature, expectedDomain } = args;
  const now = args.now ?? Date.now();

  if (!isAddress(request.address)) throw new AuthError('not an address');
  if (request.domain !== expectedDomain) {
    throw new AuthError(`message was issued for ${request.domain}, not ${expectedDomain}`);
  }
  if (now - request.issuedAt > SIGN_IN_TTL_MS) throw new AuthError('sign-in message has expired');
  // A message from the future is either a clock problem or someone preparing
  // one to use later; neither should be accepted quietly.
  if (request.issuedAt - now > 60_000) throw new AuthError('sign-in message is not yet valid');

  const valid = await verifyMessage({
    address: request.address,
    message: signInMessage(request),
    signature,
  });
  if (!valid) throw new AuthError('signature does not match the address');

  // Spent last, and only after the signature checks out: a failed attempt must
  // not burn the nonce, or an attacker could lock a customer out by replaying
  // a malformed request.
  const fresh = await nonces.spend(request.address, request.nonce);
  if (!fresh) throw new AuthError('nonce was already used or never issued');

  const address = getAddress(request.address);
  return { userId: address, address, issuedAt: now, expiresAt: now + SESSION_TTL_MS };
}

export const isExpired = (session: Session, now = Date.now()): boolean => session.expiresAt <= now;

/**
 * An in-memory nonce store, for tests and local work.
 *
 * Single-process and forgetful, which is fine for a test and wrong for a
 * deployment: two instances would each accept the same nonce once. Production
 * needs one shared store with an atomic spend.
 */
export class MemoryNonces implements NonceStore {
  private outstanding = new Map<string, Set<string>>();

  async issue(address: Address): Promise<string> {
    const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
    const key = getAddress(address);
    const set = this.outstanding.get(key) ?? new Set();
    set.add(nonce);
    this.outstanding.set(key, set);
    return nonce;
  }

  async spend(address: Address, nonce: string): Promise<boolean> {
    const set = this.outstanding.get(getAddress(address));
    if (!set?.has(nonce)) return false;
    set.delete(nonce);
    return true;
  }
}

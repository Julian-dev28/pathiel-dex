/**
 * Hashing and comparing invite codes, on the server only.
 *
 * Split from `invite.ts` because the middleware that enforces the gate runs on
 * the Edge runtime, where Node's crypto does not exist. Only the redemption
 * endpoint needs to hash anything, and only it runs on Node.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { validInviteHashes } from './invite';

/** Hash of an invite code. Lowercased and trimmed first, since people retype them. */
export const hashInvite = (code: string): string =>
  createHash('sha256').update(code.trim().toLowerCase()).digest('hex');

/**
 * Is this code one of the invitations?
 *
 * Constant time against every candidate, and it deliberately does not stop at
 * the first match: an early return leaks, through timing, roughly where in the
 * list a code sits.
 */
export function checkInvite(code: string): boolean {
  const hashes = validInviteHashes();
  if (hashes.length === 0) return true;

  const offered = Buffer.from(hashSafe(code), 'hex');
  let matched = false;
  for (const candidate of hashes) {
    const expected = Buffer.from(hashSafe(candidate, true), 'hex');
    if (expected.length === offered.length && timingSafeEqual(expected, offered)) matched = true;
  }
  return matched;
}

/**
 * A hex hash of the right length, whatever was passed in.
 *
 * `timingSafeEqual` throws on a length mismatch, and a throw is itself a
 * signal — a malformed code would be distinguishable from a merely wrong one.
 */
function hashSafe(value: string, alreadyHashed = false): string {
  const hex = alreadyHashed ? value : hashInvite(value);
  return /^[0-9a-f]{64}$/.test(hex) ? hex : '0'.repeat(64);
}

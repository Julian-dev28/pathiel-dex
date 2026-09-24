/**
 * Invite-only access, enforced rather than announced.
 *
 * A beta that says "invite only" and lets anyone in has made a promise to its
 * users it is not keeping — and for software that derives keys in a browser,
 * limiting who can reach it is a safety measure as much as a marketing one.
 *
 * The scheme is deliberately small:
 *
 *   - Codes are held as **hashes**, never in plaintext, so a leaked
 *     configuration or a copy of the repository does not hand out access.
 *   - A code is compared in **constant time** (see `invite-server.ts`),
 *     because a comparison that returns early on the first wrong character
 *     tells an attacker how much of a guess was right.
 *   - Codes are **revocable**: removing a hash from the configuration removes
 *     that invitation, including for anyone already holding it.
 *
 * This half holds nothing but configuration and constants, because the
 * middleware that enforces the gate runs on the Edge runtime and cannot load
 * Node's crypto. The hashing lives in `invite-server.ts`, which only the API
 * route imports.
 *
 * What this is not: authentication. It says someone was invited, not who they
 * are, and nothing downstream should treat it as identity.
 */

/**
 * The invitations currently valid, as hashes.
 *
 * From the environment so that issuing and revoking is a deployment concern
 * rather than a code change. Unset means the gate is open, which is correct
 * for local development and wrong everywhere else — `isGated` is what a
 * deployment checks to be sure it did not ship with the door off the hinges.
 */
export const validInviteHashes = (): string[] =>
  (process.env.INVITE_CODE_HASHES ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

export const isGated = (): boolean => validInviteHashes().length > 0;

/** The cookie that remembers an accepted invitation on this device. */
export const INVITE_COOKIE = 'pathiel_invite';

/** How long access lasts before the code is asked for again. */
export const INVITE_TTL_SECONDS = 30 * 24 * 60 * 60;

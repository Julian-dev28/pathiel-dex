/**
 * Recording that someone accepted the terms, and which ones.
 *
 * Against a version rather than a boolean. A flag that says "accepted" keeps
 * saying it after the document changes, which leaves a person bound to
 * something they never read — so raising `LEGAL_VERSION` is what asks
 * everyone again, and that is the only mechanism that does.
 *
 * Kept in the browser because there is no account to store it against: this
 * product holds no user records, and inventing one to store a checkbox would
 * be the first row of a database it does not otherwise need.
 */

import { LEGAL_VERSION } from './legal';

const KEY = 'pathiel.terms';

/** The version this browser accepted, or null. */
export function acceptedVersion(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    // Storage blocked — private browsing, a strict setting. Treated as not
    // accepted, which asks again rather than assuming consent nobody gave.
    return null;
  }
}

/** Record acceptance of the current version, returning what was recorded. */
export function acceptTerms(): string {
  try {
    localStorage.setItem(KEY, LEGAL_VERSION);
  } catch {
    // Nothing to do: the checkbox still governs this session, and the next
    // visit will ask again.
  }
  return LEGAL_VERSION;
}

export const hasAcceptedCurrent = (): boolean => acceptedVersion() === LEGAL_VERSION;

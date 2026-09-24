/**
 * POST /api/invite — redeem an invitation.
 *
 * Checked on the server because a gate enforced in the browser is a
 * suggestion: the codes never reach the client, and neither does the list of
 * how many exist.
 *
 * The cookie it sets is a claim that someone was invited, nothing more. It is
 * not a session and grants no authority over funds — the account is derived
 * from a wallet signature and is unaffected by any of this.
 */

import { NextResponse } from 'next/server';
import { INVITE_COOKIE, INVITE_TTL_SECONDS, isGated } from '@/lib/invite';
import { checkInvite, hashInvite } from '@/lib/invite-server';
import { inviteLimit, clientKey } from '@/lib/serve';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  // Rate limited per client: a short code is guessable given enough attempts,
  // and the only thing standing between an attacker and every one of them is
  // how many tries they get.
  const limit = inviteLimit.check(clientKey(req));
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'too many attempts — wait a little' },
      { status: 429, headers: { 'retry-after': String(Math.ceil((limit.resetAt - Date.now()) / 1000)) } },
    );
  }

  const { code } = (await req.json().catch(() => ({}))) as { code?: string };
  if (typeof code !== 'string' || code.trim().length === 0) {
    return NextResponse.json({ error: 'enter your invite code' }, { status: 400 });
  }

  if (!checkInvite(code)) {
    // Deliberately identical whether the code is unknown, revoked or malformed.
    return NextResponse.json({ error: 'that code is not valid' }, { status: 403 });
  }

  const response = NextResponse.json({ ok: true, gated: isGated() });
  response.cookies.set({
    name: INVITE_COOKIE,
    // The hash, so a stolen cookie does not hand over a code that could be
    // shared, and so the server can revoke it by dropping the hash.
    value: hashInvite(code),
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: INVITE_TTL_SECONDS,
  });
  return response;
}

/**
 * The invite gate, applied before a page is served.
 *
 * In middleware rather than in a component because a gate rendered by the app
 * it is gating has already served the app. Here the request is redirected
 * before any page code runs.
 *
 * What stays open regardless: the invite screen itself, the legal documents,
 * and the endpoint that redeems a code. Someone deciding whether to accept the
 * terms should not have to be inside the product to read them, and a risk
 * disclosure behind a gate is a risk disclosure nobody read.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { INVITE_COOKIE, isGated, validInviteHashes } from '@/lib/invite';

/** Reachable without an invitation. */
const OPEN_PATHS = ['/invite', '/terms', '/privacy', '/risk'];

export function middleware(req: NextRequest) {
  if (!isGated()) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (OPEN_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    return NextResponse.next();
  }

  // Checked against the current list, so revoking an invitation takes effect
  // for people already holding the cookie rather than only for new ones.
  const held = req.cookies.get(INVITE_COOKIE)?.value;
  if (held && validInviteHashes().includes(held)) return NextResponse.next();

  const to = req.nextUrl.clone();
  to.pathname = '/invite';
  // Where they were going, so redeeming a code lands them there rather than
  // on the front page having forgotten why they came.
  to.searchParams.set('next', pathname);
  return NextResponse.redirect(to);
}

export const config = {
  /**
   * Everything except Next's own assets and the invite endpoint.
   *
   * The API is gated too: the pages are the product, but the endpoints are
   * where the RPC budget goes, and an ungated API is an open door with a
   * closed sign on it.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|api/invite).*)'],
};

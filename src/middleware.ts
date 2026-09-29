/**
 * The terms gate, applied before a page is served.
 *
 * In middleware rather than in a component because a gate rendered by the app
 * it is gating has already served the app. Here the request is redirected
 * before any page code runs.
 *
 * Checked against `LEGAL_VERSION`, so raising the version sends everyone back
 * through the gate to accept the new terms.
 *
 * What stays open regardless: the acceptance screen itself and the legal
 * documents. Someone deciding whether to accept the terms should not have to be
 * inside the product to read them.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { LEGAL_VERSION } from '@/lib/legal';
import { TERMS_COOKIE } from '@/lib/terms';

/** Reachable without accepting the terms. */
const OPEN_PATHS = ['/accept', '/terms', '/privacy', '/risk'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (OPEN_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    return NextResponse.next();
  }

  if (req.cookies.get(TERMS_COOKIE)?.value === LEGAL_VERSION) return NextResponse.next();

  const to = req.nextUrl.clone();
  to.pathname = '/accept';
  // Where they were going, so accepting lands them there rather than on the
  // front page having forgotten why they came.
  to.searchParams.set('next', pathname);
  return NextResponse.redirect(to);
}

export const config = {
  /**
   * Pages only. The API reads public chain state for programmatic clients,
   * which have no browser to click through a terms screen with.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt|sitemap.xml|api/).*)'],
};

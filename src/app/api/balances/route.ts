/**
 * GET /api/balances?address=0x…
 *
 * One address, everything it holds: every listed token it has a non-zero
 * balance of on each of the three chains, the gas token on each, and
 * Hyperliquid's margin summary and open positions for both the core universe
 * and the `xyz` equity dex.
 *
 * The spot side is grouped by canonical asset, so NVDA on Robinhood Chain,
 * NVDAc on Base and wNVDAx on X Layer arrive as one holding in three places.
 *
 * Read-only: nothing here needs a key, and nothing here signs anything. The
 * address is a parameter, not a session — anyone can ask about any address,
 * which is what a public chain means.
 */

import { NextResponse } from 'next/server';
import { getAddress, isAddress } from 'viem';
import { fetchAccount } from '@/lib/balances';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const address = new URL(req.url).searchParams.get('address') ?? '';

  // Checked before anything is called: a typo should cost nothing, and a
  // malformed address handed to an RPC comes back as an opaque failure.
  if (!isAddress(address, { strict: false })) {
    return NextResponse.json({ error: 'address is not a valid EVM address' }, { status: 400 });
  }

  try {
    const account = await fetchAccount(getAddress(address));
    return NextResponse.json(account, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'balance lookup failed' },
      { status: 500 },
    );
  }
}

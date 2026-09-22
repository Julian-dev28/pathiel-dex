/**
 * GET /api/health
 *
 * Liveness plus the two things that actually break in production: the RPC
 * endpoint going away, and the chain head going stale behind a cached or
 * lagging node. A health check that only returns `{ok: true}` from the web
 * process tells you the web process is up, which was never the question.
 */

import { NextResponse } from 'next/server';
import { client } from '@/lib/quote';
import { quoteCache } from '@/lib/serve';
import { CHAIN_LIST } from '@/lib/chain';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/** Base produces a block every two seconds, X Layer one, Robinhood Chain ten. */
const STALE_AFTER_SECONDS = 60;

async function probe(chain: (typeof CHAIN_LIST)[number]) {
  const started = Date.now();
  try {
    const block = await client(chain).getBlock();
    const ageSeconds = Math.floor(Date.now() / 1000 - Number(block.timestamp));
    const stale = ageSeconds > STALE_AFTER_SECONDS;
    return {
      chain: chain.key,
      status: stale ? ('degraded' as const) : ('ok' as const),
      chainId: chain.id,
      blockNumber: block.number.toString(),
      blockAgeSeconds: ageSeconds,
      rpcLatencyMs: Date.now() - started,
      tokens: chain.tokens.length,
      // Stated so a monitor can alert on the reason rather than on a bare
      // status string.
      detail: stale ? `chain head is ${ageSeconds}s old` : null,
    };
  } catch (e) {
    return {
      chain: chain.key,
      status: 'down' as const,
      chainId: chain.id,
      detail: e instanceof Error ? e.message.split('\n')[0] : 'rpc unreachable',
      rpcLatencyMs: Date.now() - started,
    };
  }
}

export async function GET() {
  const chains = await Promise.all(CHAIN_LIST.map(probe));
  // The worst chain sets the status: a router that cannot see one of its
  // chains is degraded, whichever chain it is.
  const status = chains.some((c) => c.status === 'down')
    ? 'down'
    : chains.some((c) => c.status === 'degraded')
      ? 'degraded'
      : 'ok';
  return NextResponse.json(
    { status, chains, cacheEntries: quoteCache.size },
    { status: status === 'ok' ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  );
}

/**
 * GET /api/plan?asset=NVDA&from=base&usd=1000[&wallet=0x…]
 *
 * Where to buy an asset, given where the money is. Every chain that lists it is
 * priced end to end — the crossing and the swap together — and ranked by units
 * received. See `src/lib/unified.ts` for why units rather than price.
 *
 * `wallet` is optional and only reaches the bridge, which wants an address to
 * quote for. Quotes do not depend on who is asking, so a neutral address stands
 * in when none is given; nothing is signed either way.
 */

import { NextResponse } from 'next/server';
import { isAddress, type Address } from 'viem';
import { isChainKey, DEFAULT_CHAIN, type ChainKey } from '@/lib/chain';
import { planBuy, edgeOverStayingBps, MIN_CROSSING_EDGE_BPS } from '@/lib/unified';
import { jsonSafe } from '@/lib/format';
import { TtlCache } from '@/lib/serve';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/** A bridge quote is a live offer, so this is short — long enough to coalesce
 *  the browser's keystrokes, not long enough to show a stale crossing. */
const planCache = new TtlCache<unknown>(10_000);

/** Stands in when no wallet is connected. Holds nothing, signs nothing. */
const NOBODY = '0x0000000000000000000000000000000000000001' as Address;

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const asset = params.get('asset');
  const from = params.get('from') ?? DEFAULT_CHAIN;
  const usd = Number(params.get('usd') ?? '1000');
  const wallet = params.get('wallet');

  if (!asset) return NextResponse.json({ error: 'asset is required' }, { status: 400 });
  if (!isChainKey(from)) return NextResponse.json({ error: `unknown chain: ${from}` }, { status: 400 });
  if (!Number.isFinite(usd) || usd <= 0) {
    return NextResponse.json({ error: 'usd must be a positive number' }, { status: 400 });
  }
  if (wallet && !isAddress(wallet)) {
    return NextResponse.json({ error: 'wallet is not an address' }, { status: 400 });
  }

  try {
    // The wallet is in the key because the response is not the same for every
    // caller: a bridge quote's steps carry that wallet's approve and deposit
    // calldata. Two addresses asking the same question ten seconds apart must
    // not be handed each other's transactions.
    const key = `plan:${asset.toUpperCase()}:${from}:${usd}:${wallet?.toLowerCase() ?? 'none'}`;
    const { value } = await planCache.get(key, async () => {
      const plans = await planBuy({
        wallet: (wallet as Address) ?? NOBODY,
        asset,
        fromChain: from as ChainKey,
        usdAmount: usd,
      });
      // A bridge quote carries the origin amount in base units, which is a
      // bigint and does not survive JSON on its own.
      const edgeBps = edgeOverStayingBps(plans, from as ChainKey);
      return jsonSafe({
        asset: asset.toUpperCase(),
        from,
        usd,
        /** How much better the best chain is than staying on `from`. */
        edgeBps,
        /** Below this, crossing is noise once gas is counted — and gas is not counted. */
        worthCrossing: edgeBps >= MIN_CROSSING_EDGE_BPS,
        plans,
      });
    });
    return NextResponse.json(value as object, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'planning failed';
    // An asset nobody lists, or one that is the dollar already in hand, is the
    // caller's mistake rather than a server fault.
    const status =
      message.startsWith('no listed asset') || message.includes('is the dollar you are holding')
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

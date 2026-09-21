/**
 * GET /api/quote?chain=robinhood&in=WETH&out=USDG&amount=1.5
 *
 * `chain` is `robinhood` (the default) or `base`.
 *
 * Runs the ladder, picks the route, prices the gas, and returns the whole
 * working — every venue's curve, not just the winner. A quote you cannot audit
 * is a quote you have to trust, and the point of this project is that you do
 * not have to.
 *
 * Server-side because public RPC endpoints rate-limit per IP and a browser
 * firing a laddered quote on every keystroke would be throttled within a
 * minute. Nothing secret lives here; the same calls work from anywhere.
 */

import { NextResponse } from 'next/server';
import { bySymbol, chainByKey } from '@/lib/chain';
import { toBase, jsonSafe } from '@/lib/format';
import { quoteLimit, clientKey, QUOTE_TTL_MS } from '@/lib/serve';
import { solveQuote } from '@/lib/solve';
import { log, metrics } from '@/lib/log';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/** Rejects absurd inputs before they reach the chain. */
const MAX_AMOUNT_DIGITS = 30;

export async function GET(req: Request) {
  const limit = quoteLimit.check(clientKey(req));
  metrics.inc('quote.requests');
  if (!limit.ok) {
    metrics.inc('quote.rate_limited');
    return NextResponse.json(
      { error: 'rate limit exceeded — slow down' },
      {
        status: 429,
        headers: {
          'retry-after': String(Math.ceil((limit.resetAt - Date.now()) / 1000)),
          'x-ratelimit-remaining': '0',
        },
      },
    );
  }

  const url = new URL(req.url);
  let chain;
  try {
    chain = chainByKey(url.searchParams.get('chain'));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const inSym = url.searchParams.get('in') ?? chain.weth.symbol;
  const outSym = url.searchParams.get('out') ?? chain.usd.symbol;
  const amountStr = (url.searchParams.get('amount') ?? '1').trim();

  try {
    if (amountStr.length > MAX_AMOUNT_DIGITS || !/^\d*\.?\d*$/.test(amountStr)) {
      return NextResponse.json({ error: 'amount is not a number' }, { status: 400 });
    }

    const tokenIn = bySymbol(inSym, chain);
    const tokenOut = bySymbol(outSym, chain);
    if (tokenIn.address === tokenOut.address) {
      return NextResponse.json({ error: 'tokenIn and tokenOut are the same' }, { status: 400 });
    }

    const amountIn = toBase(amountStr, tokenIn);
    if (amountIn <= 0n) {
      return NextResponse.json({ error: 'amount must be greater than zero' }, { status: 400 });
    }

    const started = Date.now();
    const { value, hit } = await solveQuote(tokenIn, tokenOut, amountIn);

    if (!value) {
      metrics.inc('quote.no_liquidity');
      return NextResponse.json(
        { error: `no liquidity found for ${inSym}/${outSym} on ${chain.name}` },
        { status: 404 },
      );
    }

    const elapsed = Date.now() - started;
    metrics.inc(hit ? 'quote.cache_hit' : 'quote.cache_miss');
    if (!hit) metrics.observeLatency(elapsed);

    return NextResponse.json(
      jsonSafe({
        ...(value as object),
        quotedAt: Date.now(),
        expiresAt: Date.now() + QUOTE_TTL_MS,
        latencyMs: elapsed,
        cached: hit,
      }),
      {
        headers: {
          'cache-control': 'no-store',
          'x-ratelimit-remaining': String(limit.remaining),
        },
      },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : 'quote failed';
    metrics.inc('quote.errors');
    log.error('quote.failed', { chain: chain.key, pair: `${inSym}/${outSym}`, amount: amountStr, message });
    // Unknown-token errors are the caller's fault, not ours, and returning 500
    // for them makes a typo look like an outage.
    const known = chain.tokens.some((t) => t.symbol === inSym) && chain.tokens.some((t) => t.symbol === outSym);
    return NextResponse.json({ error: message }, { status: known ? 500 : 400 });
  }
}

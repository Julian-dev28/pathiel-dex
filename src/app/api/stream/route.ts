/**
 * GET /api/stream?chain=robinhood&in=WETH&out=USDG&amount=1
 *
 * Server-sent events: a re-quote pushed every time the chain produces a block
 * that actually changes the answer.
 *
 * SSE rather than WebSockets because the traffic is one-directional — the
 * client has nothing to say back — and SSE reconnects on its own, travels over
 * plain HTTP, and needs no second protocol on the server. A WebSocket here
 * would be a heavier dependency doing strictly less.
 *
 * Two things make this survivable rather than a load generator:
 *
 *   Blocks are *coalesced*. Base produces a block every two seconds and
 *   Robinhood Chain ten a second; quoting
 *   every one of them for every open connection would be several RPC calls per
 *   second per viewer. Instead the stream re-quotes at most once per interval
 *   and skips entirely when nothing moved.
 *
 *   Identical quotes are *not* sent. A pool that has not traded returns the
 *   same number, and pushing it wakes the client's render loop for nothing.
 */

import { bySymbol, chainByKey } from '@/lib/chain';
import { client, quoteLadder, ladder, bestRoute } from '@/lib/quote';
import { hopCostInToken } from '@/lib/gas';
import { toBase, jsonSafe } from '@/lib/format';
import { clientKey, quoteLimit } from '@/lib/serve';
import { log } from '@/lib/log';

export const dynamic = 'force-dynamic';

/** Minimum gap between re-quotes, regardless of block rate. */
const MIN_INTERVAL_MS = 6_000;

/** Hard stop, so an abandoned tab cannot hold a connection forever. */
const MAX_DURATION_MS = 10 * 60_000;

export async function GET(req: Request) {
  const limit = quoteLimit.check(clientKey(req));
  if (!limit.ok) {
    return new Response('rate limit exceeded', { status: 429 });
  }

  const url = new URL(req.url);
  let chain;
  try {
    chain = chainByKey(url.searchParams.get('chain'));
  } catch {
    return new Response('unknown chain', { status: 400 });
  }
  const inSym = url.searchParams.get('in') ?? chain.weth.symbol;
  const outSym = url.searchParams.get('out') ?? chain.usd.symbol;
  const amountStr = url.searchParams.get('amount') ?? '1';

  let tokenIn, tokenOut, amountIn: bigint;
  try {
    tokenIn = bySymbol(inSym, chain);
    tokenOut = bySymbol(outSym, chain);
    amountIn = toBase(amountStr, tokenIn);
    if (amountIn <= 0n || tokenIn.address === tokenOut.address) {
      return new Response('bad pair or amount', { status: 400 });
    }
  } catch {
    return new Response('unknown token', { status: 400 });
  }

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const started = Date.now();
      let lastQuoteAt = 0;
      let lastPayload = '';
      let ticks = 0;

      send('open', { pair: `${inSym}/${outSym}`, amount: amountStr, minIntervalMs: MIN_INTERVAL_MS });

      const quoteNow = async (blockNumber: bigint) => {
        const [curves, hopCost] = await Promise.all([
          quoteLadder(tokenIn, tokenOut, ladder(amountIn, 8)),
          hopCostInToken(tokenOut),
        ]);
        if (curves.length === 0) {
          send('error', { message: 'no liquidity' });
          return;
        }
        const best = bestRoute(curves, amountIn, hopCost);
        const venue = best.single.allocations[0]?.venue;

        const payload = jsonSafe({
          blockNumber,
          amountOut: best.single.amountOut,
          splitOut: best.split.amountOut,
          venue: venue?.label ?? null,
          path: venue?.path.map((t) => t.symbol) ?? [],
          hops: venue?.hops.length ?? 0,
          chosen: best.chosen,
          edgeBps: best.edgeBps,
          netEdgeBps: best.netEdgeBps,
        });

        // Skip an unchanged quote: the block moved but the price did not, and
        // an identical push is a client re-render for nothing.
        //
        // The comparison deliberately excludes blockNumber. Including it makes
        // every payload unique — the block always advances — so the check never
        // fires and the stream pushes on every tick, which is the exact
        // behaviour it exists to prevent.
        // Built by hand rather than with JSON.stringify: these are bigints,
        // and stringify throws on them — which took the whole stream down and
        // turned every tick into an error frame.
        const fingerprint = [
          best.single.amountOut.toString(),
          best.split.amountOut.toString(),
          venue?.id ?? 'none',
          best.chosen,
        ].join('|');
        if (fingerprint === lastPayload) return;
        lastPayload = fingerprint;
        ticks++;
        send('quote', payload);
      };

      let unwatch = () => {};
      try {
        unwatch = client(chain).watchBlockNumber({
          emitOnBegin: true,
          // Polling faster than the re-quote interval buys nothing. Left to
          // the default, viem polls Robinhood Chain's 100ms blocks twice a
          // second per open stream.
          pollingInterval: MIN_INTERVAL_MS / 3,
          onBlockNumber: async (blockNumber) => {
            if (closed) return;
            if (Date.now() - started > MAX_DURATION_MS) {
              send('bye', { reason: 'max duration', ticks });
              closed = true;
              unwatch();
              try {
                controller.close();
              } catch {
                /* already closed */
              }
              return;
            }
            // Coalesce: at most one quote per interval no matter how many
            // blocks land, and no overlapping quotes if one runs long.
            if (Date.now() - lastQuoteAt < MIN_INTERVAL_MS) return;
            lastQuoteAt = Date.now();
            try {
              await quoteNow(blockNumber);
            } catch (e) {
              send('error', { message: e instanceof Error ? e.message.split('\n')[0] : 'quote failed' });
            }
          },
          onError: (e) => {
            send('error', { message: e.message.split('\n')[0] });
          },
        });
      } catch (e) {
        send('error', { message: e instanceof Error ? e.message : 'watch failed' });
      }

      // The client going away is the normal way this ends.
      req.signal.addEventListener('abort', () => {
        closed = true;
        unwatch();
        log.info('stream.closed', { pair: `${inSym}/${outSym}`, ticks, ms: Date.now() - started });
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      // Nginx and friends buffer streamed responses by default, which turns an
      // event stream into one long pause followed by everything at once.
      'x-accel-buffering': 'no',
    },
  });
}

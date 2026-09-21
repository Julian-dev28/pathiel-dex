/**
 * GET /api/cycles?chain=robinhood
 *
 * Arbitrage loops across the token graph: build a rate edge for every ordered
 * pair of liquid tokens, then look for a cycle whose rates multiply above one.
 *
 * The expensive part is the graph, not the search. Each edge is a real quote,
 * so the token set is deliberately small and the result is cached for a minute.
 * Widening the set is cubic in the triangle count and linear in RPC cost, and
 * the tokens left out are the ones with no depth to arbitrage anyway.
 */

import { NextResponse } from 'next/server';
import { bySymbol, chainByKey, type Token } from '@/lib/chain';
import { quoteLadder, bestRoute, client } from '@/lib/quote';
import { gasPriceWei } from '@/lib/gas';
import { findCycle, rankTriangles, type RateEdge } from '@/lib/cycle';
import { jsonSafe } from '@/lib/format';
import { clientKey, quoteLimit, TtlCache } from '@/lib/serve';
import { log, metrics } from '@/lib/log';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/** Notional each edge is quoted at, in USD. Small enough to be near mid. */
const NOTIONAL_USD = 250;

const cycleCache = new TtlCache<unknown>(60_000);

/** Run promises with a ceiling on concurrency, to stay inside RPC limits. */
async function pooled<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export async function GET(req: Request) {
  const limit = quoteLimit.check(clientKey(req));
  metrics.inc('cycles.requests');
  if (!limit.ok) return NextResponse.json({ error: 'rate limit exceeded' }, { status: 429 });

  let chain;
  try {
    chain = chainByKey(new URL(req.url).searchParams.get('chain'));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  try {
    const { value, hit } = await cycleCache.get(`graph:${chain.id}`, async () => {
      const started = Date.now();
      const tokens = chain.graphTokens.map((s) => bySymbol(s, chain));
      const usdc = chain.usd;
      const gasWei = await gasPriceWei(chain);
      const blockNumber = await client(chain).getBlockNumber();

      // Pass one: what is a unit of each token worth? Needed to quote every
      // edge at a comparable notional — an edge priced at "1 unit" would be
      // $2,500 of WETH against $1 of USDC and the rates would not be
      // comparable across the graph.
      const unitPrices = new Map<string, number>();
      unitPrices.set(usdc.symbol, 1);

      await pooled(
        tokens.filter((t) => t.symbol !== usdc.symbol),
        3,
        async (t) => {
          try {
            const one = 10n ** BigInt(t.decimals);
            const curves = await quoteLadder(t, usdc, [one]);
            if (curves.length === 0) return;
            const best = bestRoute(curves, one);
            unitPrices.set(t.symbol, Number(best.single.amountOut) / 10 ** usdc.decimals);
          } catch {
            /* token stays unpriced and drops out of the graph */
          }
        },
      );

      const priced = tokens.filter((t) => (unitPrices.get(t.symbol) ?? 0) > 0);

      // Pass two: one quote per ordered pair, at a comparable notional.
      const pairs: [Token, Token][] = [];
      for (const a of priced) for (const b of priced) if (a.symbol !== b.symbol) pairs.push([a, b]);

      const edges: RateEdge[] = [];

      await pooled(pairs, 4, async ([from, to]) => {
        const price = unitPrices.get(from.symbol)!;
        const units = NOTIONAL_USD / price;
        const amountIn = BigInt(Math.max(1, Math.floor(units * 10 ** from.decimals)));
        try {
          const curves = await quoteLadder(from, to, [amountIn]);
          if (curves.length === 0) return;
          const best = bestRoute(curves, amountIn);
          const venue = best.single.allocations[0]?.venue;
          if (!venue || best.single.amountOut === 0n) return;

          // Decimal-normalised rate: output units per input unit.
          const inHuman = Number(amountIn) / 10 ** from.decimals;
          const outHuman = Number(best.single.amountOut) / 10 ** to.decimals;
          if (!(inHuman > 0) || !(outHuman > 0)) return;

          // Gas as a fraction of the notional traversing this edge, so the
          // search can prefer a shorter loop without a separate penalty term.
          const gasEth = Number(gasWei * best.single.gasEstimate) / 1e18;
          const ethPrice = unitPrices.get('WETH') ?? 0;
          const gasUsd = gasEth * ethPrice;
          const gasFraction = NOTIONAL_USD > 0 ? gasUsd / NOTIONAL_USD : 0;

          edges.push({
            from,
            to,
            rate: outHuman / inHuman,
            venue: venue.label,
            hops: venue.hops.length,
            gasFraction: Math.min(0.5, Math.max(0, gasFraction)),
          });
        } catch {
          /* no route for this direction */
        }
      });

      const cycle = findCycle(priced, edges);
      const triangles = rankTriangles(priced, edges);

      return {
        chain: chain.key,
        blockNumber,
        notionalUsd: NOTIONAL_USD,
        tokens: priced.map((t) => t.symbol),
        prices: Object.fromEntries(unitPrices),
        edgeCount: edges.length,
        pairsAttempted: pairs.length,
        buildMs: Date.now() - started,
        /** The negative cycle, if Bellman-Ford found one. */
        cycle,
        /** Every triangle, ranked — including the near misses. */
        triangles,
      };
    });

    return NextResponse.json(jsonSafe({ ...(value as object), cached: hit }), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'cycle scan failed';
    metrics.inc('cycles.errors');
    log.error('cycles.failed', { message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

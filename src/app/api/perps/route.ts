/**
 * GET /api/perps?chain=xlayer
 *
 * The same assets from both sides: the perp market on Hyperliquid, and what a
 * unit costs right now in this router's pools on one chain.
 *
 * The two prices are not the same kind of fact and the response keeps them
 * apart. `spotUsd` is read from pool state over public RPC — the pool is the
 * price. `markUsd` is an oracle run by the HIP-3 dex's deployer, who also sets
 * that market's parameters. `basisBps` needs both, so it is null whenever the
 * asset has no listing on the chain being asked about.
 *
 * Quoting spot means a discovery pass and a ladder of multicalls per asset, so
 * the whole response is cached per chain. A minute is long next to a block and
 * short next to how fast a basis moves.
 */

import { NextResponse } from 'next/server';
import { formatUnits, parseUnits } from 'viem';
import { chainByKey, type ChainConfig, type Token } from '@/lib/chain';
import { quoteLadder, ladder, bestRoute } from '@/lib/quote';
import { unifiedAssets, listingOn } from '@/lib/assets';
import { fetchPerpMarkets, perpRows, STOCK_PERP_DEX } from '@/lib/perps';
import { TtlCache } from '@/lib/serve';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/** A trade big enough to be past the dust, small enough to price at the touch. */
const NOTIONAL = 1_000;

const perpCache = new TtlCache<unknown>(60_000);

/** What one unit costs on a chain, priced by selling the chain's dollar for it. */
async function spotPrice(token: Token, chain: ChainConfig): Promise<number | null> {
  if (token.symbol === chain.usd.symbol) return null;
  try {
    const amountIn = parseUnits(String(NOTIONAL), chain.usd.decimals);
    const curves = await quoteLadder(chain.usd, token, ladder(amountIn, 4));
    if (curves.length === 0) return null;
    const out = Number(formatUnits(bestRoute(curves, amountIn).single.amountOut, token.decimals));
    return out > 0 ? NOTIONAL / out : null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  let chain: ChainConfig;
  try {
    chain = chainByKey(new URL(req.url).searchParams.get('chain'));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  try {
    const { value } = await perpCache.get(`perps:${chain.id}`, async () => {
      const markets = await fetchPerpMarkets();
      const assets = new Map(unifiedAssets().map((a) => [a.symbol, a]));

      // The `xyz` book is 123 markets and this router lists a fifth of them.
      // The rest have no spot side to compare against on any chain, so they are
      // left to the perp venue. The core majors are carried deliberately and
      // stay in view whether or not there is a pool for them here.
      const shown = markets.filter((m) => m.dex !== STOCK_PERP_DEX || assets.has(m.symbol));

      // One quote per asset, not per market: the same symbol can trade on both
      // universes and the pool it is priced against is the same either way.
      const tokens: [string, Token][] = [];
      for (const symbol of new Set(shown.map((m) => m.symbol))) {
        const asset = assets.get(symbol);
        const token = asset && listingOn(asset, chain.key);
        if (token) tokens.push([symbol, token]);
      }
      const prices = await Promise.all(tokens.map(([, t]) => spotPrice(t, chain)));
      const spot = new Map<string, number>();
      tokens.forEach(([symbol], i) => {
        const p = prices[i];
        if (p !== null) spot.set(symbol, p);
      });

      return {
        chain: chain.key,
        quotedAt: Date.now(),
        stockMarkets: markets.filter((m) => m.dex === STOCK_PERP_DEX).length,
        rows: perpRows(shown, spot),
      };
    });

    return NextResponse.json(value as object, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'perp lookup failed' },
      { status: 500 },
    );
  }
}

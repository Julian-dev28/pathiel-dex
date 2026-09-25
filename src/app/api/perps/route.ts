/**
 * GET /api/perps
 *
 * The same assets from both sides: the perp market on Hyperliquid, and the
 * cheapest a unit costs right now in this router's pools anywhere it lists.
 *
 * The two prices are not the same kind of fact and the response keeps them
 * apart. `spotBuyUsd` is what buying NOTIONAL dollars of the token actually
 * returns from this router's pools — an executable price, inclusive of the
 * venue fee and the slippage at that size, not a pool mid. `markUsd` is an
 * oracle run by the HIP-3 dex's deployer, who also sets that market's
 * parameters. `vsSpotBuyBps` needs both, so it is null whenever the asset has
 * no listing on any chain this router routes over.
 *
 * Calling the difference a basis would be wrong by roughly a fee tier, which
 * on a 0.30% pool is larger than the premium itself — see `perpVsBuyBps`.
 *
 * There is no chain parameter, and that is the point: a buyer never picks the
 * chain, so a reader comparing against one chain would be comparing against a
 * price the router would not have given them. `spotChain` records which chain
 * each winning price came from.
 *
 * Quoting spot means a discovery pass and a ladder of multicalls per asset on
 * every chain that lists it, so the whole response is cached. A minute is long
 * next to a block and short next to how fast a basis moves.
 */

import { NextResponse } from 'next/server';
import { formatUnits, parseUnits } from 'viem';
import { CHAINS, type ChainConfig, type Token } from '@/lib/chain';
import { quoteLadder, ladder, bestRoute } from '@/lib/quote';
import { unifiedAssets, listingOn } from '@/lib/assets';
import { fetchPerpMarkets, perpRows, STOCK_PERP_DEX } from '@/lib/perps';
import { TtlCache } from '@/lib/serve';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * The size the comparison is drawn at.
 *
 * It has to be stated, because the answer depends on it: a bigger trade walks
 * further up the book and makes spot look worse against the perp. A thousand
 * dollars is a real trade on these pools rather than a dust probe that would
 * flatter them.
 */
const NOTIONAL = 1_000;

const perpCache = new TtlCache<unknown>(60_000);
/** A response carrying failed quotes is worth coalescing for seconds, not a minute. */
const FAILED_TTL_MS = 5_000;

/** What one unit costs on a chain, priced by selling the chain's dollar for it. */
/** Null when the asset is its own dollar, `failed` when the quote did not answer. */
const FAILED = Symbol('quote failed');

async function spotPrice(
  token: Token,
  chain: ChainConfig,
): Promise<number | null | typeof FAILED> {
  if (token.symbol === chain.usd.symbol) return null;
  try {
    const amountIn = parseUnits(String(NOTIONAL), chain.usd.decimals);
    const curves = await quoteLadder(chain.usd, token, ladder(amountIn, 4));
    if (curves.length === 0) return null;
    const out = Number(formatUnits(bestRoute(curves, amountIn).single.amountOut, token.decimals));
    return out > 0 ? NOTIONAL / out : null;
  } catch {
    // Not the same as "no pool here": this router lists the token on this
    // chain and the quote did not come back. Reported as such rather than as
    // an absence, and not cached for a minute as though it were settled.
    return FAILED;
  }
}

export async function GET() {
  try {
    const build = async () => {
      const markets = await fetchPerpMarkets();
      const assets = new Map(unifiedAssets().map((a) => [a.symbol, a]));

      // The `xyz` book is 123 markets and this router lists a fifth of them.
      // The rest have no spot side to compare against on any chain, so they are
      // left to the perp venue. The core majors are carried deliberately and
      // stay in view whether or not there is a pool for them here.
      const shown = markets.filter((m) => m.dex !== STOCK_PERP_DEX || assets.has(m.symbol));

      // Priced on every chain that lists it, and the cheapest wins — which is
      // the price a buyer would actually pay, since the router would send them
      // there. Asking which chain to compare against was asking the reader to
      // answer a question the router answers for them at the moment of trade.
      type Probe = { symbol: string; chain: ChainConfig; token: Token };
      const probes: Probe[] = [];
      for (const symbol of new Set(shown.map((m) => m.symbol))) {
        const asset = assets.get(symbol);
        if (!asset) continue;
        for (const listing of asset.listings) {
          const cfg = CHAINS[listing.chain];
          if (listing.token.symbol !== cfg.usd.symbol) {
            probes.push({ symbol, chain: cfg, token: listing.token });
          }
        }
      }

      const prices = await Promise.all(probes.map((p) => spotPrice(p.token, p.chain)));
      const spot = new Map<string, number>();
      const spotChain = new Map<string, string>();
      const failedFor = new Map<string, number>();
      probes.forEach((probe, i) => {
        const p = prices[i];
        if (p === FAILED) {
          failedFor.set(probe.symbol, (failedFor.get(probe.symbol) ?? 0) + 1);
          return;
        }
        if (p === null) return;
        const current = spot.get(probe.symbol);
        if (current === undefined || p < current) {
          spot.set(probe.symbol, p);
          spotChain.set(probe.symbol, probe.chain.key);
        }
      });
      // Only unquotable when nowhere answered: one chain failing while another
      // priced it is not an absence the reader needs to see.
      const unavailable = new Set(
        [...failedFor.keys()].filter((symbol) => !spot.has(symbol)),
      );

      return {
        quotedAt: Date.now(),
        spotChain: Object.fromEntries(spotChain),
        stockMarkets: markets.filter((m) => m.dex === STOCK_PERP_DEX).length,
        rows: perpRows(shown, spot, unavailable),
        unavailable: unavailable.size,
      };
    };

    const { value } = await perpCache.get('perps:any', build, (v) =>
      ((v as { unavailable?: number }).unavailable ?? 0) > 0 ? FAILED_TTL_MS : 60_000,
    );

    return NextResponse.json(value as object, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'perp lookup failed' },
      { status: 500 },
    );
  }
}

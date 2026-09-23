/**
 * The unified view, printed: one asset, every chain that lists it, and the perp.
 *
 *   npm run perps              # stocks listed on at least one chain
 *   npm run perps -- all       # every xyz market, listed here or not
 *
 * Spot prices come from this router's own quote path — pool state over public
 * RPC, the same numbers the app shows — and the perp mark comes from
 * Hyperliquid's HIP-3 `xyz` dex. The basis between them is the only figure here
 * that needs both, and it is the reason the two belong on one screen: the same
 * company, priced by a pool on three chains and by an oracle on a perp venue.
 *
 * Nothing is signed or sent. Every read is public.
 */

import { formatUnits, parseUnits } from 'viem';
import { CHAIN_LIST, CHAINS, type ChainKey } from '../src/lib/chain';
import { quoteLadder, ladder, bestRoute } from '../src/lib/quote';
import { unifiedAssets, listingOn } from '../src/lib/assets';
import { fetchPerpMarkets, perpVsBuyBps, annualisedFunding, STOCK_PERP_DEX } from '../src/lib/perps';

const showAll = process.argv[2] === 'all';
/** A trade big enough to be past the dust, small enough to price at the touch. */
const NOTIONAL = 1_000;

const markets = await fetchPerpMarkets();
const stocks = markets.filter((m) => m.dex === STOCK_PERP_DEX);
console.log(
  `${markets.length} perp markets: ${stocks.length} on ${STOCK_PERP_DEX}, ` +
    `${markets.length - stocks.length} core majors\n`,
);

const assets = unifiedAssets();
const bySymbol = new Map(assets.map((a) => [a.symbol, a]));

// The core majors are carried deliberately and stay in view whether or not the
// router lists them for spot; the stocks are shown when there is a spot side to
// compare against, unless asked for all of them.
const rows = markets
  .filter((m) => showAll || m.dex !== STOCK_PERP_DEX || bySymbol.has(m.symbol))
  .sort((a, b) => b.openInterestUsd - a.openInterestUsd);

/** What one unit costs on a chain, priced by selling the chain's dollar for it. */
async function spotPrice(symbol: string, chain: ChainKey): Promise<number | null> {
  const asset = bySymbol.get(symbol);
  const token = asset && listingOn(asset, chain);
  const cfg = CHAINS[chain];
  if (!token || token.symbol === cfg.usd.symbol) return null;
  try {
    const amountIn = parseUnits(String(NOTIONAL), cfg.usd.decimals);
    const curves = await quoteLadder(cfg.usd, token, ladder(amountIn, 4));
    if (curves.length === 0) return null;
    const out = Number(formatUnits(bestRoute(curves, amountIn).single.amountOut, token.decimals));
    return out > 0 ? NOTIONAL / out : null;
  } catch {
    return null;
  }
}

const head = ['asset', 'OI $m', 'perp $', ...CHAIN_LIST.map((c) => c.name), 'vs buy bp', 'fund %/yr'];
console.log(
  `${head[0].padEnd(9)}${head[1].padStart(8)}${head[2].padStart(10)}` +
    CHAIN_LIST.map((c) => c.name.padStart(16)).join('') +
    `${head[head.length - 2].padStart(10)}${head[head.length - 1].padStart(11)}`,
);

for (const m of rows.slice(0, showAll ? rows.length : 24)) {
  const prices = await Promise.all(CHAIN_LIST.map((c) => spotPrice(m.symbol, c.key)));
  // The basis is quoted against the deepest chain that answered, which for the
  // stocks is whichever of the three actually has the pool.
  const spot = prices.find((p) => p !== null) ?? null;
  const cells = prices.map((p) => (p === null ? '—' : p.toFixed(2)).padStart(16)).join('');
  const basis = spot === null ? '—' : perpVsBuyBps(m.markUsd, spot).toFixed(0);
  console.log(
    `${m.symbol.padEnd(9)}${(m.openInterestUsd / 1e6).toFixed(0).padStart(8)}` +
      `${m.markUsd.toFixed(2).padStart(10)}${cells}${basis.padStart(10)}` +
      `${(annualisedFunding(m) * 100).toFixed(1).padStart(11)}`,
  );
}

const listed = rows.filter((m) => bySymbol.has(m.symbol)).length;
console.log(
  `\n${listed} of ${stocks.length} ${STOCK_PERP_DEX} markets are also listed for spot here.`,
);

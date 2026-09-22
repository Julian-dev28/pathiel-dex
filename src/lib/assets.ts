/**
 * One asset, listed in several places.
 *
 * NVIDIA trades on all three chains and it is the same company each time, but
 * nothing in the token tables says so: it is `NVDA` on Robinhood Chain, `NVDAc`
 * on Base and `wNVDAx` on X Layer, three addresses with three symbols. A user
 * who wants NVDA exposure does not care which wrapper their chain happens to
 * use, and a perp on `NVDA` is the same underlying again.
 *
 * So the canonical symbol is derived from the listed symbol rather than stored:
 * a table mapping every wrapper to its underlying would be a second source of
 * truth that drifts the first time a token is added. The rules below are narrow
 * enough to be checked — `test/assets.test.ts` asserts that every listed token
 * on every chain resolves the way the table intends, which is what stops a new
 * listing from silently folding into the wrong asset.
 */

import { CHAIN_LIST, type ChainKey, type Token } from './chain';

/**
 * The asset a listed token represents.
 *
 *   wNVDAx -> NVDA    OKX wraps Backed's xStocks as w<TICKER>x
 *   NVDAc  -> NVDA    Coinbase's tokenised stocks are <TICKER>c
 *   xETH   -> ETH     OKX's wrapped majors are x<TICKER>
 *   WETH   -> ETH     wrapped native, on every chain that has one
 *   cbBTC  -> BTC     Coinbase's wrapped BTC
 *
 * Everything else is its own asset, including the staking derivatives: cbETH
 * and wstETH track ETH but are not redeemable for it on demand, and folding
 * them in would quote a basis against the wrong thing.
 *
 * The dollars stay distinct too. USDG, USDC and USD₮0 are separate issuers'
 * paper and trade against each other at a spread this router prices.
 */
export function canonical(symbol: string): string {
  // Ordered: the wrapper patterns are tighter than the bare-ticker ones.
  const xstock = /^w([A-Z0-9]{1,8})x$/.exec(symbol);
  if (xstock) return xstock[1];

  // A lowercase `c` after an uppercase ticker. `USDC` and `USDbC` end in an
  // uppercase C and are left alone, which is the point of matching case.
  const coinbaseStock = /^([A-Z]{1,6})c$/.exec(symbol);
  if (coinbaseStock) return coinbaseStock[1];

  if (symbol === 'WETH') return 'ETH';
  if (symbol === 'WOKB') return 'OKB';
  if (symbol === 'cbBTC') return 'BTC';

  const okxWrapped = /^x(BTC|ETH|SOL)$/.exec(symbol);
  if (okxWrapped) return okxWrapped[1];

  return symbol;
}

/** Where an asset can be traded on one chain. */
export type Listing = { chain: ChainKey; token: Token };

/** An asset and every chain this router lists it on. */
export type Asset = { symbol: string; listings: Listing[] };

/**
 * Every asset the router can trade, with the chains that list it.
 *
 * Ordered by how many chains carry it, then alphabetically: an asset listed
 * everywhere is the one a unified view should lead with.
 */
export function unifiedAssets(): Asset[] {
  const bySymbol = new Map<string, Listing[]>();
  for (const chain of CHAIN_LIST) {
    for (const token of chain.tokens) {
      const symbol = canonical(token.symbol);
      const listings = bySymbol.get(symbol) ?? [];
      listings.push({ chain: chain.key, token });
      bySymbol.set(symbol, listings);
    }
  }
  return [...bySymbol.entries()]
    .map(([symbol, listings]) => ({ symbol, listings }))
    .sort((a, b) => b.listings.length - a.listings.length || a.symbol.localeCompare(b.symbol));
}

/** The listing for one asset on one chain, if this router has one. */
export function listingOn(asset: Asset, chain: ChainKey): Token | undefined {
  return asset.listings.find((l) => l.chain === chain)?.token;
}

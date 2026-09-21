/**
 * One quote, end to end: ladder, route, gas, block.
 *
 * Shared by `/api/quote` and the MCP endpoint, so an agent and the trade page
 * are shown the same answer from the same cache rather than two
 * implementations that drift apart.
 */

import { chainOf, type Token } from './chain';
import { client, quoteLadder, ladder, bestRoute, interpolate, isMultiHop } from './quote';
import { hopCostInToken, gasPriceWei, GAS_PER_EXTRA_HOP } from './gas';
import { quoteCache } from './serve';

async function compute(tokenIn: Token, tokenOut: Token, amountIn: bigint) {
  const sizes = ladder(amountIn);
  // The block is read alongside the quotes rather than after them, so the
  // number reported is the height the prices belong to. Provenance is the
  // whole product here; "roughly now" is not good enough.
  const chain = chainOf(tokenIn);
  const gasWei = await gasPriceWei(chain);

  // The gas conversion does not depend on the route, so it goes out with
  // the ladder rather than after it. Awaiting it separately added a full
  // round trip to every quote.
  const [curves, blockNumber, hopCost] = await Promise.all([
    quoteLadder(tokenIn, tokenOut, sizes),
    client(chain).getBlockNumber(),
    hopCostInToken(tokenOut, gasWei),
  ]);

  if (curves.length === 0) return null;

  const best = bestRoute(curves, amountIn, hopCost);

  return {
    chain: { key: chain.key, id: chain.id, name: chain.name },
    tokenIn,
    tokenOut,
    amountIn,
    blockNumber,
    gas: {
      gasPriceWei: gasWei,
      gasPerExtraHop: GAS_PER_EXTRA_HOP,
      hopCostInOutputToken: hopCost,
      // A zero hop cost means the ETH→output conversion was unavailable,
      // not that gas is free. The UI must say which comparison it is
      // showing rather than presenting a pre-gas number as net.
      gasAdjusted: hopCost > 0n,
    },
    route: best,
    venues: curves.map((c) => ({
      venue: c.venue,
      gasEstimate: c.gasEstimate,
      amountOutAtFull: interpolate(c, amountIn),
      multiHop: isMultiHop(c.venue),
      rungs: c.rungs,
    })),
  };
}

export type Solved = NonNullable<Awaited<ReturnType<typeof compute>>>;

/** `value` is null when no venue on the tokens' chain has liquidity for the pair. */
export async function solveQuote(tokenIn: Token, tokenOut: Token, amountIn: bigint) {
  const key = `${tokenIn.chainId}:${tokenIn.symbol}:${tokenOut.symbol}:${amountIn}`;
  const { value, hit } = await quoteCache.get(key, () => compute(tokenIn, tokenOut, amountIn));
  return { value: value as Solved | null, hit };
}

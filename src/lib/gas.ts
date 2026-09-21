/**
 * Pricing gas in the output token, without a price API.
 *
 * Comparing a split route to a single route requires both sides in the same
 * unit, and the extra cost of splitting is denominated in ETH while the benefit
 * is denominated in whatever you are buying. The usual fix is a price oracle or
 * a CoinGecko key. Neither is necessary: the pools we already quote against are
 * themselves the ETH price. We ask them what the gas is worth.
 */

import { chainOf, type ChainConfig, type Token } from './chain';
import { parseAbi } from 'viem';
import { client } from './quote';
import { quoterV2Abi } from './abis';

const QUOTER = parseAbi(quoterV2Abi);

/**
 * Gas for one *additional* pool hop — the marginal cost of splitting, not the
 * cost of a whole swap.
 *
 * Measured at 69,589 in contracts/test/GasProfile.t.sol as the second of two
 * swaps on a mainnet fork; the first pays one-off warming costs the second does
 * not, and charging a full swap to every extra leg made splits look ~50k gas
 * worse than they are. Rounded up to 70,000.
 */
export const GAS_PER_EXTRA_HOP = 70_000n;

export async function gasPriceWei(chain: ChainConfig): Promise<bigint> {
  try {
    return await client(chain).getGasPrice();
  } catch {
    // Both chains are L2s with a fee floor; if the endpoint is unreachable, a
    // stale-but-plausible number beats failing the whole quote.
    return chain.fallbackGasWei;
  }
}

/**
 * ETH price in `token`, cached.
 *
 * This used to run a full route discovery — every factory, every fee tier, both
 * intermediates — to convert a fraction of a cent of gas into the output token.
 * That doubled the network cost of every quote to refine a number that changes
 * on the timescale of the ETH price, not the block. Now it asks the V3 tiers
 * directly and remembers the answer for a minute.
 *
 * Returns 0n when no WETH pool exists for the token, which makes the gas
 * adjustment a no-op rather than a wrong number; the API reports
 * `gasAdjusted: false` so the UI can say which comparison it is showing.
 */
const priceCache = new Map<string, { value: bigint; expires: number }>();
const PRICE_TTL_MS = 60_000;

async function wethPriceIn(token: Token, probeWei: bigint): Promise<bigint> {
  const chain = chainOf(token);
  // Uniswap V3 is the first deployment on every chain, and the one with the
  // deepest WETH pools.
  const uni = chain.v3[0];
  const key = `${chain.id}:${token.address.toLowerCase()}`;
  const hit = priceCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  let best = 0n;
  try {
    const results = await Promise.allSettled(
      uni.feeTiers.map((fee) =>
        client(chain).readContract({
          address: uni.quoter,
          abi: QUOTER,
          functionName: 'quoteExactInputSingle',
          args: [
            {
              tokenIn: chain.weth.address,
              tokenOut: token.address,
              amountIn: probeWei,
              fee,
              sqrtPriceLimitX96: 0n,
            },
          ],
        }),
      ),
    );
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const out = (r.value as unknown as [bigint])[0];
      if (out > best) best = out;
    }
  } catch {
    return 0n;
  }

  priceCache.set(key, { value: best, expires: Date.now() + PRICE_TTL_MS });
  return best;
}

/** What one extra hop costs, expressed in `tokenOut` base units. */
export async function hopCostInToken(tokenOut: Token, gasWei?: bigint): Promise<bigint> {
  const chain = chainOf(tokenOut);
  const price = gasWei ?? (await gasPriceWei(chain));
  const costWei = price * GAS_PER_EXTRA_HOP;
  if (costWei <= 0n) return 0n;

  if (tokenOut.address.toLowerCase() === chain.weth.address.toLowerCase()) return costWei;

  // Quote a thousand times the gas amount: a few cents of ETH rounds to zero
  // output on a 6-decimal token, so the ratio is taken at a size the pool can
  // actually express, then scaled back down.
  const probe = costWei * 1000n;
  const out = await wethPriceIn(tokenOut, probe);
  return out / 1000n;
}

/**
 * GET /api/analyze?chain=robinhood&in=WETH&out=USDG&amount=1&slippage=50
 *
 * Execution intelligence for a pair: what a slippage tolerance is actually
 * worth to an attacker, what tolerance the pair's own price movement justifies,
 * how much size it can absorb, how scattered its liquidity is, and whether a
 * two-venue round trip currently returns more than it costs.
 *
 * All of it falls out of quoting the pair in both directions. The forward
 * ladder is the one a quote needs anyway; the reverse ladder is the only extra
 * work, and it is what makes the arbitrage search possible at all.
 */

import { NextResponse } from 'next/server';
import { encodeFunctionData, decodeFunctionResult, parseAbi, type Address } from 'viem';
import { bySymbol, chainByKey, chainOf, MULTICALL3, type Token } from '@/lib/chain';
import { client, quoteLadder, ladder, analysisLadder, bestRoute, interpolate } from '@/lib/quote';
import { hopCostInToken, gasPriceWei, GAS_PER_EXTRA_HOP } from '@/lib/gas';
import {
  measureDriftEscalating,
  combineDrift,
  exposureAt,
  recommendSlippage,
  inclusionBlocks,
} from '@/lib/exposure';
import { findArb, capacityOf, fragmentation } from '@/lib/arb';
import { univ3FactoryAbi, multicall3Abi } from '@/lib/abis';
import { toBase, jsonSafe } from '@/lib/format';
import { clientKey, quoteLimit, TtlCache } from '@/lib/serve';
import { log, metrics } from '@/lib/log';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

const V3F = parseAbi(univ3FactoryAbi);
const MC3 = parseAbi(multicall3Abi);
const ZERO = '0x0000000000000000000000000000000000000000';

/** Impact budgets the capacity figures are reported against. */
const CAPACITY_BUDGETS_BPS = [10, 50, 100];

// Drift changes slowly and costs a log query, so it is cached far longer than a
// quote. Analysis is a research view, not a ticker.
const analyzeCache = new TtlCache<unknown>(20_000);

/**
 * The pool whose price series stands in for the pair's volatility.
 *
 * Uniswap V3 Swap events carry `sqrtPriceX96`, which is what makes drift
 * measurable from one log query. Tiers are tried deepest-first; the first that
 * has traded enough recently wins. A V2 pool would need its price reconstructed
 * from reserves per block, which is a great deal more work for a statistic.
 */
async function referencePools(a: Token, b: Token): Promise<Address[]> {
  const chain = chainOf(a);
  // Uniswap V3's pools: they emit the Swap event the drift is measured from.
  const factory = chain.v3[0].factory;
  const tiers = [500, 3000, 100, 10000];
  const res = (await client(chain).readContract({
    address: MULTICALL3,
    abi: MC3,
    functionName: 'aggregate3',
    args: [
      tiers.map((fee) => ({
        target: factory,
        allowFailure: true,
        callData: encodeFunctionData({
          abi: V3F,
          functionName: 'getPool',
          args: [a.address, b.address, fee],
        }),
      })),
    ],
  })) as readonly { success: boolean; returnData: `0x${string}` }[];

  // Every tier that exists, not the first. A factory returns an address for a
  // pool nobody has ever traded in, so "exists" and "has a price series" are
  // different questions and only the second one is useful here.
  const pools: Address[] = [];
  for (let i = 0; i < tiers.length; i++) {
    const r = res[i];
    if (!r?.success || r.returnData === '0x') continue;
    try {
      const pool = decodeFunctionResult({
        abi: V3F,
        functionName: 'getPool',
        data: r.returnData,
      }) as Address;
      if (pool !== ZERO) pools.push(pool);
    } catch {
      /* absent */
    }
  }
  return pools;
}

/**
 * Drift from whichever of these pools actually carries the price.
 *
 * Not the first that clears the bar — the *busiest*. Fee tiers for the same
 * pair differ enormously in use, and a near-dead tier with a trickle of dust
 * trades reports almost no movement. Taking the first passable one had DEGEN
 * looking calmer than ETH, which is not a plausible fact about a memecoin;
 * it was a fact about an abandoned pool.
 */
async function driftFromAny(pools: Address[], chain: ReturnType<typeof chainOf>) {
  if (pools.length === 0) return null;
  const measured = await Promise.all(pools.map((p) => measureDriftEscalating(p, chain)));
  return measured
    .filter((d): d is NonNullable<typeof d> => d !== null)
    .sort((a, b) => b.observations - a.observations)[0] ?? null;
}

export async function GET(req: Request) {
  const limit = quoteLimit.check(clientKey(req));
  metrics.inc('analyze.requests');
  if (!limit.ok) {
    return NextResponse.json({ error: 'rate limit exceeded' }, { status: 429 });
  }

  const url = new URL(req.url);
  let chain;
  try {
    chain = chainByKey(url.searchParams.get('chain'));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const WETH = chain.weth;
  const inSym = url.searchParams.get('in') ?? WETH.symbol;
  const outSym = url.searchParams.get('out') ?? chain.usd.symbol;
  const amountStr = (url.searchParams.get('amount') ?? '1').trim();
  const slippageBps = Number(url.searchParams.get('slippage') ?? '50');

  try {
    if (!/^\d*\.?\d*$/.test(amountStr)) {
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
    const key = `${chain.id}:${tokenIn.symbol}:${tokenOut.symbol}:${amountIn}:${slippageBps}`;

    const { value, hit } = await analyzeCache.get(key, async () => {
      const gasWei = await gasPriceWei(chain);

      // Forward and reverse ladders, the reference pool, and both gas
      // conversions all at once: none of them depends on another's result.
      const [forward, blockNumber, hopCostOut, directPools] = await Promise.all([
        // Spans above the trade so capacity can answer a question about sizes
        // the user did not ask for.
        quoteLadder(tokenIn, tokenOut, analysisLadder(amountIn)),
        client(chain).getBlockNumber(),
        hopCostInToken(tokenOut, gasWei),
        referencePools(tokenIn, tokenOut),
      ]);

      if (forward.length === 0) return null;

      const best = bestRoute(forward, amountIn, hopCostOut);
      const quotedOut = best.single.amountOut;
      const bestVenue = best.single.allocations[0]?.venue;

      // The reverse ladder is sized by what the forward leg actually produces,
      // so the arb search covers the range a real round trip would traverse.
      /**
       * Drift for the pair, falling back to the route's legs.
       *
       * Two traps here, both of which produced a confidently wrong number
       * before they were fixed.
       *
       * A pool *existing* is not the same as it having traded. The factory
       * returns an address for tiers nobody uses, so every candidate tier is
       * tried until one has a price series rather than taking the first that
       * resolves.
       *
       * And when the direct pair cannot be measured, the legs are only useful
       * if the leg carrying the *risky* asset is among them. Measuring
       * WETH/USDC and calling it DEGEN's volatility reported ETH's drift for a
       * memecoin and recommended an 8bp tolerance on it. If the risky leg
       * cannot be measured, this returns null and the caller falls back to the
       * conservative default — an unmeasured pair is exactly where a confident
       * number does the most damage.
       */
      const driftFor = async () => {
        const direct = await driftFromAny(directPools, chain);
        if (direct) return direct;

        // Both legs of the route the router would actually take, and the only
        // leg that does not exist is one whose token *is* WETH.
        //
        // The first version skipped any leg touching USDC on the grounds that
        // USDC is a "hub". But WETH/USDC moves about 4bp over an inclusion
        // window — it is a real risk leg, not a constant — so skipping it had
        // cbETH/USDC reporting cbETH's drift against ETH (0.01bp, quite true
        // and quite irrelevant) while ignoring the ETH/USD move that dominates
        // the trade.
        const needsInLeg = tokenIn.address !== WETH.address;
        const needsOutLeg = tokenOut.address !== WETH.address;

        const [a, b] = await Promise.all([
          needsInLeg ? referencePools(tokenIn, WETH).then((p) => driftFromAny(p, chain)) : Promise.resolve(null),
          needsOutLeg ? referencePools(WETH, tokenOut).then((p) => driftFromAny(p, chain)) : Promise.resolve(null),
        ]);

        // A leg we cannot measure means we know nothing about part of the
        // price. Better to say so than to report the half we happened to see.
        if (needsInLeg && !a) return null;
        if (needsOutLeg && !b) return null;

        return combineDrift(a, b);
      };

      const [reverse, drift, hopCostIn] = await Promise.all([
        quoteLadder(tokenOut, tokenIn, ladder(quotedOut, 10)),
        driftFor(),
        hopCostInToken(tokenIn, gasWei),
      ]);

      // Two swaps, so two full hops rather than one marginal one.
      const arbGas = hopCostIn * 2n * (102_000n / GAS_PER_EXTRA_HOP);
      const arb = findArb(forward, reverse, arbGas);

      const exposure = exposureAt(quotedOut, slippageBps);
      const recommendation = recommendSlippage(drift);
      const atRecommended = exposureAt(quotedOut, recommendation.recommendedBps);

      const deepest = forward.reduce((a, c) =>
        interpolate(c, amountIn) > interpolate(a, amountIn) ? c : a,
      );

      return {
        chain: chain.key,
        tokenIn,
        tokenOut,
        amountIn,
        blockNumber,
        quotedOut,
        bestVenue: bestVenue?.label ?? null,

        exposure: {
          ...exposure,
          atRecommended,
          /** What tightening to the recommendation takes off the table. */
          savedByTightening: exposure.exposure - atRecommended.exposure,
        },

        drift: drift
          ? { ...drift, inclusionBlocks: Number(inclusionBlocks(chain)) }
          : null,
        recommendation,

        capacity: CAPACITY_BUDGETS_BPS.map((budget) => {
          const c = capacityOf(deepest, budget);
          return { maxImpactBps: budget, venue: deepest.venue.label, ...c };
        }),

        fragmentation: {
          percent: fragmentation(
            best.split.allocations,
            bestVenue?.id ?? '',
            amountIn,
          ),
          venuesInSplit: best.split.allocations.length,
          venuesQuoted: forward.length,
        },

        arb,
      };
    });

    if (!value) {
      return NextResponse.json({ error: `no liquidity for ${inSym}/${outSym}` }, { status: 404 });
    }

    const elapsed = Date.now() - started;
    if (!hit) metrics.observeLatency(elapsed);

    return NextResponse.json(
      jsonSafe({ ...(value as object), latencyMs: elapsed, cached: hit }),
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : 'analysis failed';
    metrics.inc('analyze.errors');
    log.error('analyze.failed', { pair: `${inSym}/${outSym}`, message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

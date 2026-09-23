/**
 * Unit tests for the cross-chain comparison.
 *
 * No network: what is worth testing is the ranking and the reading of a bridge
 * quote, not that an HTTP call happens. The ranking is where a plausible-looking
 * mistake does real damage — sending a trade to the chain with the worse fill,
 * or letting a route that could not be priced sort to the top as if it were a
 * zero-cost answer.
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import { rankPlans, edgeOverStayingBps, MIN_CROSSING_EDGE_BPS, type Plan } from '@/lib/unified';
import { parseBridgeQuote, HL_CURRENCY } from '@/lib/bridge';
import { CHAINS, CHAIN_LIST, type ChainKey } from '@/lib/chain';

const plan = (chain: ChainKey, unitsOut: number, over: Partial<Plan> = {}): Plan => ({
  chain,
  bridge: null,
  token: CHAINS[chain].weth,
  spendUsd: 1000,
  unitsOut,
  effectivePriceUsd: unitsOut > 0 ? 1000 / unitsOut : 0,
  venue: 'Uniswap V3 0.05%',
  etaSeconds: 0,
  ...over,
});

describe('ranking one asset across three chains', () => {
  it('leads with the chain that hands over the most units', () => {
    const ranked = rankPlans([plan('base', 4.36), plan('robinhood', 4.37), plan('xlayer', 4.35)]);
    expect(ranked.map((p) => p.chain)).toEqual(['robinhood', 'base', 'xlayer']);
  });

  it('ranks on units received, not on the headline price', () => {
    // A crossing takes its cut before the pool sees the money, so two plans
    // spending "$1000" do not spend the same thing. Units are what is left.
    const local = plan('base', 4.3);
    const remote = plan('xlayer', 4.4, { spendUsd: 999.4, effectivePriceUsd: 227.1 });
    expect(rankPlans([local, remote])[0].chain).toBe('xlayer');
  });

  it('sorts an unpriceable chain last however good it looks', () => {
    const broken = plan('xlayer', 99, { unavailable: 'no pool on this chain' });
    const ranked = rankPlans([broken, plan('base', 1)]);
    expect(ranked[0].chain).toBe('base');
    expect(ranked[1].unavailable).toBe('no pool on this chain');
  });

  it('is stable when nothing can be priced at all', () => {
    const ranked = rankPlans([
      plan('xlayer', 0, { unavailable: 'no bridge route' }),
      plan('base', 0, { unavailable: 'no pool on this chain' }),
    ]);
    expect(ranked.map((p) => p.chain)).toEqual(['base', 'xlayer']);
  });

  it('measures the edge against staying put, not against the runner-up', () => {
    // The case that made the old runner-up measure wrong: the user's own chain
    // is last, so the gain from crossing is far larger than the gap between
    // the two chains they are not on.
    const ranked = rankPlans(
      [plan('robinhood', 100), plan('xlayer', 99.5), plan('base', 95)],
      'base',
    );
    expect(edgeOverStayingBps(ranked, 'base')).toBeCloseTo(526.3, 1);
  });

  it('reports no edge when the chain holding the money is already best', () => {
    const ranked = rankPlans([plan('base', 100), plan('robinhood', 99)], 'base');
    expect(edgeOverStayingBps(ranked, 'base')).toBe(0);
  });

  it('reports no edge when the origin chain could not be priced at all', () => {
    // Nothing honest to compare against: the user cannot stay put here.
    const ranked = rankPlans(
      [plan('robinhood', 100), plan('base', 0, { unavailable: 'no pool on this chain' })],
      'base',
    );
    expect(edgeOverStayingBps(ranked, 'base')).toBe(0);
    expect(edgeOverStayingBps([], 'base')).toBe(0);
  });

  it('stays put when two chains tie exactly', () => {
    // Stable sort would otherwise hand the tie to whichever chain the token
    // table happens to list first, and recommend paying a bridge for nothing.
    const ranked = rankPlans([plan('robinhood', 4.37), plan('xlayer', 4.37)], 'xlayer');
    expect(ranked[0].chain).toBe('xlayer');
    expect(edgeOverStayingBps(ranked, 'xlayer')).toBe(0);
  });

  it('does not call a sub-basis-point difference a reason to cross', () => {
    const ranked = rankPlans([plan('robinhood', 100.02), plan('base', 100)], 'base');
    expect(edgeOverStayingBps(ranked, 'base')).toBeLessThan(MIN_CROSSING_EDGE_BPS);
  });
});

describe('reading a bridge quote', () => {
  const from = { chain: 'base' as ChainKey, symbol: 'USDC' };
  const to = { chain: 'xlayer' as ChainKey, symbol: 'USDG' };

  it('works the cost out from the amounts, not from the rounded percentage', () => {
    // Relay's own percent here is '-0.07', which would read as 7bp. The real
    // haircut is 6.67bp and both amounts are in hand, so it is computed.
    const q = parseBridgeQuote(
      {
        details: {
          currencyIn: { amountFormatted: '1000.0' },
          currencyOut: { amountFormatted: '999.332982' },
          totalImpact: { percent: '-0.07' },
          timeEstimate: 2,
        },
      },
      from,
      to,
      1_000_000_000n,
    );
    expect(q?.costBps).toBeCloseTo(6.67, 2);
    expect(q?.etaSeconds).toBe(2);
    expect(q?.amountOutFormatted).toBe('999.332982');
  });

  it('falls back to the percentage when an amount cannot be read', () => {
    const q = parseBridgeQuote(
      {
        details: {
          currencyIn: { amountFormatted: 'n/a' },
          currencyOut: { amountFormatted: '999.4' },
          totalImpact: { percent: '-0.06' },
        },
      },
      from,
      to,
      1n,
    );
    expect(q?.costBps).toBeCloseTo(6, 6);
  });

  it('returns null when the crossing is not offered', () => {
    expect(parseBridgeQuote({ message: 'No routes found' }, from, to, 1n)).toBeNull();
    expect(parseBridgeQuote({ details: {} }, from, to, 1n)).toBeNull();
  });

  it('carries the origin transactions through', () => {
    const q = parseBridgeQuote(
      {
        details: {
          currencyIn: { amountFormatted: '100' },
          currencyOut: { amountFormatted: '99.9' },
          totalImpact: { percent: '-0.1' },
        },
        steps: [
          { id: 'approve', kind: 'transaction', items: [{ data: { to: '0xabc', data: '0x1', value: '0' } }] },
          { id: 'deposit', kind: 'transaction', items: [{ data: { to: '0xdef', data: '0x2', value: '0' } }] },
        ],
      },
      from,
      to,
      100n,
    );
    expect(q?.steps.map((s) => s.to)).toEqual(['0xabc', '0xdef']);
  });

  it('calls an unreadable cost unknown rather than free', () => {
    // The dangerous version of this bug renders 0bp: a crossing whose price
    // nobody could determine is not a crossing that costs nothing.
    const q = parseBridgeQuote(
      {
        details: {
          currencyIn: { amountFormatted: 'n/a' },
          currencyOut: { amountFormatted: 'n/a' },
          totalImpact: { percent: 'n/a' },
        },
      },
      from,
      to,
      100n,
    );
    expect(q?.costBps).toBeNull();
  });

  it('keeps the perp margin accounts distinct from each other', () => {
    // Sending stock-perp collateral to the core margin account would land the
    // money one transfer away from where the order needs it.
    expect(HL_CURRENCY.stockPerpMargin).not.toBe(HL_CURRENCY.corePerpMargin);
    expect(HL_CURRENCY.stockPerpMargin).not.toBe(HL_CURRENCY.spot);
  });
});

/**
 * planBuy itself, which had no test at all.
 *
 * Every piece of arithmetic in it — the bridged-versus-local branch, both unit
 * conversions, the price it reports — went unasserted, and that is how a
 * mis-measured edge and a wallet-crossing cache both shipped under a green
 * suite. The quoting and bridging are mocked; what is under test is the shape
 * of the answer, not the network.
 */
describe('planBuy', () => {
  const RATE: Record<string, number> = { robinhood: 228.0, base: 229.0, xlayer: 230.0 };

  beforeEach(() => {
    vi.resetModules();
    // Every crossing loses 10bp and lands in a second.
    vi.doMock('@/lib/bridge', () => ({
      bridgeQuote: vi.fn(async (_w, from, _t, to, amountIn: bigint) => ({
        from: { chain: from.key, symbol: from.usd.symbol },
        to: { chain: to.chain.key, symbol: to.token.symbol },
        amountIn,
        amountInFormatted: '1000',
        amountOutFormatted: '999',
        costBps: 10,
        etaSeconds: 1,
        steps: [],
      })),
    }));
    // Each chain sells its dollar for the asset at its own fixed rate.
    vi.doMock('@/lib/quote', () => ({
      ladder: (amount: bigint) => [amount],
      // The asset's decimals travel with the curve: NVDA is 8 decimals on Base
      // and 18 on the other two, so a mock that assumed one of them would rank
      // the chains by their token tables rather than by their prices.
      quoteLadder: vi.fn(async (usdToken: { chainId: number }, asset: { decimals: number }) => [
        { chainId: usdToken.chainId, decimals: asset.decimals },
      ]),
      bestRoute: (curves: { chainId: number; decimals: number }[], amountIn: bigint) => {
        const chain = CHAIN_LIST.find((c) => c.id === curves[0].chainId)!;
        const dollars = Number(amountIn) / 10 ** chain.usd.decimals;
        const units = dollars / RATE[chain.key];
        return {
          chosen: 'single',
          single: {
            amountOut: BigInt(Math.round(units * 10 ** curves[0].decimals)),
            allocations: [{ venue: { label: `${chain.name} pool` } }],
          },
          split: { amountOut: 0n, allocations: [] },
        };
      },
    }));
  });

  const run = async (fromChain: 'base' | 'robinhood' | 'xlayer') => {
    const { planBuy } = await import('@/lib/unified');
    return planBuy({
      wallet: '0x1111111111111111111111111111111111111111',
      asset: 'NVDA',
      fromChain,
      usdAmount: 1000,
    });
  };

  it('spends the full amount locally and the bridged amount elsewhere', async () => {
    const plans = await run('robinhood');
    const here = plans.find((p) => p.chain === 'robinhood')!;
    const away = plans.find((p) => p.chain === 'base')!;
    expect(here.bridge).toBeNull();
    expect(here.spendUsd).toBe(1000);
    // The crossing takes its cut before the pool sees the money.
    expect(away.bridge?.costBps).toBe(10);
    expect(away.spendUsd).toBe(999);
  });

  it('prices each chain at its own rate and ranks by units received', async () => {
    const plans = await run('base');
    expect(plans[0].chain).toBe('robinhood');
    expect(plans[0].unitsOut).toBeCloseTo(999 / 228, 6);
    expect(plans.map((p) => p.chain)).toEqual(['robinhood', 'base', 'xlayer']);
  });

  it('reports the all-in price against the dollars that left the wallet', async () => {
    // Not against the dollars that arrived: the bridge fee is part of what the
    // asset cost, and quoting 999/units would hide it.
    const plans = await run('base');
    const away = plans.find((p) => p.chain === 'robinhood')!;
    expect(away.effectivePriceUsd).toBeCloseTo(1000 / away.unitsOut, 6);
    expect(away.effectivePriceUsd).toBeGreaterThan(228);
  });

  it('refuses to plan a purchase of the dollar already being held', async () => {
    const { planBuy } = await import('@/lib/unified');
    await expect(
      planBuy({
        wallet: '0x1111111111111111111111111111111111111111',
        asset: 'USDC',
        fromChain: 'base',
        usdAmount: 1000,
      }),
    ).rejects.toThrow(/dollar you are holding/);
  });

  it('survives a size JavaScript would write in exponential notation', async () => {
    const { planBuy } = await import('@/lib/unified');
    const plans = await planBuy({
      wallet: '0x1111111111111111111111111111111111111111',
      asset: 'NVDA',
      fromChain: 'base',
      usdAmount: 1e-7,
    });
    // parseUnits rejects "1e-7" outright; the answer is a plan, not a 500.
    expect(plans.length).toBeGreaterThan(0);
  });
});

/**
 * Unit tests for the cross-chain comparison.
 *
 * No network: what is worth testing is the ranking and the reading of a bridge
 * quote, not that an HTTP call happens. The ranking is where a plausible-looking
 * mistake does real damage — sending a trade to the chain with the worse fill,
 * or letting a route that could not be priced sort to the top as if it were a
 * zero-cost answer.
 */

import { describe, it, expect } from 'vitest';
import { rankPlans, edgeOverNextBps, type Plan } from '@/lib/unified';
import { parseBridgeQuote, HL_CURRENCY } from '@/lib/bridge';
import { CHAINS, type ChainKey } from '@/lib/chain';

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

  it('measures the edge over the runner-up, ignoring dead chains', () => {
    const ranked = rankPlans([
      plan('base', 100),
      plan('robinhood', 99),
      plan('xlayer', 1000, { unavailable: 'no bridge route' }),
    ]);
    expect(edgeOverNextBps(ranked)).toBeCloseTo(101.01, 1);
  });

  it('reports no edge when there is nothing to compare against', () => {
    expect(edgeOverNextBps([plan('base', 4.3)])).toBe(0);
    expect(edgeOverNextBps([])).toBe(0);
  });
});

describe('reading a bridge quote', () => {
  const from = { chain: 'base' as ChainKey, symbol: 'USDC' };
  const to = { chain: 'xlayer' as ChainKey, symbol: 'USDG' };

  it('turns the impact percentage into a cost in basis points', () => {
    // Relay reports a haircut as a negative percentage; a cost is positive here.
    const q = parseBridgeQuote(
      {
        details: {
          currencyIn: { amountFormatted: '1000.0' },
          currencyOut: { amountFormatted: '999.4' },
          totalImpact: { percent: '-0.06' },
          timeEstimate: 2,
        },
      },
      from,
      to,
      1_000_000_000n,
    );
    expect(q?.costBps).toBeCloseTo(6, 6);
    expect(q?.etaSeconds).toBe(2);
    expect(q?.amountOutFormatted).toBe('999.4');
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

  it('survives an impact field that is not a number', () => {
    const q = parseBridgeQuote(
      {
        details: {
          currencyIn: { amountFormatted: '100' },
          currencyOut: { amountFormatted: '100' },
          totalImpact: { percent: 'n/a' },
        },
      },
      from,
      to,
      100n,
    );
    expect(q?.costBps).toBe(0);
  });

  it('keeps the perp margin accounts distinct from each other', () => {
    // Sending stock-perp collateral to the core margin account would land the
    // money one transfer away from where the order needs it.
    expect(HL_CURRENCY.stockPerpMargin).not.toBe(HL_CURRENCY.corePerpMargin);
    expect(HL_CURRENCY.stockPerpMargin).not.toBe(HL_CURRENCY.spot);
  });
});

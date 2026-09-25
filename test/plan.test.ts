/**
 * Tests for the one-account arithmetic.
 *
 * The thing being protected here is the promise the product makes: dollars in
 * the account are one balance, and which chain they sit on is the router's
 * problem. Every test below is a case where the old code either refused a trade
 * the account could afford, or planned one that would have failed at the first
 * transaction.
 */

import { describe, it, expect } from 'vitest';
import {
  PlanError,
  gasPayer,
  fromMicro,
  micro,
  planProblem,
  planSpend,
  planSummary,
  totalDollars,
  toMicroUsd,
  type DollarSide,
} from '@/lib/account/plan';

const side = (chain: DollarSide['chain'], usd: number, hasGas = true): DollarSide => ({
  chain,
  value: toMicroUsd(usd),
  hasGas,
});

describe('dollar units across chains', () => {
  it('leaves a six-decimal dollar alone', () => {
    expect(micro(1_500_000n, 6)).toBe(1_500_000n);
    expect(fromMicro(1_500_000n, 6)).toBe(1_500_000n);
  });

  // Not hypothetical for long: an 18-decimal dollar compared raw against USDC
  // would read as a trillion times the balance.
  it('scales an eighteen-decimal dollar both ways', () => {
    expect(micro(10n ** 18n, 18)).toBe(1_000_000n);
    expect(fromMicro(1_000_000n, 18)).toBe(10n ** 18n);
  });
});

describe('spending dollars that are not all in one place', () => {
  it('spends what is already there without crossing', () => {
    const plan = planSpend([side('base', 500), side('xlayer', 10)], 'base', toMicroUsd(100));
    expect(plan.here).toBe(toMicroUsd(100));
    expect(plan.legs).toEqual([]);
    expect(plan.short).toBe(0n);
  });

  // The case the old router refused outright: enough money, in two places.
  it('assembles a trade from two chains', () => {
    const plan = planSpend(
      [side('base', 60), side('xlayer', 60), side('robinhood', 0)],
      'base',
      toMicroUsd(100),
    );
    expect(plan.here).toBe(toMicroUsd(60));
    expect(plan.legs).toEqual([{ from: 'xlayer', value: toMicroUsd(40) }]);
    expect(plan.short).toBe(0n);
  });

  it('draws the largest holding first, to keep the crossings down', () => {
    const plan = planSpend(
      [side('base', 0), side('xlayer', 30), side('robinhood', 80)],
      'base',
      toMicroUsd(100),
    );
    expect(plan.legs).toEqual([
      { from: 'robinhood', value: toMicroUsd(80) },
      { from: 'xlayer', value: toMicroUsd(20) },
    ]);
    expect(plan.short).toBe(0n);
  });

  it('reports exactly what is missing rather than refusing to plan', () => {
    const plan = planSpend([side('base', 20), side('xlayer', 30)], 'base', toMicroUsd(100));
    expect(plan.short).toBe(toMicroUsd(50));
    expect(planProblem(plan, toMicroUsd(100))).toContain('holds $50.00');
  });
});

describe('gas, which the account buys for itself', () => {
  const reserve = (from: DollarSide['chain'], usd: number) => ({
    chain: 'base' as const,
    from,
    value: toMicroUsd(usd),
  });

  // The whole reason this module exists. A deposit of dollars and nothing else
  // left every chain unsignable, so the router refused every trade.
  it('plans a trade on a chain it cannot yet sign on, once gas is paid for', () => {
    const plan = planSpend(
      [side('base', 0, false), side('xlayer', 500)],
      'base',
      toMicroUsd(100),
      reserve('xlayer', 5),
    );
    expect(plan.gas).toEqual(reserve('xlayer', 5));
    expect(plan.legs).toEqual([{ from: 'xlayer', value: toMicroUsd(100) }]);
    expect(plan.short).toBe(0n);
  });

  // Spending the gas dollars twice is the failure that costs real money: every
  // earlier transaction lands and the last one reverts.
  it('does not let the gas dollars be spent on the trade as well', () => {
    const plan = planSpend(
      [side('base', 0, false), side('xlayer', 100)],
      'base',
      toMicroUsd(100),
      reserve('xlayer', 5),
    );
    expect(plan.legs).toEqual([{ from: 'xlayer', value: toMicroUsd(95) }]);
    expect(plan.short).toBe(toMicroUsd(5));
  });

  it('buys nothing when the destination can already pay its own way', () => {
    expect(planSpend([side('base', 500)], 'base', toMicroUsd(100)).gas).toBeNull();
  });

  // Whoever pays is a chain that can sign, and the biggest one is likeliest to
  // afford both the gas and its share of the trade.
  it('charges the gas to the largest holding that can sign', () => {
    const sides = [side('base', 0, false), side('robinhood', 500), side('xlayer', 10)];
    expect(gasPayer(sides, 'base')).toBe('robinhood');
  });

  it('has nobody to charge when no chain can sign anything', () => {
    const sides = [side('base', 100, false), side('xlayer', 100, false)];
    expect(gasPayer(sides, 'base')).toBeNull();
  });

  // The caller must have planned the gas. Silently planning a trade on a chain
  // that cannot sign would fail on the swap after the crossings had landed.
  it('refuses a gasless destination with no gas planned', () => {
    expect(() => planSpend([side('base', 0, false), side('xlayer', 100)], 'base', toMicroUsd(50)))
      .toThrow(PlanError);
  });

  it('refuses a reserve the payer cannot cover', () => {
    expect(() =>
      planSpend([side('base', 0, false), side('xlayer', 2)], 'base', toMicroUsd(50), reserve('xlayer', 5)),
    ).toThrow(PlanError);
  });

  // Dollars on a gasless chain are not spendable from, however many there are,
  // because the bridge out has to be signed there too.
  it('will not draw a leg from a chain it cannot sign on', () => {
    const plan = planSpend(
      [side('base', 10), side('xlayer', 1_000, false)],
      'base',
      toMicroUsd(100),
    );
    expect(plan.legs).toEqual([]);
    expect(plan.short).toBe(toMicroUsd(90));
    expect(plan.stranded).toBe(toMicroUsd(1_000));
    expect(planProblem(plan, toMicroUsd(100))).toContain('no gas to move it');
  });
});

describe('what the customer is told', () => {
  it('adds the account up as one balance', () => {
    expect(totalDollars([side('base', 60), side('xlayer', 40.5, false)])).toBe(toMicroUsd(100.5));
  });

  it('names every part of the plan', () => {
    const plan = planSpend([side('base', 0, false), side('xlayer', 500)], 'base', toMicroUsd(100), {
      chain: 'base',
      from: 'xlayer',
      value: toMicroUsd(5),
    });
    const summary = planSummary(plan);
    expect(summary).toContain('crossing from X Layer');
    expect(summary).toContain('ETH bought so Base can pay its own gas');
  });

  it('has no problem to report when the plan covers the trade', () => {
    const plan = planSpend([side('base', 500)], 'base', toMicroUsd(100));
    expect(planProblem(plan, toMicroUsd(100))).toBeNull();
  });

  it('refuses a trade for nothing', () => {
    expect(() => planSpend([side('base', 10)], 'base', 0n)).toThrow(PlanError);
  });
});

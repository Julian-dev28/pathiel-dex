/**
 * One account's dollars, wherever they happen to sit.
 *
 * The account is a single balance as far as the customer is concerned, and the
 * three chains it spans are an implementation detail of the routing. This module
 * is the arithmetic that keeps that promise: given what the account holds on
 * every chain and a trade it wants to make somewhere, it says which dollars move
 * and what has to happen before they can.
 *
 * Two facts make this harder than adding up balances, and both are handled here
 * rather than shown to the customer:
 *
 *  1. **Dollars do not pool by themselves.** $60 on Base and $60 on X Layer is
 *     $120 in the account and $60 on either chain. A $100 trade has to draw on
 *     both, so a plan is a list of legs, not a source.
 *  2. **A chain cannot be spent from without its own gas.** An account holding
 *     dollars on a chain with no native balance cannot sign anything there — not
 *     a swap, not even the bridge out. Those dollars are stranded until gas
 *     arrives, and calling them spendable would produce a plan that fails at the
 *     first transaction.
 *
 * Everything is measured in millionths of a dollar. Every chain's dollar happens
 * to carry six decimals today, but comparing raw balances across chains is the
 * kind of thing that silently works until someone lists an 18-decimal dollar, so
 * the conversion is explicit at both ends.
 */

import { CHAINS, type ChainKey } from '../chain';

/** Millionths of a dollar: the unit every figure in this module is in. */
export const micro = (amount: bigint, decimals: number): bigint =>
  decimals === 6
    ? amount
    : decimals > 6
      ? amount / 10n ** BigInt(decimals - 6)
      : amount * 10n ** BigInt(6 - decimals);

/** Back to a chain's own dollar units, for building a transaction. */
export const fromMicro = (value: bigint, decimals: number): bigint =>
  decimals === 6
    ? value
    : decimals > 6
      ? value * 10n ** BigInt(decimals - 6)
      : value / 10n ** BigInt(6 - decimals);

export const usdOf = (value: bigint): number => Number(value) / 1e6;
export const toMicroUsd = (usd: number): bigint => BigInt(Math.round(usd * 1e6));

/** What the account holds on one chain, and whether it can act there. */
export type DollarSide = {
  chain: ChainKey;
  /** Spendable dollars, in millionths. */
  value: bigint;
  /** Enough native currency to sign a transaction on this chain. */
  hasGas: boolean;
};

/**
 * Dollars set aside to buy gas for a chain the account cannot act on.
 *
 * The amount is quoted, not guessed. Native currencies have prices and a
 * constant here would be a stale one — so the caller asks the bridge what it
 * costs to deliver the chain's gas floor and passes the answer in. This module
 * only has to know that those dollars are spoken for and cannot also be spent
 * on the trade.
 */
export type GasReserve = { chain: ChainKey; from: ChainKey; value: bigint };
/** Dollars crossing from one chain to the trade's chain. */
export type Leg = { from: ChainKey; value: bigint };

export type SpendPlan = {
  destination: ChainKey;
  /** Dollars already on the destination that the trade will spend. */
  here: bigint;
  /** Crossings needed to make up the rest, largest first. */
  legs: Leg[];
  /** Gas the destination needs before it can swap, and who pays for it. */
  gas: GasReserve | null;
  /** What the account could not assemble. Zero when the plan covers the trade. */
  short: bigint;
  /** Dollars sitting on chains with no gas, which no plan can reach yet. */
  stranded: bigint;
};

export class PlanError extends Error {}

/**
 * How to spend `need` dollars on `destination`.
 *
 * Sources are drawn largest first, which keeps the number of crossings down: a
 * trade assembled from one chain costs one bridge fee and one wait, and every
 * extra leg adds both. The destination's own dollars are always used before any
 * crossing, because they are free to spend.
 *
 * Bridge fees are not subtracted here. A leg is sized to what leaves, and what
 * arrives is whatever the solver delivers — which the executor reads off the
 * chain rather than predicting. Planning against a predicted arrival would mean
 * every plan is slightly wrong in the direction of a failed swap.
 */
export function planSpend(
  sides: DollarSide[],
  destination: ChainKey,
  need: bigint,
  gas: GasReserve | null = null,
): SpendPlan {
  if (need <= 0n) throw new PlanError('a trade needs a positive amount');
  const dest = sides.find((s) => s.chain === destination);
  if (!dest) throw new PlanError(`${destination} is not a chain this account holds`);
  if (!dest.hasGas && gas === null) {
    throw new PlanError(
      `this account cannot sign anything on ${destination} and no gas was planned for it`,
    );
  }

  // The gas dollars are spent, not lent: whoever is buying it has that much
  // less to put into the trade, and a plan that spends them twice fails on its
  // last transaction after every earlier one has already cost money.
  const available = new Map(sides.map((s) => [s.chain, s.value]));
  if (gas) {
    const payer = available.get(gas.from) ?? 0n;
    if (payer < gas.value) {
      throw new PlanError(`${gas.from} cannot cover the gas ${destination} needs`);
    }
    available.set(gas.from, payer - gas.value);
  }

  const here = (available.get(destination) ?? 0n) < need ? (available.get(destination) ?? 0n) : need;
  let remaining = need - here;

  const funded = sides
    .filter((s) => s.chain !== destination && s.hasGas && (available.get(s.chain) ?? 0n) > 0n)
    .sort((a, b) => {
      const av = available.get(a.chain) ?? 0n;
      const bv = available.get(b.chain) ?? 0n;
      return bv > av ? 1 : bv < av ? -1 : 0;
    });

  const legs: Leg[] = [];
  for (const side of funded) {
    if (remaining <= 0n) break;
    const spendable = available.get(side.chain) ?? 0n;
    const take = spendable < remaining ? spendable : remaining;
    legs.push({ from: side.chain, value: take });
    remaining -= take;
  }

  return {
    destination,
    here,
    legs,
    gas,
    short: remaining,
    stranded: sides
      .filter((s) => !s.hasGas && s.chain !== destination)
      .reduce((total, s) => total + s.value, 0n),
  };
}

/**
 * Who buys the gas for a chain the account cannot act on.
 *
 * The largest holding that can actually sign, because it is the one most likely
 * to afford both the gas and its share of the trade. Null when no chain can
 * sign at all — an account funded with dollars and nothing else, which cannot
 * move its own money until something sends it a little native currency.
 */
export function gasPayer(sides: DollarSide[], destination: ChainKey): ChainKey | null {
  const funded = sides
    .filter((s) => s.chain !== destination && s.hasGas && s.value > 0n)
    .sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  return funded[0]?.chain ?? null;
}

/** Everything the account holds, as one number — what the customer thinks they have. */
export const totalDollars = (sides: DollarSide[]): bigint =>
  sides.reduce((total, s) => total + s.value, 0n);

/**
 * Why a trade cannot be made, in the customer's terms.
 *
 * Three different failures read identically as "insufficient funds" and only
 * one of them is solved by depositing more, so they are named apart. Null when
 * the plan works.
 */
export function planProblem(plan: SpendPlan, need: bigint): string | null {
  if (plan.short <= 0n) return null;
  const reachable = need - plan.short;
  if (plan.stranded >= plan.short) {
    return `$${usdOf(plan.stranded).toFixed(2)} of this account is on a chain with no gas to move it. Top up gas there, or trade $${usdOf(reachable).toFixed(2)} or less.`;
  }
  return `this account holds $${usdOf(reachable + plan.stranded).toFixed(2)}, and the trade needs $${usdOf(need).toFixed(2)}`;
}

/** The plan as a sentence, so the customer can see what was decided for them. */
export function planSummary(plan: SpendPlan): string {
  const name = (k: ChainKey) => CHAINS[k].name;
  const parts: string[] = [];
  if (plan.here > 0n) parts.push(`$${usdOf(plan.here).toFixed(2)} already on ${name(plan.destination)}`);
  for (const leg of plan.legs) {
    parts.push(`$${usdOf(leg.value).toFixed(2)} crossing from ${name(leg.from)}`);
  }
  if (plan.gas) {
    parts.push(
      `$${usdOf(plan.gas.value).toFixed(2)} of ${CHAINS[plan.gas.chain].viem.nativeCurrency.symbol} bought so ${name(plan.gas.chain)} can pay its own gas`,
    );
  }
  return parts.join(', ');
}

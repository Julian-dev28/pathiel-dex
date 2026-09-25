/**
 * Buy an asset out of one account. The chains are the router's problem.
 *
 * The customer holds dollars in one account and wants NVDA. Everything after
 * that sentence is arithmetic: which chain prices it best, which of the
 * account's dollars are nearest, what a crossing costs, and whether the account
 * can even pay for a transaction where the trade has to happen.
 *
 * Three things this does that a per-chain router cannot, and which are the
 * reason it exists:
 *
 *  1. **It spends the whole account.** $60 on Base and $60 on X Layer buys a
 *     $100 position. A router that picks one source chain refuses that trade
 *     while telling the customer they have $120.
 *  2. **It buys its own gas.** An account funded with dollars and nothing else
 *     cannot sign a transaction anywhere, so the first trade would be
 *     impossible. Where the destination has no native balance, the plan buys
 *     some with the account's own dollars before anything else happens.
 *  3. **It ranks on what arrives.** Units received per dollar that leaves the
 *     account, counting the crossings and the gas — not the headline price.
 *
 * What stays visible: the plan, the crossings, the gas, and how much better the
 * chosen chain was than the next one. Deciding on someone's behalf is only
 * honest if they can see what was decided.
 */

import { formatUnits, parseUnits, type Address, type PrivateKeyAccount } from 'viem';
import { CHAINS, CHAIN_LIST, type ChainConfig, type ChainKey, type Token } from '../chain';
import { client, quoteLadder, ladder, bestRoute, type Venue } from '../quote';
import { unifiedAssets, listingOn } from '../assets';
import { bridgeQuote, nativeCurrency, type BridgeQuote } from '../bridge';
import { erc20Abi } from '../abis';
import { parseAbi } from 'viem';
import { sendFromAccount, swapFromAccount, type SentStep } from './trade';
import { GAS_FLOOR, gasNeeded } from './funding';
import {
  PlanError,
  fromMicro,
  gasPayer,
  micro,
  planProblem,
  planSpend,
  toMicroUsd,
  totalDollars,
  usdOf,
  type DollarSide,
  type SpendPlan,
} from './plan';

const ERC20 = parseAbi(erc20Abi);

/** What the account holds in spendable dollars on one chain. */
export type DollarBalance = DollarSide & {
  token: Token;
  native: bigint;
  /** What this chain needs in native currency at its current gas price. */
  gasTarget: bigint;
};

/**
 * Where the money is.
 *
 * Every chain's dollar and native balance, read together, because both decide
 * what the account can do: the dollars say what it can buy and the native
 * balance says where it can sign.
 */
export async function dollarBalances(account: Address): Promise<DollarBalance[]> {
  return Promise.all(
    CHAIN_LIST.map(async (chain) => {
      const c = client(chain);
      const [amount, native, gasPrice] = await Promise.all([
        c.readContract({
          address: chain.usd.address,
          abi: ERC20,
          functionName: 'balanceOf',
          args: [account],
        }) as Promise<bigint>,
        c.getBalance({ address: account }),
        // The live price, because the fee floor in the config is a worst case:
        // sizing gas from it buys ten times what the chain is charging.
        c.getGasPrice().catch(() => chain.fallbackGasWei),
      ]);
      const gasTarget = gasNeeded(gasPrice);
      return {
        chain: chain.key,
        token: chain.usd,
        value: micro(amount, chain.usd.decimals),
        native,
        gasTarget,
        hasGas: native >= gasTarget,
      };
    }),
  );
}

/** One way of ending up holding the asset, priced end to end. */
export type Route = {
  /** Where the swap happens. */
  chain: ChainKey;
  token: Token;
  /** Which of the account's dollars pay for it, and what has to move first. */
  plan: SpendPlan;
  /** One quote per crossing, in the order they are sent. */
  crossings: BridgeQuote[];
  /** The gas purchase, when the destination could not have paid for the swap. */
  gasBuy: BridgeQuote | null;
  /** Dollars spent buying that gas. Zero when none was needed. */
  gasCostUsd: number;
  venue: Venue;
  unitsOut: number;
  /** Dollars per unit, counting the crossings and the gas. */
  allInPriceUsd: number;
  etaSeconds: number;
};

export class RouteError extends Error {}

/**
 * Buy gas for a chain the account cannot act on, priced by the bridge.
 *
 * Asked as an exact-output quote first, which is the precise question: land
 * this many wei there, tell me what it costs. Not every destination currency can
 * be quoted that way — OKB cannot — so the fallback asks the opposite question
 * with a few dollars and checks the answer clears the floor. A quote that
 * delivers less than the floor is no use and is refused rather than sent.
 */
async function buyGasQuote(
  account: Address,
  from: ChainConfig,
  dest: ChainConfig,
  needed: bigint,
): Promise<BridgeQuote | null> {
  const target = { kind: 'chain' as const, chain: dest, token: nativeCurrency(dest) };
  const exact = await bridgeQuote(account, from, from.usd, target, needed, 'EXACT_OUTPUT')
    .catch(() => null);
  if (exact) return exact;

  // Otherwise: one probe to learn the rate, then one quote at the size that
  // rate implies. Two calls rather than a search, because the price does not
  // move between them by enough to matter and an unbounded loop against someone
  // else's API is worse than a refusal.
  const decimals = dest.viem.nativeCurrency.decimals;
  const delivers = (q: BridgeQuote): bigint =>
    /^\d+(\.\d+)?$/.test(q.amountOutFormatted) ? parseUnits(q.amountOutFormatted, decimals) : 0n;

  const probeUsd = 2;
  const askFor = (usd: number) =>
    bridgeQuote(
      account,
      from,
      from.usd,
      target,
      parseUnits(usd.toFixed(from.usd.decimals), from.usd.decimals),
    ).catch(() => null);

  const probe = await askFor(probeUsd);
  if (!probe) return null;
  const rate = Number(delivers(probe)) / probeUsd;
  if (!Number.isFinite(rate) || rate <= 0) return null;

  // Half again over what is needed, and never less than a quarter of a dollar:
  // a crossing sized to the exact figure arrives short the moment gas ticks up,
  // and solvers will not quote dust.
  const wanted = Math.max(0.25, Math.min(50, (Number(needed) / rate) * 1.5));
  const sized = await askFor(wanted);
  if (sized && delivers(sized) >= needed) return sized;
  // The probe itself may already be enough — it usually is, since two dollars
  // of gas is a lot of gas — and is better than nothing when the sized quote
  // came back short or not at all.
  return delivers(probe) >= needed ? probe : null;
}

/** The dollars a crossing actually delivered, in millionths. */
const deliveredMicro = (quote: BridgeQuote, token: Token): bigint =>
  /^\d+(\.\d+)?$/.test(quote.amountOutFormatted)
    ? micro(parseUnits(quote.amountOutFormatted, token.decimals), token.decimals)
    : 0n;

/**
 * Price every way of buying this asset with the account's dollars.
 *
 * One plan per chain that lists the asset, each priced on what would actually
 * arrive there — the dollars already on that chain plus what the crossings
 * deliver, less what the gas costs. Chains that cannot be funded, cannot be
 * signed on, or do not quote are dropped, and if that leaves nothing the reason
 * given is the one the customer can act on.
 */
export async function routesFor(
  account: Address,
  asset: string,
  usdAmount: number,
): Promise<Route[]> {
  const found = unifiedAssets().find((a) => a.symbol === asset.toUpperCase());
  if (!found) throw new RouteError(`no listed asset: ${asset}`);

  const sides = await dollarBalances(account);
  const need = toMicroUsd(usdAmount);
  const held = totalDollars(sides);
  if (held < need) {
    throw new RouteError(
      `this account holds $${usdOf(held).toFixed(2)} and the trade needs $${usdAmount.toFixed(2)}`,
    );
  }

  const problems: string[] = [];

  const routes = await Promise.all(
    found.listings.map(async ({ chain: key }): Promise<Route | null> => {
      const chain = CHAINS[key];
      const token = listingOn(found, key);
      if (!token || token.symbol === chain.usd.symbol) return null;

      // Gas before dollars: the plan cannot know what it can spend until it
      // knows what the gas costs, and on a chain the account has never touched
      // the gas is bought with the same dollars the trade wants.
      let gasBuy: BridgeQuote | null = null;
      const side = sides.find((s) => s.chain === key);
      if (side && !side.hasGas) {
        const payer = gasPayer(sides, key);
        if (!payer) {
          problems.push(
            'this account holds no native currency on any chain, so it cannot sign anything yet — send it a little from your wallet on the account page',
          );
          return null;
        }
        gasBuy = await buyGasQuote(account, CHAINS[payer], chain, side.gasTarget);
        if (!gasBuy) {
          problems.push(`no way to buy ${chain.viem.nativeCurrency.symbol} for ${chain.name}`);
          return null;
        }
      }

      const gasCostUsd = gasBuy ? Number(gasBuy.amountInFormatted) : 0;
      let plan: SpendPlan;
      try {
        plan = planSpend(
          sides,
          key,
          need,
          gasBuy ? { chain: key, from: gasBuy.from.chain, value: toMicroUsd(gasCostUsd) } : null,
        );
      } catch (e) {
        problems.push(e instanceof PlanError ? e.message : 'this trade could not be planned');
        return null;
      }
      if (plan.short > 0n) {
        problems.push(planProblem(plan, need) ?? 'not enough in the account for this trade');
        return null;
      }

      const crossings: BridgeQuote[] = [];
      for (const leg of plan.legs) {
        const from = CHAINS[leg.from];
        const quote = await bridgeQuote(
          account,
          from,
          from.usd,
          { kind: 'chain', chain, token: chain.usd },
          fromMicro(leg.value, from.usd.decimals),
        ).catch(() => null);
        if (!quote || deliveredMicro(quote, chain.usd) === 0n) {
          problems.push(`no crossing from ${from.name} to ${chain.name} right now`);
          return null;
        }
        crossings.push(quote);
      }

      // What the swap will really have to spend: the dollars already here plus
      // what the solvers deliver. Quoting the ask rather than the arrival would
      // overstate every route that has to cross.
      const arriving = crossings.reduce((sum, q) => sum + deliveredMicro(q, chain.usd), plan.here);
      const spendable = fromMicro(arriving, chain.usd.decimals);
      if (spendable <= 0n) return null;

      try {
        const curves = await quoteLadder(chain.usd, token, ladder(spendable, 4));
        if (curves.length === 0) return null;
        const best = bestRoute(curves, spendable);
        const route = best.chosen === 'split' ? best.split : best.single;
        const venue = route.allocations[0]?.venue;
        const unitsOut = Number(formatUnits(route.amountOut, token.decimals));
        if (!venue || unitsOut <= 0) return null;
        return {
          chain: key,
          token,
          plan,
          crossings,
          gasBuy,
          gasCostUsd,
          venue,
          unitsOut,
          allInPriceUsd: (usdAmount + gasCostUsd) / unitsOut,
          etaSeconds: Math.max(gasBuy?.etaSeconds ?? 0, ...crossings.map((c) => c.etaSeconds), 0),
        };
      } catch {
        problems.push(`${chain.name} did not quote ${asset}`);
        return null;
      }
    }),
  );

  const priced = routes.filter((r): r is Route => r !== null);
  if (priced.length === 0) {
    throw new RouteError(problems[0] ?? `nothing quotes ${asset} right now`);
  }
  // Cheapest per unit, counting the crossings and the gas — so a chain that
  // needs eight dollars of gas does not win by two basis points. That gas stays
  // in the account afterwards, which the panel says.
  return priced.sort((a, b) => a.allInPriceUsd - b.allInPriceUsd);
}

export type BuyProgress = {
  stage: 'gas' | 'bridging' | 'waiting' | 'swapping' | 'done';
  detail: string;
};

/**
 * Execute the plan: gas, then crossings, then the swap.
 *
 * The order is not a preference. Gas has to land before anything can be signed
 * on the destination, and the dollars have to arrive before the swap can spend
 * them. Both are polled rather than assumed, because a swap fired optimistically
 * fails in a way that costs gas and explains nothing, and both have a ceiling,
 * because a solver that never delivers must end as a sentence rather than a
 * spinner.
 *
 * What is deliberate: the swap spends what actually arrived, not what was
 * quoted. Solvers deliver within a basis point or two of their quote, and
 * spending a figure from before the crossing is how a trade reverts on its last
 * transaction with every earlier one already paid for.
 */
export async function buy(
  account: PrivateKeyAccount,
  route: Route,
  slippageBps: number,
  onProgress?: (p: BuyProgress) => void,
): Promise<SentStep[]> {
  const dest = CHAINS[route.chain];
  const sent: SentStep[] = [];

  if (route.gasBuy) {
    const payer = CHAINS[route.gasBuy.from.chain as ChainKey];
    onProgress?.({
      stage: 'gas',
      detail: `buying $${route.gasCostUsd.toFixed(2)} of ${dest.viem.nativeCurrency.symbol} so ${dest.name} can pay its own gas`,
    });
    for (const step of route.gasBuy.steps) {
      if (!step.to) continue;
      const hash = await sendFromAccount(account, payer.key, {
        to: step.to,
        data: step.data,
        value: step.value ? BigInt(step.value) : 0n,
      });
      sent.push({ step: 'approve', description: `gas for ${dest.name}, paid from ${payer.name}`, hash });
    }
  }

  for (const [i, crossing] of route.crossings.entries()) {
    const from = CHAINS[route.plan.legs[i].from];
    onProgress?.({
      stage: 'bridging',
      detail: `moving $${usdOf(route.plan.legs[i].value).toFixed(2)} from ${from.name}`,
    });
    for (const step of crossing.steps) {
      if (!step.to) continue;
      const hash = await sendFromAccount(account, from.key, {
        to: step.to,
        data: step.data,
        value: step.value ? BigInt(step.value) : 0n,
      });
      sent.push({ step: 'approve', description: `${step.kind} on ${from.name}`, hash });
    }
  }

  if (route.gasBuy) {
    onProgress?.({ stage: 'waiting', detail: `waiting for ${dest.name} to have gas` });
    const funded = await waitFor(
      () => client(dest).getBalance({ address: account.address }),
      // Whatever the quote actually promised, which is what was paid for.
      parseUnits(route.gasBuy.amountOutFormatted, dest.viem.nativeCurrency.decimals),
    );
    if (!funded) {
      throw new RouteError(
        `the ${dest.viem.nativeCurrency.symbol} bought for ${dest.name} has not arrived yet — nothing is lost, and the trade can be retried once it lands`,
      );
    }
  }

  // What the solvers said they would deliver, less a basis point of tolerance:
  // waiting for the exact figure would hang on a solver that rounded down.
  const promised = route.crossings.reduce((t, q) => t + deliveredMicro(q, dest.usd), 0n);
  const target = fromMicro(route.plan.here + (promised * 9_999n) / 10_000n, dest.usd.decimals);
  if (route.crossings.length > 0) {
    onProgress?.({ stage: 'waiting', detail: 'waiting for the dollars to arrive' });
    const arrived = await waitFor(() => dollarsOn(account.address, route.chain), target);
    if (!arrived) {
      throw new RouteError(
        `the dollars left but have not all arrived on ${dest.name} yet — they are not lost, and the swap can be retried once they land`,
      );
    }
  }

  onProgress?.({ stage: 'swapping', detail: `buying on ${dest.name}` });
  const balance = await dollarsOn(account.address, route.chain);
  const quoted = fromMicro(
    route.plan.here + route.crossings.reduce((t, q) => t + deliveredMicro(q, dest.usd), 0n),
    dest.usd.decimals,
  );
  const spend = balance < quoted ? balance : quoted;
  if (spend <= 0n) throw new RouteError(`no dollars to spend on ${dest.name}`);
  const swapped = await swapFromAccount(
    account,
    route.chain,
    route.venue,
    spend,
    minimumFor(route, spend, quoted, slippageBps),
  );
  onProgress?.({ stage: 'done', detail: `bought on ${dest.name}` });
  return [...sent, ...swapped];
}

/**
 * The floor the swap is allowed to fill at.
 *
 * Scaled by what is actually being spent against what was quoted, because a
 * crossing that delivered a dollar less must not be held to the minimum for a
 * trade a dollar larger — that reverts every time.
 */
function minimumFor(route: Route, spend: bigint, quoted: bigint, slippageBps: number): bigint {
  const expected = parseUnits(route.unitsOut.toFixed(route.token.decimals), route.token.decimals);
  const scaled = quoted > 0n ? (expected * spend) / quoted : expected;
  return (scaled * BigInt(10_000 - slippageBps)) / 10_000n;
}

const dollarsOn = async (account: Address, chain: ChainKey): Promise<bigint> =>
  client(CHAINS[chain]).readContract({
    address: CHAINS[chain].usd.address,
    abi: ERC20,
    functionName: 'balanceOf',
    args: [account],
  }) as Promise<bigint>;

/**
 * Wait for a balance to reach a figure.
 *
 * Intent bridges settle in seconds, so two minutes is generous rather than
 * optimistic. The ceiling matters more than the interval: the customer has to be
 * told their money is in transit instead of watching something that means
 * nothing.
 */
async function waitFor(
  read: () => Promise<bigint>,
  target: bigint,
  timeoutMs = 120_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await read().catch(() => 0n)) >= target) return true;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return false;
}

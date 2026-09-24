/**
 * Buy an asset. The chain is an implementation detail.
 *
 * The customer holds dollars in one account and wants NVDA. Which chain that
 * happens on is a question about liquidity and bridge costs — arithmetic, not
 * a preference — and asking them to answer it was the thing this product
 * existed to stop doing.
 *
 * So: find where the dollars are, price the asset on every chain that lists
 * it, and pick the one that hands back the most. If that is somewhere else,
 * move the dollars there first. The account signs all of it, so a crossing
 * costs a click rather than a trip to a bridge.
 *
 * What is deliberately still visible: the route that was chosen, the cost of
 * getting there, and how much better it was than staying put. Choosing on
 * someone's behalf is only acceptable if they can see what you chose and why.
 */

import { formatUnits, parseUnits, type Address, type PrivateKeyAccount } from 'viem';
import { CHAINS, CHAIN_LIST, type ChainKey, type Token } from '../chain';
import { client, quoteLadder, ladder, bestRoute, type Venue } from '../quote';
import { unifiedAssets, listingOn } from '../assets';
import { bridgeQuote, type BridgeQuote } from '../bridge';
import { erc20Abi } from '../abis';
import { parseAbi } from 'viem';
import { sendFromAccount, swapFromAccount, type SentStep } from './trade';
import { GAS_FLOOR } from './funding';

const ERC20 = parseAbi(erc20Abi);

/** What the account holds in spendable dollars on one chain. */
export type DollarBalance = {
  chain: ChainKey;
  token: Token;
  amount: bigint;
  /** Enough native currency to actually send a transaction here. */
  canAct: boolean;
};

/**
 * Where the money is.
 *
 * Every chain's dollar, read together. A customer who funded X Layer and now
 * wants an asset that only trades well on Base is the ordinary case, not an
 * edge one, and answering it starts with knowing what is where.
 */
export async function dollarBalances(account: Address): Promise<DollarBalance[]> {
  return Promise.all(
    CHAIN_LIST.map(async (chain) => {
      const c = client(chain);
      const [amount, native] = await Promise.all([
        c.readContract({
          address: chain.usd.address,
          abi: ERC20,
          functionName: 'balanceOf',
          args: [account],
        }) as Promise<bigint>,
        c.getBalance({ address: account }),
      ]);
      return {
        chain: chain.key,
        token: chain.usd,
        amount,
        canAct: native >= GAS_FLOOR[chain.key],
      };
    }),
  );
}

/** One way of ending up holding the asset, priced end to end. */
export type Route = {
  /** Where the swap happens. */
  chain: ChainKey;
  token: Token;
  /** Where the dollars start. Equal to `chain` when nothing has to move. */
  from: ChainKey;
  bridge: BridgeQuote | null;
  venue: Venue;
  unitsOut: number;
  /** All-in cost per unit, counting the dollars that left the account. */
  effectivePriceUsd: number;
  etaSeconds: number;
};

export class RouteError extends Error {}

/**
 * Price every way of buying this asset with the dollars on hand.
 *
 * Sources are considered in order of how much they hold, because a plan that
 * needs two crossings to assemble enough dollars is worse than one that does
 * not, and splitting a purchase across chains is a complication nobody asked
 * for.
 */
export async function routesFor(
  account: Address,
  asset: string,
  usdAmount: number,
): Promise<Route[]> {
  const found = unifiedAssets().find((a) => a.symbol === asset.toUpperCase());
  if (!found) throw new RouteError(`no listed asset: ${asset}`);

  const balances = await dollarBalances(account);
  const source = balances
    .filter((b) => b.canAct)
    .sort((a, b) => (b.amount > a.amount ? 1 : -1))
    .find((b) => Number(formatUnits(b.amount, b.token.decimals)) >= usdAmount);

  if (!source) {
    const best = balances.sort((a, b) => (b.amount > a.amount ? 1 : -1))[0];
    const held = best ? Number(formatUnits(best.amount, best.token.decimals)) : 0;
    throw new RouteError(
      held >= usdAmount
        ? `your dollars are on ${CHAINS[best!.chain].name}, which has no gas to send a transaction`
        : `not enough in the account: ${held.toFixed(2)} available, ${usdAmount.toFixed(2)} needed`,
    );
  }

  const routes = await Promise.all(
    found.listings.map(async ({ chain: key }): Promise<Route | null> => {
      const chain = CHAINS[key];
      const token = listingOn(found, key);
      if (!token || token.symbol === chain.usd.symbol) return null;

      let spendable = parseUnits(usdAmount.toFixed(chain.usd.decimals), chain.usd.decimals);
      let bridge: BridgeQuote | null = null;

      if (key !== source.chain) {
        const quote = await bridgeQuote(
          account,
          CHAINS[source.chain],
          source.token,
          { kind: 'chain', chain, token: chain.usd },
          parseUnits(usdAmount.toFixed(source.token.decimals), source.token.decimals),
        ).catch(() => null);
        if (!quote || !/^\d+(\.\d+)?$/.test(quote.amountOutFormatted)) return null;
        bridge = quote;
        spendable = parseUnits(quote.amountOutFormatted, chain.usd.decimals);
      }

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
          from: source.chain,
          bridge,
          venue,
          unitsOut,
          effectivePriceUsd: usdAmount / unitsOut,
          etaSeconds: bridge?.etaSeconds ?? 0,
        };
      } catch {
        return null;
      }
    }),
  );

  const priced = routes.filter((r): r is Route => r !== null);
  if (priced.length === 0) throw new RouteError(`nothing quotes ${asset} right now`);
  // Units received, because that is what ends up in the account — a crossing
  // takes its cut before the pool ever sees the money.
  return priced.sort((a, b) => b.unitsOut - a.unitsOut);
}

export type BuyProgress = {
  stage: 'bridging' | 'waiting' | 'swapping' | 'done';
  detail: string;
};

/**
 * Execute the chosen route, crossing first if it needs to.
 *
 * The wait between a bridge and the swap is the part that cannot be skipped:
 * the dollars have to actually arrive before anything can spend them, and a
 * swap fired optimistically fails in a way that costs gas and explains
 * nothing. Polled rather than assumed, with a ceiling, because a solver that
 * never delivers must end as a clear message rather than a spinner.
 */
export async function buy(
  account: PrivateKeyAccount,
  route: Route,
  usdAmount: number,
  slippageBps: number,
  onProgress?: (p: BuyProgress) => void,
): Promise<SentStep[]> {
  const destination = CHAINS[route.chain];
  const sent: SentStep[] = [];

  if (route.bridge) {
    onProgress?.({
      stage: 'bridging',
      detail: `moving ${usdAmount.toFixed(2)} to ${destination.name}`,
    });
    const before = await dollarsOn(account.address, route.chain);

    for (const step of route.bridge.steps) {
      if (!step.to) continue;
      const hash = await sendFromAccount(account, route.from, {
        to: step.to,
        data: step.data,
        value: step.value ? BigInt(step.value) : 0n,
      });
      sent.push({ step: 'approve', description: `${step.kind} on ${CHAINS[route.from].name}`, hash });
    }

    onProgress?.({ stage: 'waiting', detail: `waiting for the dollars to arrive` });
    const arrived = await waitForDollars(account.address, route.chain, before);
    if (!arrived) {
      throw new RouteError(
        `the dollars left ${CHAINS[route.from].name} but have not arrived on ${destination.name} yet — they are not lost, and the swap can be retried once they land`,
      );
    }
  }

  onProgress?.({ stage: 'swapping', detail: `buying on ${destination.name}` });
  const spendable = parseUnits(usdAmount.toFixed(destination.usd.decimals), destination.usd.decimals);
  const minimumOut = minimumFor(route, slippageBps);
  const swapped = await swapFromAccount(account, route.chain, route.venue, spendable, minimumOut);
  onProgress?.({ stage: 'done', detail: `bought on ${destination.name}` });
  return [...sent, ...swapped];
}

/** The floor the swap is allowed to fill at, in the asset's own units. */
function minimumFor(route: Route, slippageBps: number): bigint {
  const expected = parseUnits(
    route.unitsOut.toFixed(route.token.decimals),
    route.token.decimals,
  );
  return (expected * BigInt(10_000 - slippageBps)) / 10_000n;
}

const dollarsOn = async (account: Address, chain: ChainKey): Promise<bigint> =>
  client(CHAINS[chain]).readContract({
    address: CHAINS[chain].usd.address,
    abi: ERC20,
    functionName: 'balanceOf',
    args: [account],
  }) as Promise<bigint>;

/**
 * Wait for a bridge to deliver.
 *
 * Intent bridges settle in seconds, so a couple of minutes is generous rather
 * than optimistic — and the ceiling matters more than the speed: the customer
 * must be told their money is in transit rather than watching a spinner that
 * means nothing.
 */
async function waitForDollars(
  account: Address,
  chain: ChainKey,
  before: bigint,
  timeoutMs = 120_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000));
    if ((await dollarsOn(account, chain).catch(() => before)) > before) return true;
  }
  return false;
}

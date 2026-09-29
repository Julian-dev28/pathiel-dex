/**
 * Swap anything for anything out of the one trading account.
 *
 * The account is one balance per asset, however many chains it is spread
 * across: 0.6 ETH on Base and 0.4 on Robinhood Chain is "1 ETH". Selling it is
 * therefore a plan rather than a single swap — each chain's share is sold
 * where it sits when the thing being bought is listed there, and crossed by
 * Relay (which swaps and bridges in one deposit) when it is not. The chains
 * that pay best are drawn on first.
 *
 * Paying with dollars is the case `autoroute.ts` already solves, gas and
 * crossings included, so it is used as is rather than solved twice.
 *
 * Every price here is re-asked at execution: a plan shows what the trade is
 * expected to do, and the transactions are built from quotes fetched the
 * moment they are sent.
 */

import {
  encodeFunctionData,
  formatUnits,
  parseAbi,
  parseUnits,
  type Address,
  type PrivateKeyAccount,
} from 'viem';
import { CHAINS, CHAIN_LIST, type ChainKey, type Token } from '../chain';
import { canonical } from '../assets';
import { client, type Venue } from '../quote';
import { fetchQuote, type QuoteResponse } from '../api';
import { bridgeQuote, type BridgeQuote } from '../bridge';
import { ERC20 } from '../execute';
import { gasNeeded } from './funding';
import { swapFromAccount, sendFromAccount, TradeError, type SentStep } from './trade';
import {
  buy,
  buyGasQuote,
  dollarBalances,
  routesFor,
  waitFor,
  type BuyProgress,
  type Route,
} from './autoroute';
import { gasPayer, totalDollars, usdOf } from './plan';

const WETH_ABI = parseAbi(['function deposit() payable']);

/**
 * An asset as the account sees it: one entry however many chains list it.
 *
 * Each chain's own dollar folds into `USD`, because "sell ETH for dollars" is
 * the question and which issuer's dollar a chain happens to use is the
 * router's business. Other tokens fold by `canonical`, so NVDA, NVDAc and
 * wNVDAx are one asset.
 */
export type SwapAsset = { key: string; display: Token; byChain: Partial<Record<ChainKey, Token>> };

export function swapAssets(): SwapAsset[] {
  const byKey = new Map<string, SwapAsset>();
  for (const chain of CHAIN_LIST) {
    for (const token of chain.tokens) {
      const key = token.address === chain.usd.address ? 'USD' : canonical(token.symbol);
      const entry = byKey.get(key) ?? {
        key,
        display: { ...token, symbol: key, name: key === 'USD' ? 'US dollar' : token.name },
        byChain: {},
      };
      // First listing on a chain wins: the chain tables list the main token
      // for an asset (WETH before xETH) ahead of its alternatives.
      entry.byChain[chain.key] ??= token;
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()];
}

/** What the account holds of one asset on one chain, gas set aside. */
export type Holding = {
  chain: ChainKey;
  token: Token;
  /** The token balance itself. */
  erc20: bigint;
  /** Native currency that can be wrapped into `token` and still leave gas. */
  wrappable: bigint;
  /** erc20 + wrappable, as a number of whole units. */
  units: number;
  /** Whether the chain can pay for a transaction as things stand. */
  hasGas: boolean;
  gasTarget: bigint;
};

const isWrappedNative = (chain: ChainKey, token: Token) =>
  token.address.toLowerCase() === CHAINS[chain].weth.address.toLowerCase();

/** The account's holding of an asset on every chain that lists it. */
export async function holdings(account: Address, asset: SwapAsset): Promise<Holding[]> {
  return Promise.all(
    CHAIN_LIST.filter((c) => asset.byChain[c.key]).map(async (chain) => {
      const token = asset.byChain[chain.key]!;
      const c = client(chain);
      const [erc20, native, gasPrice] = await Promise.all([
        c.readContract({
          address: token.address,
          abi: ERC20,
          functionName: 'balanceOf',
          args: [account],
        }) as Promise<bigint>,
        c.getBalance({ address: account }),
        c.getGasPrice().catch(() => chain.fallbackGasWei),
      ]);
      const gasTarget = gasNeeded(gasPrice);
      // Native ETH counts as ETH where ETH is the gas: an account funded by a
      // plain transfer holds no WETH, and calling that zero would be false.
      const wrappable =
        isWrappedNative(chain.key, token) && native > gasTarget ? native - gasTarget : 0n;
      return {
        chain: chain.key,
        token,
        erc20,
        wrappable,
        units: Number(formatUnits(erc20 + wrappable, token.decimals)),
        hasGas: native >= gasTarget,
        gasTarget,
      };
    }),
  );
}

/** One chain's share of a sale. */
export type SellLeg = {
  chain: ChainKey;
  tokenIn: Token;
  amountIn: bigint;
  /** Native currency to wrap before the swap, when the WETH alone is short. */
  wrap: bigint;
  /** Where the proceeds land. */
  dest: ChainKey;
  tokenOut: Token;
  /** Expected proceeds, in whole units of `tokenOut`. */
  out: number;
} & (
  { kind: 'local'; quote: QuoteResponse; venue: Venue } | { kind: 'cross'; bridge: BridgeQuote }
);

export type GasBuy = {
  chain: ChainKey;
  payer: ChainKey;
  quote: BridgeQuote;
  target: bigint;
  usd: number;
};

export type SwapPlan =
  { kind: 'buy'; routes: Route[] } | { kind: 'sell'; legs: SellLeg[]; gas: GasBuy[]; out: number };

export class SwapError extends Error {}

// Nine decimals is past any trade's meaning and short of a double's noise:
// 0.05.toFixed(18) is 0.050000000000000003.
const baseUnits = (units: number, token: Token) =>
  parseUnits(units.toFixed(Math.min(token.decimals, 9)), token.decimals);

/**
 * A share never asks for more than the chain holds, whatever rounding did,
 * and a share within rounding of the whole holding takes all of it — "use
 * max" should empty the chain, not leave a billionth behind.
 */
const capped = (h: Holding, units: number) => {
  const want = baseUnits(units, h.token);
  const max = h.erc20 + h.wrappable;
  const dust = h.token.decimals > 9 ? 10n ** BigInt(h.token.decimals - 9) : 1n;
  return want >= max || max - want < dust ? max : want;
};

/** Price one chain's share at a given size: in place where listed, else crossed. */
async function priceLeg(
  account: Address,
  h: Holding,
  assetOut: SwapAsset,
  amountIn: bigint,
): Promise<SellLeg | null> {
  const wrap = amountIn > h.erc20 ? amountIn - h.erc20 : 0n;
  const localOut = assetOut.byChain[h.chain];
  if (localOut) {
    const quote = await fetchQuote(
      h.chain,
      h.token.symbol,
      localOut.symbol,
      formatUnits(amountIn, h.token.decimals),
    ).catch(() => null);
    const venue = quote?.route.single.allocations[0]?.venue;
    if (!quote || !venue) return null;
    return {
      kind: 'local',
      chain: h.chain,
      tokenIn: h.token,
      amountIn,
      wrap,
      dest: h.chain,
      tokenOut: localOut,
      out: Number(formatUnits(quote.route.single.amountOut, localOut.decimals)),
      quote,
      venue,
    };
  }
  // Not listed here: Relay sells and delivers to whichever chain lists it.
  const crossed = await Promise.all(
    CHAIN_LIST.filter((d) => assetOut.byChain[d.key]).map(async (d) => {
      const tokenOut = assetOut.byChain[d.key]!;
      const bridge = await bridgeQuote(
        account,
        CHAINS[h.chain],
        h.token,
        { kind: 'chain', chain: d, token: tokenOut },
        amountIn,
      ).catch(() => null);
      const out = bridge ? Number(bridge.amountOutFormatted) : 0;
      return bridge && out > 0
        ? ({
            kind: 'cross',
            chain: h.chain,
            tokenIn: h.token,
            amountIn,
            wrap,
            dest: d.key,
            tokenOut,
            out,
            bridge,
          } as SellLeg)
        : null;
    }),
  );
  return crossed.filter((l): l is SellLeg => l !== null).sort((a, b) => b.out - a.out)[0] ?? null;
}

/**
 * Plan a swap of `amount` of `assetIn` into `assetOut`.
 *
 * `amount` is in whole units of the pay asset (dollars when paying USD).
 */
export async function planSwap(
  account: Address,
  assetIn: SwapAsset,
  assetOut: SwapAsset,
  amount: number,
): Promise<SwapPlan> {
  if (!(amount > 0)) throw new SwapError('enter an amount');
  if (assetIn.key === assetOut.key) throw new SwapError('pick two different assets');

  if (assetIn.key === 'USD') {
    return { kind: 'buy', routes: await routesFor(account, assetOut.key, amount) };
  }

  const held = (await holdings(account, assetIn)).filter((h) => h.units > 0);
  const total = held.reduce((t, h) => t + h.units, 0);
  if (total < amount) {
    throw new SwapError(
      `this account holds ${total.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${assetIn.key} and the trade needs ${amount}`,
    );
  }

  // Each chain priced at the most it could contribute, then ranked by rate.
  const probes = await Promise.all(
    held.map(async (h) => {
      const size = Math.min(h.units, amount);
      const leg = await priceLeg(account, h, assetOut, capped(h, size));
      return leg ? { h, size, leg, rate: leg.out / size } : null;
    }),
  );
  const ranked = probes
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .sort((a, b) => b.rate - a.rate);
  if (ranked.reduce((t, p) => t + p.size, 0) < amount * 0.999999) {
    throw new SwapError(
      `nothing quotes ${assetIn.key} for ${assetOut.key} on enough of the account right now`,
    );
  }

  // Best rate first, each chain up to what it holds. A share smaller than the
  // probe is re-priced at its own size rather than scaled.
  const legs: SellLeg[] = [];
  let remaining = amount;
  for (const p of ranked) {
    if (remaining <= 0) break;
    const size = Math.min(p.size, remaining);
    const leg = size === p.size ? p.leg : await priceLeg(account, p.h, assetOut, capped(p.h, size));
    if (!leg) continue;
    legs.push(leg);
    remaining -= size;
  }
  if (remaining > amount * 1e-6) throw new SwapError('part of this trade could not be priced');

  // A chain that has to sign but holds no gas gets some bought for it with the
  // account's dollars, the same way a purchase does.
  const gas: GasBuy[] = [];
  const needGas = held.filter((h) => !h.hasGas && legs.some((l) => l.chain === h.chain));
  if (needGas.length > 0) {
    const sides = await dollarBalances(account);
    for (const h of needGas) {
      const payer = gasPayer(sides, h.chain);
      if (!payer) {
        throw new SwapError(
          `${CHAINS[h.chain].name} has no ${CHAINS[h.chain].viem.nativeCurrency.symbol} for gas and no other chain holds dollars that can buy it`,
        );
      }
      const quote = await buyGasQuote(account, CHAINS[payer], CHAINS[h.chain], h.gasTarget);
      if (!quote) throw new SwapError(`no way to buy gas for ${CHAINS[h.chain].name} right now`);
      gas.push({
        chain: h.chain,
        payer,
        quote,
        target: h.gasTarget,
        usd: Number(quote.amountInFormatted),
      });
    }
  }

  return { kind: 'sell', legs, gas, out: legs.reduce((t, l) => t + l.out, 0) };
}

/** Unified balance of an asset: dollars across the account, or the sum of holdings. */
export async function unifiedBalance(account: Address, asset: SwapAsset): Promise<number> {
  if (asset.key === 'USD') return usdOf(totalDollars(await dollarBalances(account)));
  return (await holdings(account, asset)).reduce((t, h) => t + h.units, 0);
}

/**
 * Carry out a plan.
 *
 * `routeIndex` picks among a purchase's chains; `venueFor` overrides the venue
 * of an in-place sale on a chain. Both default to the best.
 */
export async function executeSwap(
  account: PrivateKeyAccount,
  plan: SwapPlan,
  slippageBps: number,
  choice: { routeIndex?: number; venueFor?: Partial<Record<ChainKey, string>> },
  onProgress?: (p: BuyProgress) => void,
): Promise<SentStep[]> {
  if (plan.kind === 'buy') {
    const route = plan.routes[choice.routeIndex ?? 0];
    if (!route) throw new SwapError('no route to buy with');
    return buy(account, route, slippageBps, onProgress);
  }

  const sent: SentStep[] = [];
  try {
    for (const g of plan.gas) {
      onProgress?.({ stage: 'gas', detail: `buying gas for ${CHAINS[g.chain].name}` });
      for (const step of g.quote.steps) {
        if (!step.to) continue;
        const hash = await sendFromAccount(account, g.payer, {
          to: step.to,
          data: step.data,
          value: step.value ? BigInt(step.value) : 0n,
        });
        sent.push({ step: 'approve', description: `gas for ${CHAINS[g.chain].name}`, hash });
      }
      const landed = await waitFor(
        () => client(CHAINS[g.chain]).getBalance({ address: account.address }),
        g.target,
      );
      if (!landed)
        throw new SwapError(
          `gas for ${CHAINS[g.chain].name} has not arrived yet — retry once it lands`,
        );
    }

    for (const leg of plan.legs) {
      const chain = CHAINS[leg.chain];
      if (leg.wrap > 0n) {
        onProgress?.({
          stage: 'swapping',
          detail: `wrapping ${chain.viem.nativeCurrency.symbol} on ${chain.name}`,
        });
        const hash = await sendFromAccount(account, leg.chain, {
          to: leg.tokenIn.address,
          data: encodeFunctionData({ abi: WETH_ABI, functionName: 'deposit' }),
          value: leg.wrap,
        });
        sent.push({ step: 'approve', description: `wrap on ${chain.name}`, hash });
      }

      if (leg.kind === 'local') {
        onProgress?.({ stage: 'swapping', detail: `selling on ${chain.name}` });
        // Priced again now: the plan's quote may be a minute old.
        const fresh = await fetchQuote(
          leg.chain,
          leg.tokenIn.symbol,
          leg.tokenOut.symbol,
          formatUnits(leg.amountIn, leg.tokenIn.decimals),
        );
        const wanted = choice.venueFor?.[leg.chain];
        const picked = fresh.venues.find((v) => v.venue.id === wanted);
        const venue = picked?.venue ?? fresh.route.single.allocations[0]?.venue;
        if (!venue) throw new SwapError(`${chain.name} no longer quotes this`);
        const expected = picked ? picked.amountOutAtFull : fresh.route.single.amountOut;
        const floor = (expected * BigInt(10_000 - slippageBps)) / 10_000n;
        sent.push(...(await swapFromAccount(account, leg.chain, venue, leg.amountIn, floor)));
      } else {
        onProgress?.({
          stage: 'bridging',
          detail: `selling on ${chain.name} and delivering to ${CHAINS[leg.dest].name}`,
        });
        const fresh = await bridgeQuote(
          account.address,
          chain,
          leg.tokenIn,
          { kind: 'chain', chain: CHAINS[leg.dest], token: leg.tokenOut },
          leg.amountIn,
        );
        if (!fresh)
          throw new SwapError(`Relay no longer quotes ${chain.name} to ${CHAINS[leg.dest].name}`);
        for (const step of fresh.steps) {
          if (!step.to) continue;
          const hash = await sendFromAccount(account, leg.chain, {
            to: step.to,
            data: step.data,
            value: step.value ? BigInt(step.value) : 0n,
          });
          sent.push({ step: 'swap', description: `${step.kind} on ${chain.name}`, hash });
        }
      }
    }
    onProgress?.({ stage: 'done', detail: 'done' });
    return sent;
  } catch (e) {
    if (e instanceof TradeError) throw new TradeError(e.message, [...sent, ...e.sent]);
    throw new TradeError(e instanceof Error ? e.message.split('\n')[0] : 'the trade failed', sent);
  }
}

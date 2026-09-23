/**
 * Moving value between the chains, so the user does not have to.
 *
 * The router quotes three chains and a perp venue. Funds sit on whichever one
 * they arrived on, and until now the answer to "I hold USDC on Base and want
 * NVDA on X Layer" was: go and bridge, come back. That is the drag this
 * removes.
 *
 * Bridging here means an **intent network** rather than a canonical bridge. The
 * user signs a deposit on the origin chain and a solver fronts the destination
 * side from its own inventory, which is why these quotes come back in seconds
 * rather than in the minutes or days a canonical bridge takes. Relay is the one
 * used: it covers all three chains and Hyperliquid's margin accounts, which no
 * canonical path does.
 *
 * What this costs the project's usual standard of proof: a swap quote is read
 * from pool state and can be checked against the chain, but a bridge quote is a
 * price a third party is offering and can only be taken or left. It is a quote,
 * not a computation, and the interface should not dress it as one.
 *
 * Nothing here signs or sends. A quote carries the steps the caller would have
 * to execute, and executing them is the caller's business.
 */

import type { Address } from 'viem';
import { CHAINS, type ChainConfig, type ChainKey, type Token } from './chain';

const QUOTE_URL = 'https://api.relay.link/quote';

/**
 * Hyperliquid, as the bridge sees it: one chain id whose "currencies" are the
 * margin accounts themselves. Depositing into the HIP-3 dex is therefore a
 * bridge destination rather than a separate transfer the user makes afterwards.
 */
export const HYPERLIQUID_CHAIN_ID = 1337;

/**
 * Relay's currency ids for Hyperliquid's three balances. These are not token
 * addresses and are not 20 bytes — they are the bridge's own identifiers, and
 * are passed through exactly as given.
 */
export const HL_CURRENCY = {
  /** Margin for the `xyz` HIP-3 dex, where the stock perps trade. */
  stockPerpMargin: '0x6d1e7cde53ba9467b783cb7c530ce05478797a',
  /** Margin for Hyperliquid's own perp universe. */
  corePerpMargin: '0x00000000000000000000000000000000',
  spot: '0x6d1e7cde53ba9467b783cb7c530ce054',
} as const;

/** Where a bridge can put money: a chain this router quotes, or a perp margin account. */
export type BridgeTarget =
  | { kind: 'chain'; chain: ChainConfig; token: Token }
  | { kind: 'perpMargin'; dex: 'xyz' | 'core' };

export type BridgeQuote = {
  from: { chain: ChainKey; symbol: string };
  to: { chain: ChainKey | 'hyperliquid'; symbol: string };
  /** Base units of the origin token. */
  amountIn: bigint;
  /** Decimal string, as the bridge reports it — the destination's own units. */
  amountInFormatted: string;
  amountOutFormatted: string;
  /** What the crossing costs, in basis points of the input. Positive is a cost. */
  costBps: number;
  /** The bridge's own estimate, in seconds. */
  etaSeconds: number;
  /** The transactions the user would send on the origin chain. */
  steps: { kind: string; to?: Address; data?: `0x${string}`; value?: string }[];
};

type RelayResponse = {
  details?: {
    currencyIn?: { amountFormatted?: string; currency?: { symbol?: string } };
    currencyOut?: { amountFormatted?: string; currency?: { symbol?: string } };
    totalImpact?: { percent?: string };
    timeEstimate?: number;
  };
  steps?: { id?: string; kind?: string; items?: { data?: { to?: string; data?: string; value?: string } }[] }[];
  message?: string;
};

const targetChainId = (t: BridgeTarget): number =>
  t.kind === 'chain' ? t.chain.id : HYPERLIQUID_CHAIN_ID;

const targetCurrency = (t: BridgeTarget): string =>
  t.kind === 'chain'
    ? t.token.address
    : t.dex === 'xyz'
      ? HL_CURRENCY.stockPerpMargin
      : HL_CURRENCY.corePerpMargin;

const targetLabel = (t: BridgeTarget): { chain: ChainKey | 'hyperliquid'; symbol: string } =>
  t.kind === 'chain'
    ? { chain: t.chain.key, symbol: t.token.symbol }
    : { chain: 'hyperliquid', symbol: t.dex === 'xyz' ? 'USDC (xyz margin)' : 'USDC (perp margin)' };

/**
 * Read a Relay quote into this project's shape.
 *
 * Kept separate from the request so the mapping is testable without a network,
 * and because the field that matters most — the cost of crossing — is reported
 * as a percentage string that is negative when the user loses value. This is
 * the sign flip that turns a 0.13% haircut into a 13bp cost rather than a
 * mysterious minus sign on a screen.
 */
export function parseBridgeQuote(
  res: RelayResponse,
  from: { chain: ChainKey; symbol: string },
  to: { chain: ChainKey | 'hyperliquid'; symbol: string },
  amountIn: bigint,
): BridgeQuote | null {
  const d = res.details;
  if (!d?.currencyOut?.amountFormatted || !d.currencyIn?.amountFormatted) return null;
  const impact = Number(d.totalImpact?.percent ?? 0);
  return {
    from,
    to,
    amountIn,
    amountInFormatted: d.currencyIn.amountFormatted,
    amountOutFormatted: d.currencyOut.amountFormatted,
    costBps: Number.isFinite(impact) ? -impact * 100 : 0,
    etaSeconds: d.timeEstimate ?? 0,
    steps: (res.steps ?? []).map((s) => {
      const tx = s.items?.[0]?.data;
      return {
        kind: s.kind ?? s.id ?? 'transaction',
        to: tx?.to as Address | undefined,
        data: tx?.data as `0x${string}` | undefined,
        value: tx?.value,
      };
    }),
  };
}

/**
 * Price one crossing.
 *
 * Returns null rather than throwing when the route is not offered: a chain pair
 * nobody solves is an ordinary answer here, and a caller comparing several
 * routes wants the others even when one is unavailable.
 */
export async function bridgeQuote(
  wallet: Address,
  fromChain: ChainConfig,
  fromToken: Token,
  to: BridgeTarget,
  amountIn: bigint,
): Promise<BridgeQuote | null> {
  const body = {
    user: wallet,
    recipient: wallet,
    originChainId: fromChain.id,
    destinationChainId: targetChainId(to),
    originCurrency: fromToken.address,
    destinationCurrency: targetCurrency(to),
    amount: amountIn.toString(),
    tradeType: 'EXACT_INPUT',
  };
  const res = await fetch(QUOTE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  return parseBridgeQuote(
    (await res.json()) as RelayResponse,
    { chain: fromChain.key, symbol: fromToken.symbol },
    targetLabel(to),
    amountIn,
  );
}

/** The dollar a chain's liquidity is paired against — what a crossing carries. */
export const bridgeDollar = (chain: ChainKey): Token => CHAINS[chain].usd;

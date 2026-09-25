/**
 * The decisions behind the trading-account panel.
 *
 * Same split as `perp-ticket.ts`, for the same reason: the parts of this panel
 * that can be wrong in a way a test catches — whether an account is able to
 * move its own money, what "send everything back" will do and in which order,
 * and what landed when it stops partway — live here, away from React and the
 * network. This repo's unit tests cannot import a `.tsx`.
 */

import { formatUnits, type Address } from 'viem';
import { CHAIN_LIST, type ChainConfig, type ChainKey, type Token } from '@/lib/chain';
import {
  statusFor,
  withdrawEverything,
  type AccountStatus,
  type Transfer,
} from '@/lib/account/funding';
import { addr, sig } from '@/lib/format';

/**
 * Every chain here prices gas in an 18-decimal unit — ETH on Base and
 * Robinhood Chain, OKB on X Layer — so the symbol is the only thing that
 * varies. Six figures is the same precision the balances page shows gas at.
 */
export const nativeText = (wei: bigint, symbol: string): string =>
  `${Number(formatUnits(wei, 18)).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${symbol}`;

/**
 * The three states an account can be in on one chain.
 *
 * `needs-gas` exists separately from `empty` because they read identically to
 * someone looking at a trade button that will not work, and only one of them
 * is fixed by sending more of the token they were trying to trade.
 */
export type FundingState = 'empty' | 'needs-gas' | 'ready';

export function fundingState(status: AccountStatus): FundingState {
  if (status.canTrade) return 'ready';
  return status.nativeBalance === 0n && status.tokens.length === 0 ? 'empty' : 'needs-gas';
}

/** The state as a sentence, because "needs gas" alone does not say how much. */
export function fundingNote(status: AccountStatus, symbol: string): string {
  switch (fundingState(status)) {
    case 'ready':
      return `Holds ${nativeText(status.nativeBalance, symbol)} — enough to pay for its own transactions.`;
    case 'empty':
      return 'Nothing here yet.';
    default:
      return status.tokens.length > 0
        ? `Holds ${status.tokens.length} token${status.tokens.length === 1 ? '' : 's'} and ${nativeText(status.nativeBalance, symbol)}. It cannot move them: send it ${nativeText(status.shortfall, symbol)} first.`
        : `Send it ${nativeText(status.shortfall, symbol)} before it can send anything out.`;
  }
}

/**
 * What the account holds, per chain, from the balances payload.
 *
 * Every chain is returned whether or not the account has touched it: a chain
 * missing from the list reads as a chain with no answer, and the point of this
 * panel is that the same address exists on all three.
 */
export function accountStatuses(
  native: { chain: ChainKey; raw: string }[],
  holdings: { chain: ChainKey; token: Token; raw: string }[],
): AccountStatus[] {
  return CHAIN_LIST.map((c) =>
    statusFor(
      c.key,
      BigInt(native.find((n) => n.chain === c.key)?.raw ?? '0'),
      holdings
        .filter((h) => h.chain === c.key)
        .map((h) => ({ token: h.token, balance: BigInt(h.raw) })),
    ),
  );
}

/** One transfer of a withdrawal, named the way the customer will read it. */
export type WithdrawalStep = { label: string; transfer: Transfer };

/**
 * The withdrawal as a list of named steps, in the order they must be sent.
 *
 * The order is `withdrawEverything`'s — tokens first, the native sweep last —
 * and it is load-bearing: sweeping the gas first strands every token behind a
 * transfer that can no longer pay for itself. Labelling them in that order is
 * what lets the panel say which ones landed when one fails.
 */
export function withdrawalSteps(
  chain: ChainConfig,
  owner: Address,
  status: AccountStatus,
  gasPriceWei: bigint,
): WithdrawalStep[] {
  const to = addr(owner);
  return withdrawEverything(chain, owner, status, gasPriceWei).map((transfer, i) => {
    const held = status.tokens[i];
    return {
      label: held
        ? `${sig(held.balance, held.token, 6)} ${held.token.symbol} → ${to}`
        : `${nativeText(transfer.value ?? 0n, chain.viem.nativeCurrency.symbol)} → ${to}`,
      transfer,
    };
  });
}

/**
 * What actually left the account.
 *
 * A withdrawal is several transactions and any of them can fail; "withdrawal
 * failed" would leave the customer unable to tell whether their USDC is at
 * home or still in an account they thought they had emptied.
 */
export function landedNote(steps: WithdrawalStep[], done: number): string {
  if (done <= 0) return 'Nothing left the account.';
  const landed = steps.slice(0, done).map((s) => s.label).join(', ');
  if (done >= steps.length) return `All ${steps.length} sent: ${landed}.`;
  return `${done} of ${steps.length} sent: ${landed}. The rest is still in the trading account.`;
}

/** Where a deposit will come from, and what the wallet holds there. */
export type DepositSource = { chain: ChainConfig; token: Token; balance: bigint };

/**
 * Which chain a deposit leaves from.
 *
 * Nobody picks this. The wallet holds dollars somewhere — usually one place —
 * and the deposit should leave from wherever it holds the most, because that
 * is the only answer that does not require the customer to know which of three
 * dollars they own. Once the money is in the trading account the router moves
 * it as needed, so the choice here costs nothing later.
 *
 * `reachable` is the wallet's limit, not ours: an app can only ask a wallet for
 * a chain it configured, so a chain missing from that list cannot be sent from
 * here however much it holds.
 */
export function depositSource(
  holdings: { chain: ChainKey; token: Token; raw: string }[],
  reachable: ChainKey[],
): DepositSource | null {
  const candidates = CHAIN_LIST.filter((c) => reachable.includes(c.key)).map((chain) => ({
    chain,
    token: chain.usd,
    balance: BigInt(
      holdings.find((h) => h.chain === chain.key && h.token.symbol === chain.usd.symbol)?.raw ?? '0',
    ),
  }));
  if (candidates.length === 0) return null;
  // Ties go to the earlier chain in CHAIN_LIST, which keeps the answer stable
  // across reloads rather than flipping with whatever order a read came back in.
  return candidates.reduce((best, c) => (c.balance > best.balance ? c : best));
}

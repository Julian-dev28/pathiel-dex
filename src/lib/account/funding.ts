/**
 * Getting money into the trading account, and back out again.
 *
 * Both directions are ordinary transfers between two addresses the customer
 * controls, which is the point: there is no deposit to credit, no ledger to
 * update, and nothing to reconcile. Funding is the owner's wallet sending to
 * the derived address. Withdrawing is the derived account sending back. The
 * balance is whatever the chain says it is.
 *
 * What this file does provide is the two things a customer actually needs and
 * that a naive version gets wrong:
 *
 *   - **Gas on arrival.** A trading account holding USDC and no native token
 *     cannot move. Every chain here prices gas in something different — ETH on
 *     Base and Robinhood Chain, OKB on X Layer — so funding has to deliver
 *     both, and the interface has to say so before the customer discovers it.
 *   - **Leaving nothing behind.** A withdrawal that sweeps the token balance
 *     and forgets the dust, or that sends the whole native balance and cannot
 *     pay for its own transaction, strands funds in an account the customer
 *     thought they had emptied.
 */

import { encodeFunctionData, parseAbi, type Address } from 'viem';
import { CHAINS, type ChainConfig, type ChainKey, type Token } from '../chain';
import { erc20Abi } from '../abis';

const ERC20 = parseAbi(erc20Abi);

/**
 * Gas the account should hold before it is asked to trade.
 *
 * Derived from each chain's own fee floor rather than written down, because a
 * number picked by hand is wrong in both directions: too low and a trade dies
 * halfway, too high and the interface tells someone to fund eleven dollars of
 * ETH to make a swap that costs a cent. Each chain prices gas in its own token
 * at its own floor, so the only honest constant here is the work, not the
 * price of it.
 *
 * Three million gas is an approval, a swap, and a withdrawal afterwards, with
 * room for a V4 route's second approval — then ten times over, because a fee
 * floor is a floor and the point of a buffer is the day it is not.
 */
export const GAS_BUDGET = 3_000_000n;
const SPIKE_HEADROOM = 10n;

/**
 * The same figure against a live gas price rather than the chain's fee floor.
 *
 * `GAS_FLOOR` has to assume the worst because it is computed without asking the
 * chain anything, and on a chain whose configured floor is high that assumption
 * is expensive: it once made the router spend eight dollars buying gas for a
 * hundred dollar trade. Where a caller can read the gas price — the router can,
 * before it spends anything — this is the honest number: one full trade cycle,
 * doubled, so the account is not back buying gas on its next trade.
 */
export const gasNeeded = (gasPriceWei: bigint): bigint => gasPriceWei * GAS_BUDGET * 2n;

export const GAS_FLOOR: Record<ChainKey, bigint> = Object.fromEntries(
  Object.values(CHAINS).map((chain) => [
    chain.key,
    chain.fallbackGasWei * GAS_BUDGET * SPIKE_HEADROOM,
  ]),
) as Record<ChainKey, bigint>;

/** A transaction the caller sends, from whichever account owns it. */
export type Transfer = {
  to: Address;
  data?: `0x${string}`;
  value?: bigint;
  chainId: number;
};

/** Move a token from the owner's wallet into the trading account. */
export function fundToken(chain: ChainConfig, token: Token, account: Address, amount: bigint): Transfer {
  return {
    to: token.address,
    data: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [account, amount] }),
    chainId: chain.id,
  };
}

/** Move native currency — the gas the account will spend — into it. */
export const fundGas = (chain: ChainConfig, account: Address, amount: bigint): Transfer => ({
  to: account,
  value: amount,
  chainId: chain.id,
});

/**
 * Is this account able to trade on this chain?
 *
 * Answered separately from "does it have a balance", because the two failures
 * read identically to a customer staring at a button that will not work.
 */
export const canPayGas = (chain: ChainKey, nativeBalance: bigint): boolean =>
  nativeBalance >= GAS_FLOOR[chain];

/** What to top the account up by, or zero when it is already able to trade. */
export const gasShortfall = (chain: ChainKey, nativeBalance: bigint): bigint =>
  nativeBalance >= GAS_FLOOR[chain] ? 0n : GAS_FLOOR[chain] - nativeBalance;

/** Send a token balance back to the owner. */
export function withdrawToken(
  chain: ChainConfig,
  token: Token,
  owner: Address,
  amount: bigint,
): Transfer {
  return {
    to: token.address,
    data: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [owner, amount] }),
    chainId: chain.id,
  };
}

/**
 * Send the remaining native balance back, keeping enough to pay for the send.
 *
 * `balance − gasCost` rather than the balance: a transfer of the entire
 * balance cannot pay for itself and simply fails, which looks to the customer
 * like the withdrawal button being broken. Returns null when there is not
 * enough to cover its own transaction, because sweeping dust costs more than
 * the dust.
 */
export function withdrawGas(
  chain: ChainConfig,
  owner: Address,
  balance: bigint,
  gasPriceWei: bigint,
): Transfer | null {
  // A plain value transfer is 21,000 gas. Double it as headroom against a
  // price that moves between building this and sending it.
  const cost = 21_000n * gasPriceWei * 2n;
  if (balance <= cost) return null;
  return { to: owner, value: balance - cost, chainId: chain.id };
}

/**
 * Everything the account holds on one chain, and whether it can act.
 *
 * Deliberately a plain shape rather than a class: the caller reads balances
 * however it likes — this decides what they mean.
 */
export type AccountStatus = {
  chain: ChainKey;
  nativeBalance: bigint;
  canTrade: boolean;
  shortfall: bigint;
  /** Non-zero token balances, for the withdraw-everything path. */
  tokens: { token: Token; balance: bigint }[];
};

export function statusFor(
  chain: ChainKey,
  nativeBalance: bigint,
  tokens: { token: Token; balance: bigint }[],
): AccountStatus {
  return {
    chain,
    nativeBalance,
    canTrade: canPayGas(chain, nativeBalance),
    shortfall: gasShortfall(chain, nativeBalance),
    tokens: tokens.filter((t) => t.balance > 0n),
  };
}

/**
 * Every transfer needed to empty the account back to the owner.
 *
 * Tokens first, native last: each token transfer costs gas, so sweeping the
 * native balance before them would leave the tokens stranded with nothing to
 * pay their way out. This ordering is the difference between "withdraw
 * everything" meaning it and leaving a balance behind.
 */
export function withdrawEverything(
  chain: ChainConfig,
  owner: Address,
  status: AccountStatus,
  gasPriceWei: bigint,
): Transfer[] {
  const transfers: Transfer[] = status.tokens.map((t) =>
    withdrawToken(chain, t.token, owner, t.balance),
  );
  // What the token transfers are about to consume, so the sweep does not take
  // the gas they still need.
  const reserved = BigInt(status.tokens.length) * 120_000n * gasPriceWei * 2n;
  const sweepable = status.nativeBalance > reserved ? status.nativeBalance - reserved : 0n;
  const sweep = withdrawGas(chain, owner, sweepable, gasPriceWei);
  if (sweep) transfers.push(sweep);
  return transfers;
}

/** The chains an account can be funded on, in the order they are shown. */
export const fundableChains = (): ChainConfig[] => Object.values(CHAINS);

/**
 * Taking margin back out of Hyperliquid, to the same account that owns it.
 *
 * `perp-order.ts` deliberately has no withdrawal path, and that rule holds
 * where it was written: that module signs with an agent key, which Hyperliquid
 * will not honour for a withdrawal anyway, and it runs next to an MCP server
 * where "code that cannot withdraw cannot be talked into withdrawing" is worth
 * more than the convenience.
 *
 * In the browser the calculus changed the moment this app started taking
 * deposits into perp margin. A product that moves a customer's dollars in and
 * offers no way out is a trap, however well-meant — their only recourse being
 * somebody else's interface, for money this app put there.
 *
 * So the exit exists, and the dangerous half of it does not:
 *
 *   - **The destination is the signing account, always.** It is not a parameter
 *     and cannot be passed in. `withdraw3` is the action that can pay a
 *     stranger; with the destination fixed to whoever signs, it can only pay the
 *     owner back. That keeps the property the original rule was protecting.
 *   - **`usdSend` and `spotSend` are still not here.** Those exist only to pay
 *     somebody else, so there is nothing to constrain and no reason to add them.
 *   - **Nothing is sent from this module.** It returns a payload to sign, the
 *     same build-then-sign-then-send split the order path uses.
 *
 * Hyperliquid's own terms apply to the withdrawal itself: it charges a flat fee
 * and takes minutes, which the panel states rather than discovering afterwards.
 */

import type { Address } from 'viem';
import { SIGNATURE_CHAIN_ID, splitSignature } from './hl-sign';
import type { ExchangeRequest } from './perp-order';

/** What Hyperliquid deducts from a withdrawal, in dollars. */
export const WITHDRAW_FEE_USD = 1;

/** The smallest withdrawal worth making, since the fee is flat. */
export const MIN_WITHDRAW_USD = 2;

const ZERO_CONTRACT = '0x0000000000000000000000000000000000000000' as const;

/** The fields the exchange hashes for a withdrawal, in its order. */
const WITHDRAW_FIELDS = [
  { name: 'hyperliquidChain', type: 'string' },
  { name: 'destination', type: 'string' },
  { name: 'amount', type: 'string' },
  { name: 'time', type: 'uint64' },
] as const;

/** Structurally an exchange request like any other: the exchange takes one shape. */
export type WithdrawRequest = ExchangeRequest;

export type PreparedWithdrawal = {
  summary: { usd: number; arrivingUsd: number; destination: Address };
  typedData: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  };
  finalize: (signature: `0x${string}`) => WithdrawRequest;
};

/**
 * Prepare a withdrawal of `usd` back to `owner`.
 *
 * `owner` is the account that will sign this, not a chosen recipient — the
 * caller passes the signer's own address and the payload is built around it, so
 * a mismatch produces a signature Hyperliquid will reject rather than a
 * transfer to somewhere else.
 *
 * `time` is the nonce and is signed, so a prepared withdrawal is stale once it
 * has been sitting: prepare again rather than signing an old one.
 */
export function prepareWithdrawal(owner: Address, usd: number): PreparedWithdrawal {
  if (!Number.isFinite(usd) || usd < MIN_WITHDRAW_USD) {
    throw new Error(
      `Hyperliquid charges a flat $${WITHDRAW_FEE_USD} to withdraw, so anything under $${MIN_WITHDRAW_USD} is not worth moving`,
    );
  }
  const time = Date.now();
  // Five decimals is what the exchange accepts and what it hashes: the string
  // is the signed value, so it has to be built once and reused exactly.
  const amount = usd.toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
  const action = {
    type: 'withdraw3',
    signatureChainId: SIGNATURE_CHAIN_ID,
    hyperliquidChain: 'Mainnet' as const,
    destination: owner.toLowerCase(),
    amount,
    time,
  };

  return {
    summary: { usd, arrivingUsd: Math.max(0, usd - WITHDRAW_FEE_USD), destination: owner },
    typedData: {
      domain: {
        name: 'HyperliquidSignTransaction',
        version: '1',
        chainId: Number(SIGNATURE_CHAIN_ID),
        verifyingContract: ZERO_CONTRACT,
      },
      types: { 'HyperliquidTransaction:Withdraw': [...WITHDRAW_FIELDS] },
      primaryType: 'HyperliquidTransaction:Withdraw',
      message: {
        hyperliquidChain: action.hyperliquidChain,
        destination: action.destination,
        amount: action.amount,
        time,
      },
    },
    finalize: (signature) => ({ action, nonce: time, signature: splitSignature(signature) }),
  };
}

/**
 * Getting money out, which is the only part customers judge you on.
 *
 * A withdrawal is the one operation where a mistake is unrecoverable: a
 * transfer to the wrong address cannot be undone by an apology, and a
 * compromised session that can move funds turns a login bug into a theft. So
 * the destination and the amount are authorised by their own signature rather
 * than by the session that requested them. A stolen session can look at a
 * balance; it cannot send it anywhere.
 *
 * The lifecycle is deliberately more than "deduct and send":
 *
 *   requested → reserved → broadcast → settled
 *                      ↘ released (failed, cancelled, rejected)
 *
 * Reserving debits the customer's spendable balance into a holding account
 * before anything is broadcast, so a trade cannot race the payment, and the
 * money is still *owed* while it is in flight. Settling only on confirmation
 * is what makes a stuck broadcast a retry rather than a balance that vanished.
 *
 * Singapore/MAS shapes two things here. Transfers above the threshold carry
 * originator and beneficiary information (the travel rule), so the fields
 * exist on the request rather than being bolted on later. And customer assets
 * are segregated: a withdrawal is paid from the customer wallet, never from
 * the operational one, which `reconcile.ts` will notice if it ever is.
 */

import { verifyMessage, getAddress, isAddress, type Address } from 'viem';
import { AuthError } from './auth';
import { LedgerError, type LedgerStore } from './ledger';
import { releaseWithdrawal, reserveWithdrawal, settleWithdrawal } from './accounts';

/**
 * MAS's threshold for travel-rule information, in SGD.
 *
 * Above this, a transfer must carry identifying information about both ends.
 * Stored as the policy number it is, rather than buried in a condition, so
 * that changing it is a one-line decision someone can find.
 */
export const TRAVEL_RULE_THRESHOLD_SGD = 1_500;

export type WithdrawalStatus = 'reserved' | 'broadcast' | 'settled' | 'released';

export type WithdrawalRequest = {
  id: string;
  userId: string;
  asset: string;
  /** Minor units of the asset. */
  amount: bigint;
  /** Where the money goes. Signed by the customer, never taken from a session. */
  destination: Address;
  /** Which chain pays it. */
  venue: string;
  nonce: string;
  issuedAt: number;
  /**
   * Required above the travel-rule threshold. Absent below it, rather than
   * collected regardless — data not held cannot leak.
   */
  beneficiary?: { name: string; reference?: string };
  /** The venue's own valuation at request time, for the threshold test. */
  valueSgd?: number;
};

export class WithdrawalError extends Error {}

/**
 * The message the customer signs to authorise this specific payment.
 *
 * Every field that decides where the money goes is in the text, because a
 * signature over a hash the customer cannot read is a signature over
 * whatever the page chose to hash. Amount, asset, destination and chain are
 * all legible in the wallet.
 */
export function withdrawalMessage(req: WithdrawalRequest): string {
  return [
    'Authorise a withdrawal',
    '',
    `Amount: ${req.amount} ${req.asset} (minor units)`,
    `To: ${req.destination}`,
    `Chain: ${req.venue}`,
    `Account: ${req.userId}`,
    `Nonce: ${req.nonce}`,
    `Issued At: ${new Date(req.issuedAt).toISOString()}`,
    '',
    'This moves funds out of your account and cannot be reversed.',
  ].join('\n');
}

/**
 * Check that the customer authorised exactly this payment.
 *
 * The signer must be the account itself: the userId is the customer's address,
 * so a signature from anyone else is not an authorisation no matter who is
 * logged in.
 */
export async function verifyWithdrawal(
  req: WithdrawalRequest,
  signature: `0x${string}`,
): Promise<void> {
  if (!isAddress(req.destination)) throw new WithdrawalError('destination is not an address');
  if (req.amount <= 0n) throw new WithdrawalError('amount must be positive');
  if (needsTravelRuleData(req) && !req.beneficiary?.name) {
    throw new WithdrawalError(
      `withdrawals valued over SGD ${TRAVEL_RULE_THRESHOLD_SGD} require beneficiary information`,
    );
  }
  const valid = await verifyMessage({
    address: getAddress(req.userId) as Address,
    message: withdrawalMessage(req),
    signature,
  }).catch(() => false);
  if (!valid) throw new AuthError('withdrawal was not signed by the account holder');
}

export const needsTravelRuleData = (req: WithdrawalRequest): boolean =>
  (req.valueSgd ?? 0) >= TRAVEL_RULE_THRESHOLD_SGD;

/**
 * Hold the money aside, once the payment is authorised.
 *
 * Refuses an amount the balance cannot cover — the ledger checks that too,
 * and both are worth having: this one gives the customer a usable error, and
 * the ledger's is the one that cannot be bypassed.
 */
export async function requestWithdrawal(
  store: LedgerStore,
  req: WithdrawalRequest,
  signature: `0x${string}`,
): Promise<WithdrawalRequest> {
  await verifyWithdrawal(req, signature);
  try {
    await reserveWithdrawal(store, {
      userId: req.userId,
      asset: req.asset,
      amount: req.amount,
      requestId: req.id,
    });
  } catch (e) {
    if (e instanceof LedgerError) throw new WithdrawalError(e.message);
    throw e;
  }
  return req;
}

/** The payment reached the chain and is confirmed: the money leaves the books. */
export async function confirmWithdrawal(
  store: LedgerStore,
  req: WithdrawalRequest,
  txHash: string,
): Promise<void> {
  await settleWithdrawal(store, {
    userId: req.userId,
    asset: req.asset,
    amount: req.amount,
    requestId: req.id,
    txHash,
  });
}

/**
 * It did not happen: give the money back.
 *
 * A reversing entry rather than an edit, and a reason that stays in the
 * record, because "why did this customer's balance change" is a question a
 * regulator asks in exactly these cases.
 */
export async function abandonWithdrawal(
  store: LedgerStore,
  req: WithdrawalRequest,
  why: string,
): Promise<void> {
  await releaseWithdrawal(store, {
    userId: req.userId,
    asset: req.asset,
    amount: req.amount,
    requestId: req.id,
    why,
  });
}

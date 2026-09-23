/**
 * What a customer can do to their balance, and what they cannot.
 *
 * Each of these is a transfer against the ledger, and each one is a place a
 * custodial venue loses money if it is written carelessly:
 *
 *   - **Crediting a deposit twice.** The chain watcher will see the same
 *     transaction more than once — a restart, a reorg, an overlapping scan
 *     window. The transaction hash is the reference, and the ledger refuses a
 *     reference it has already recorded, so a replay is an error rather than
 *     free money.
 *   - **Debiting a withdrawal that never sent.** Reserving first and settling
 *     on confirmation costs one more state than deducting on send, and it is
 *     the difference between a failed broadcast being a retry and being a
 *     customer whose balance went missing.
 *   - **Letting a balance go negative.** Every debit of a user account is
 *     checked by the store, inside the same transaction that writes it and
 *     under a lock on the account — an earlier check in an earlier transaction
 *     is a check two racing requests both pass.
 *
 * A trade is two transfers, not one: the asset sold leaves the user and the
 * asset bought arrives, with the fee taken as its own entry so revenue is
 * never a rounding difference between two numbers.
 */

import {
  externalAccount,
  poolAccount,
  revenueAccount,
  userAccount,
  LedgerError,
  type AccountId,
  type LedgerStore,
  type Transfer,
} from './ledger';

/** Where the money is, or is going: a chain this venue settles on. */
export type Venue = string;

/**
 * The identity of a deposit.
 *
 * Everything that makes this transfer the transfer it is — chain, transaction,
 * sender, recipient, amount — and last an occurrence, to tell apart two
 * otherwise identical transfers inside one transaction. Nothing here is a
 * position in a block, so a re-mine that renumbers logs produces the same
 * reference and the ledger refuses it as the replay it is.
 */
export const depositReference = (d: {
  venue: Venue;
  txHash: string;
  from: string;
  userId: string;
  amount: bigint;
  occurrence: number;
}): string =>
  `${d.venue}:${d.txHash}:${d.from.toLowerCase()}:${d.userId.toLowerCase()}:${d.amount}:${d.occurrence}`;

const transferId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/**
 * Credit a confirmed deposit.
 *
 * Called only once the transaction has the confirmations the chain deserves —
 * crediting on sight and reorging afterwards is how a venue pays out money it
 * never received. `txHash` is the reference, so a second call for the same
 * transaction is refused by the ledger rather than doubling the balance.
 */
export async function creditDeposit(
  store: LedgerStore,
  args: {
    userId: string;
    asset: string;
    amount: bigint;
    venue: Venue;
    txHash: string;
    /**
     * Which of several identical transfers in this transaction this is.
     *
     * Not a log index. `logIndex` is a position in the *block*, so a re-mine —
     * or two RPC nodes that disagree about ordering, which needs no reorg at
     * all — renumbers the same transfer and it credits a second time. An
     * occurrence counts only among transfers sharing this transaction, sender,
     * recipient and amount, so it survives renumbering and still separates the
     * rare token that emits the same movement twice.
     */
    occurrence: number;
    /** Who sent it. Part of the identity, so a renumbered log is still the same deposit. */
    from: string;
  },
): Promise<void> {
  const { userId, asset, amount, venue, txHash, occurrence, from } = args;
  if (amount <= 0n) throw new LedgerError(`deposit ${txHash}: amount must be positive`);
  await store.append({
    id: transferId('dep'),
    // Value entering the system: the external account is the counterparty, so
    // the pool's credit has a source and the books still sum to zero.
    from: externalAccount(asset),
    to: userAccount(userId, asset),
    asset,
    amount,
    reason: 'deposit',
    // Names the transfer rather than its position: the same movement seen
    // again after a re-mine produces the same reference and is refused, while
    // two genuinely different transfers in one transaction still differ.
    reference: depositReference({ venue, txHash, from, userId, amount, occurrence }),
    at: Date.now(),
  });
}

/**
 * Move a user's balance out of their control while a withdrawal is in flight.
 *
 * The reserve is a real debit to a holding account rather than a flag on a
 * row, so the money cannot be spent twice by a trade racing the withdrawal:
 * a reserved balance is simply not in the user's account any more.
 */
export const withdrawalHold = (userId: string, asset: string): AccountId =>
  // Built through userAccount so the same normalisation and the same refusal
  // of separators apply: a hold that disagreed with its account about casing
  // would reserve money the customer could never get back.
  `${userAccount(userId, asset).replace(/:[^:]+$/, '')}#hold:${asset}`;

export async function reserveWithdrawal(
  store: LedgerStore,
  args: { userId: string; asset: string; amount: bigint; requestId: string },
): Promise<void> {
  const { userId, asset, amount, requestId } = args;
  await store.append({
    id: transferId('hold'),
    from: userAccount(userId, asset),
    to: withdrawalHold(userId, asset),
    asset,
    amount,
    reason: 'withdrawal',
    reference: `reserve:${requestId}`,
    at: Date.now(),
  });
}

/**
 * Settle a withdrawal that reached the chain.
 *
 * The held amount leaves the system: hold to external. Until this runs the
 * money is still on the books, which is what makes a stuck withdrawal a
 * recoverable state rather than a silent loss.
 */
export async function settleWithdrawal(
  store: LedgerStore,
  args: { userId: string; asset: string; amount: bigint; requestId: string; txHash: string },
): Promise<void> {
  const { userId, asset, amount, requestId } = args;
  // Whatever is still held for this request. Settling less than was reserved
  // stranded the remainder forever: owed to the customer, unreachable by them,
  // and counted by reconciliation as an obligation being met.
  const held = await store.balance(withdrawalHold(userId, asset));
  if (amount !== held) {
    throw new LedgerError(
      `withdrawal ${requestId}: settling ${amount} against ${held} reserved would strand the difference`,
    );
  }
  await store.append({
    id: transferId('wd'),
    from: withdrawalHold(userId, asset),
    to: externalAccount(asset),
    asset,
    amount,
    reason: 'withdrawal',
    // Keyed by request, not by transaction: two broadcasts of one withdrawal
    // that both land are one settlement, and a hash in the reference would
    // make them two.
    reference: `settle:${requestId}`,
    at: Date.now(),
  });
}

/**
 * Return a reserved amount when the withdrawal did not happen.
 *
 * A failed broadcast, a rejected transaction, an operator cancelling one. The
 * reversal is its own entry rather than an edit of the reserve, so the history
 * still explains the balance.
 */
export async function releaseWithdrawal(
  store: LedgerStore,
  args: { userId: string; asset: string; amount: bigint; requestId: string; why: string },
): Promise<void> {
  const { userId, asset, amount, requestId, why } = args;
  await store.append({
    id: transferId('rel'),
    from: withdrawalHold(userId, asset),
    to: userAccount(userId, asset),
    asset,
    amount,
    reason: 'correction',
    // The request, not the explanation: two operators writing two different
    // notes about one failed payment must not release the money twice.
    reference: `release:${requestId}`,
    at: Date.now(),
  });
}

/**
 * Record a fill against a user's balances.
 *
 * Two transfers and, where there is one, a fee. The fee is taken from what
 * arrived rather than netted into it, because revenue that is only the
 * difference between two numbers cannot be audited, and a venue that cannot
 * say what it earned cannot say what it owes either.
 */
export async function recordTrade(
  store: LedgerStore,
  args: {
    userId: string;
    venue: Venue;
    sold: { asset: string; amount: bigint };
    bought: { asset: string; amount: bigint };
    feeAsset?: string;
    feeAmount?: bigint;
    reference: string;
  },
): Promise<void> {
  const { userId, venue, sold, bought, feeAsset, feeAmount, reference } = args;
  if (sold.amount <= 0n || bought.amount <= 0n) {
    throw new LedgerError(`trade ${reference}: both sides must be positive`);
  }

  const at = Date.now();
  const legs: Transfer[] = [
    {
      id: transferId('sell'),
      from: userAccount(userId, sold.asset),
      to: poolAccount(venue, sold.asset),
      asset: sold.asset,
      amount: sold.amount,
      reason: 'trade',
      reference: `${reference}:sold`,
      at,
    },
    {
      id: transferId('buy'),
      from: poolAccount(venue, bought.asset),
      to: userAccount(userId, bought.asset),
      asset: bought.asset,
      amount: bought.amount,
      reason: 'trade',
      reference: `${reference}:bought`,
      at,
    },
  ];

  if (feeAsset && feeAmount && feeAmount > 0n) {
    legs.push({
      id: transferId('fee'),
      from: userAccount(userId, feeAsset),
      to: revenueAccount(feeAsset),
      asset: feeAsset,
      amount: feeAmount,
      reason: 'fee',
      reference: `${reference}:fee`,
      at,
    });
  }

  // One act, not three. Written separately, a failure on the second or third
  // leg left the first committed: the customer debited for an asset that never
  // arrived, an error claiming nothing had happened, a retry the duplicate
  // index refused, and a reconciliation that still read balanced because the
  // books did sum to zero. The store's balance check runs inside the same
  // transaction, so the fee can no longer be spent against a balance the trade
  // itself emptied.
  await store.appendAll(legs);
}

/** Everything a customer holds, for the account screen. */
export async function portfolio(
  store: LedgerStore,
  userId: string,
  assets: string[],
): Promise<{ asset: string; available: bigint; reserved: bigint }[]> {
  return Promise.all(
    assets.map(async (asset) => ({
      asset,
      available: await store.balance(userAccount(userId, asset)),
      reserved: await store.balance(withdrawalHold(userId, asset)),
    })),
  );
}

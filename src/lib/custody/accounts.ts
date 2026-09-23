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
 *     checked against the balance the ledger derives, not against a cached
 *     figure, and two requests racing to spend the same dollar must not both
 *     succeed. That last part is the store's job; see the note on `spend`.
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
  args: { userId: string; asset: string; amount: bigint; venue: Venue; txHash: string },
): Promise<void> {
  const { userId, asset, amount, venue, txHash } = args;
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
    reference: `${venue}:${txHash}`,
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
  `user:${userId}#hold:${asset}`;

export async function reserveWithdrawal(
  store: LedgerStore,
  args: { userId: string; asset: string; amount: bigint; requestId: string },
): Promise<void> {
  const { userId, asset, amount, requestId } = args;
  await spend(store, userId, asset, amount);
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
  const { userId, asset, amount, requestId, txHash } = args;
  await store.append({
    id: transferId('wd'),
    from: withdrawalHold(userId, asset),
    to: externalAccount(asset),
    asset,
    amount,
    reason: 'withdrawal',
    reference: `settle:${requestId}:${txHash}`,
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
    reference: `release:${requestId}:${why}`,
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
  await spend(store, userId, sold.asset, sold.amount);

  const at = Date.now();
  await store.append({
    id: transferId('sell'),
    from: userAccount(userId, sold.asset),
    to: poolAccount(venue, sold.asset),
    asset: sold.asset,
    amount: sold.amount,
    reason: 'trade',
    reference: `${reference}:sold`,
    at,
  });
  await store.append({
    id: transferId('buy'),
    from: poolAccount(venue, bought.asset),
    to: userAccount(userId, bought.asset),
    asset: bought.asset,
    amount: bought.amount,
    reason: 'trade',
    reference: `${reference}:bought`,
    at,
  });

  if (feeAsset && feeAmount && feeAmount > 0n) {
    await spend(store, userId, feeAsset, feeAmount);
    await store.append({
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
}

/**
 * Refuse to take more from an account than it holds.
 *
 * Read-then-write, which is a race on its own: two requests can both read a
 * sufficient balance and both proceed. This check is the second line, not the
 * first — the store must serialise transfers against the same account (a
 * transaction at serializable isolation, or a row lock on the account). The
 * check stays because a guard that is cheap and occasionally redundant is
 * worth more than one that is absent when the locking is misconfigured.
 */
async function spend(
  store: LedgerStore,
  userId: string,
  asset: string,
  amount: bigint,
): Promise<void> {
  const account = userAccount(userId, asset);
  const available = await store.balance(account);
  if (available < amount) {
    throw new LedgerError(
      `${account} holds ${available} of ${asset}, cannot spend ${amount}`,
    );
  }
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

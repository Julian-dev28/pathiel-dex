/**
 * Does the venue actually hold what it says it owes?
 *
 * This is the question a custodial business exists to be able to answer, and
 * the one that distinguishes a shortfall found on a Tuesday from a shortfall
 * found by a customer trying to withdraw. The ledger says what is owed; the
 * chains and the exchange say what is held; reconciliation is the subtraction.
 *
 * Two properties make the answer meaningful rather than reassuring:
 *
 *   - **It is derived from entries, not from a balances table.** A stored
 *     balance that drifted would agree with itself forever.
 *   - **A surplus is reported, not ignored.** Holding more than is owed sounds
 *     harmless and usually means a deposit arrived that nobody credited — a
 *     customer is missing money they sent, which is the same bug as a
 *     shortfall wearing a friendlier face.
 *
 * Nothing here moves money or corrects anything. A discrepancy is a fact to
 * put in front of an operator; a program that quietly writes a correcting
 * entry to make its own books balance has destroyed the evidence of whatever
 * caused it.
 */

import { accountKind, type Entry, type LedgerStore } from './ledger';

/** What the venue holds somewhere real, as read from that place. */
export type OnChainHolding = {
  /** Chain key, or the exchange's name for a venue account. */
  venue: string;
  asset: string;
  /** Minor units, read from the chain or the venue's API. */
  amount: bigint;
};

export type AssetReconciliation = {
  asset: string;
  /** The sum of every customer's balance, including amounts held for withdrawal. */
  owed: bigint;
  /** What the pooled wallets and venue accounts actually hold. */
  held: bigint;
  /** held − owed. Negative is a shortfall: customers are owed more than exists. */
  difference: bigint;
  status: 'balanced' | 'shortfall' | 'surplus';
  /** Fees earned and not yet swept, which are held but not owed to customers. */
  revenue: bigint;
  /**
   * The venue's own position in this asset.
   *
   * A customer selling USDC for NVDA hands the venue dollars and takes shares
   * from it, so between the fill and the hedge the venue is long dollars and
   * short shares. That inventory is held but owed to nobody, and reading it as
   * a surplus in one asset and a shortfall in the other would make every
   * unhedged trade look like a solvency event.
   */
  inventory: bigint;
  /**
   * What the venue has ever taken in, less what it has paid out.
   *
   * An independent statement of the same fact, and the reason this report can
   * detect anything at all. Because the books sum to zero, owed + revenue +
   * inventory is identically −external, so comparing the wallets against that
   * sum compares them against nothing but themselves — a half-applied trade
   * that moved value from a customer to the pool passes it without a murmur.
   * Checking `held` against net flows *and* against what customers are owed
   * gives two different ways to be wrong.
   */
  netDeposited: bigint;
  /**
   * The venue is holding a position of its own in this asset.
   *
   * Between a fill and its hedge that is ordinary. Persisting, it is not: an
   * unhedged position is the venue carrying market risk against customer
   * money, and a large one usually means a hedge that never executed. Reported
   * rather than judged, because how long is too long is an operator's policy
   * and not this function's to decide.
   *
   * Deliberately not a "the books do not add up" check: owed + revenue +
   * inventory is identically −external for a ledger that sums to zero, so such
   * a check could never fail and would be reassurance rather than evidence.
   */
  unhedged: boolean;
};

/**
 * Compare one asset's books against its holdings.
 *
 * `owed` counts user accounts and withdrawal holds together: money reserved
 * for a withdrawal that has not left yet is still the venue's obligation, and
 * excluding it would make the books look balanced precisely while a payment
 * is in flight.
 */
export function reconcileAsset(
  entries: Entry[],
  holdings: OnChainHolding[],
  asset: string,
): AssetReconciliation {
  let owed = 0n;
  let revenue = 0n;
  let inventory = 0n;
  let external = 0n;
  for (const e of entries) {
    if (e.asset !== asset) continue;
    // `user:<id>:<asset>` and `user:<id>#hold:<asset>` are both obligations.
    if (accountKind(e.account) === 'user') owed += e.amount;
    if (accountKind(e.account) === 'revenue') revenue += e.amount;
    if (accountKind(e.account) === 'pool') inventory += e.amount;
    if (accountKind(e.account) === 'external') external += e.amount;
  }
  const netDeposited = -external;
  const held = holdings
    .filter((h) => h.asset === asset)
    .reduce((sum, h) => sum + h.amount, 0n);

  // Everything the wallets hold is owed to a customer, earned as a fee, or the
  // venue's own inventory. A venue that forgot the middle term would read its
  // own fees as a surplus and eventually as an excuse for a shortfall; one
  // that forgot the last would see a solvency event every time a fill waited
  // on its hedge.
  const difference = held - netDeposited;

  const unhedged = inventory !== 0n;

  return {
    asset,
    owed,
    held,
    difference,
    revenue,
    inventory,
    netDeposited,
    unhedged,
    status: difference === 0n ? 'balanced' : difference < 0n ? 'shortfall' : 'surplus',
  };
}

/** Every asset the books or the wallets mention. */
export async function reconcile(
  store: LedgerStore,
  holdings: OnChainHolding[],
): Promise<AssetReconciliation[]> {
  const entries = await store.allEntries();
  const assets = new Set<string>([...entries.map((e) => e.asset), ...holdings.map((h) => h.asset)]);
  return [...assets]
    .sort()
    .map((asset) => reconcileAsset(entries, holdings, asset));
}

/**
 * Is it safe to keep trading?
 *
 * A shortfall in any asset means the venue cannot honour its obligations, and
 * the correct response is to stop taking new risk rather than to trade through
 * it hoping the next fill closes the gap. Whoever calls this decides what
 * stopping means; the point is that the condition is checkable in one line and
 * has an unambiguous answer.
 */
export const isSolvent = (report: AssetReconciliation[]): boolean =>
  report.every((r) => r.status !== 'shortfall');

/**
 * Is the venue carrying no position of its own?
 *
 * Solvency says the wallets cover what is owed. This says the venue is not
 * also holding market risk against that money — which after a hedge has run
 * it should not be.
 */
export const isFlat = (report: AssetReconciliation[]): boolean =>
  report.every((r) => !r.unhedged);

/** One line per asset, for an operator or an alert. */
export const describe = (r: AssetReconciliation): string =>
  r.status === 'balanced'
    ? r.unhedged
      ? `${r.asset}: balanced at ${r.owed} owed, with an unhedged position of ${r.inventory}`
      : `${r.asset}: balanced at ${r.owed} owed`
    : `${r.asset}: ${r.status} of ${r.difference < 0n ? -r.difference : r.difference} — owed ${r.owed}, held ${r.held}, revenue ${r.revenue}, inventory ${r.inventory}`;

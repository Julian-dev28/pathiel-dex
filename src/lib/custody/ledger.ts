/**
 * The ledger: who owns what, and why.
 *
 * Holding other people's money makes this the product and the router a
 * component of it. Everything downstream — a deposit, a fill, a withdrawal —
 * is an accounting event before it is anything else, and the failure that
 * matters in a custodial system is not a bad swap. It is the ledger and the
 * chain quietly disagreeing: a deposit credited twice, a withdrawal that
 * debited and never sent, a fill attributed to the wrong account. Those do not
 * announce themselves. They surface weeks later as a shortfall.
 *
 * So the design is double entry, and balances are **derived** rather than
 * stored:
 *
 *   - Every movement is a transfer between two accounts, written as two
 *     entries that sum to zero. There is no way to create value by writing a
 *     single row, which is the whole point — a credit to a user is always a
 *     debit of the pool that backs it.
 *   - Entries are immutable. A mistake is corrected by a reversing entry, not
 *     by an edit, so the history remains the explanation of the balance.
 *   - A balance is the sum of that account's entries. It cannot drift from its
 *     entries, because it is not a separate number that could.
 *
 * What that buys is a solvency check that means something: sum every user
 * balance, compare against what the pooled wallets actually hold on chain, and
 * a discrepancy is arithmetic rather than an opinion. See `reconcile.ts`.
 *
 * Amounts are integer minor units of the asset (USDC to six places, and so on)
 * held as bigint. Floating point has no place in a ledger; a tenth of a cent
 * lost per trade to binary rounding is both a real loss and an unprovable one.
 */

/** Which pot an entry moves value into or out of. */
export type AccountKind =
  /** A customer's claim on the pool. The sum of these is what is owed. */
  | 'user'
  /** Funds the venue holds on chain, per chain and asset. */
  | 'pool'
  /** Fees earned, taken out of a trade rather than conjured. */
  | 'revenue'
  /**
   * The counterparty for value entering or leaving the system entirely: a
   * deposit arriving from outside, a withdrawal leaving. Its balance is the
   * negative of everything the venue has ever taken in, which is a useful
   * check in itself.
   */
  | 'external';

/**
 * An account is a kind plus a subject: a user id, a chain, a venue.
 *
 * Flat strings rather than a nested structure because this is a key, and a key
 * that can be compared, indexed and summed by a database is worth more than
 * one that reads nicely in TypeScript.
 */
export type AccountId = string;

/**
 * Account ids are built by concatenation, so the parts must not contain the
 * separators.
 *
 * Two failures, both silent. A userId containing `#hold` produces the same id
 * as another customer's reserved funds. And an address in two different cases
 * is two different accounts: deposits credited to one, withdrawals attempted
 * from the other, reconciliation reporting balanced while the money sits
 * somewhere the customer cannot reach.
 */
function part(value: string, what: string): string {
  if (value.includes(':') || value.includes('#')) {
    throw new LedgerError(`${what} may not contain ':' or '#': ${value}`);
  }
  return value;
}

/** Addresses are compared case-insensitively; everything else is taken as given. */
const normaliseUser = (userId: string): string =>
  /^0x[0-9a-fA-F]{40}$/.test(userId) ? userId.toLowerCase() : userId;

export const userAccount = (userId: string, asset: string): AccountId =>
  `user:${normaliseUser(part(userId, 'userId'))}:${part(asset, 'asset')}`;
export const poolAccount = (chain: string, asset: string): AccountId => `pool:${chain}:${asset}`;
export const revenueAccount = (asset: string): AccountId => `revenue:${asset}`;
export const externalAccount = (asset: string): AccountId => `external:${asset}`;

export const accountKind = (id: AccountId): AccountKind => id.split(':')[0] as AccountKind;
export const accountAsset = (id: AccountId): string => id.split(':').at(-1) ?? '';

/** Why value moved. Enough to explain any balance without reading code. */
export type EntryReason =
  | 'deposit'
  | 'withdrawal'
  | 'trade'
  | 'fee'
  | 'transfer'
  | 'correction';

/**
 * One side of a movement.
 *
 * `amount` is signed: positive credits the account, negative debits it. The
 * two sides of a transfer carry the same `transferId`, and their amounts sum
 * to zero.
 */
export type Entry = {
  id: string;
  transferId: string;
  account: AccountId;
  asset: string;
  amount: bigint;
  reason: EntryReason;
  /**
   * What in the outside world this corresponds to — a transaction hash, an
   * exchange order id. The handle a reconciliation uses to ask "did this
   * actually happen", and what makes a replayed deposit detectable.
   */
  reference?: string;
  at: number;
};

/** A movement of value between exactly two accounts. */
export type Transfer = {
  id: string;
  from: AccountId;
  to: AccountId;
  asset: string;
  /** Always positive; direction is carried by `from` and `to`. */
  amount: bigint;
  reason: EntryReason;
  reference?: string;
  at: number;
};

export class LedgerError extends Error {}

/**
 * This movement has already been recorded.
 *
 * A distinct type rather than a message, because callers act on it. The
 * deposit watcher credits unconditionally and treats this as the expected
 * answer when it sees a transaction twice; anything else is a real failure
 * that must stop the scan. If the two were told apart by matching words, a
 * store that phrased its unique-violation differently would turn every
 * harmless replay into a stuck watcher re-scanning the same range forever
 * while deposits went uncredited.
 */
export class DuplicateReference extends LedgerError {
  constructor(
    readonly duplicateReason: EntryReason,
    readonly reference: string,
  ) {
    super(`${duplicateReason} ${reference} is already recorded`);
  }
}

/**
 * Turn a transfer into the two entries that record it.
 *
 * Every rule that protects the ledger lives here, because this is the only
 * way entries are made. A caller cannot write a single-sided entry, a negative
 * amount, or a transfer from an account to itself, because there is no path
 * that would let it.
 */
export function entriesFor(transfer: Transfer): [Entry, Entry] {
  const { id, from, to, asset, amount, reason, reference, at } = transfer;
  if (amount <= 0n) {
    throw new LedgerError(`transfer ${id}: amount must be positive, got ${amount}`);
  }
  if (from === to) {
    throw new LedgerError(`transfer ${id}: from and to are the same account (${from})`);
  }
  // An asset mismatch would let a dollar be credited as a share. The accounts
  // carry their asset in the key precisely so this is checkable.
  for (const account of [from, to]) {
    if (accountAsset(account) !== asset) {
      throw new LedgerError(`transfer ${id}: account ${account} does not hold ${asset}`);
    }
  }
  return [
    { id: `${id}:from`, transferId: id, account: from, asset, amount: -amount, reason, reference, at },
    { id: `${id}:to`, transferId: id, account: to, asset, amount, reason, reference, at },
  ];
}

/** The balance of one account: the sum of its entries, and nothing else. */
export function balanceOf(entries: Entry[], account: AccountId): bigint {
  return entries.reduce((sum, e) => (e.account === account ? sum + e.amount : sum), 0n);
}

/** Every account's balance in one pass, for a reconciliation or a report. */
export function balances(entries: Entry[]): Map<AccountId, bigint> {
  const out = new Map<AccountId, bigint>();
  for (const e of entries) out.set(e.account, (out.get(e.account) ?? 0n) + e.amount);
  return out;
}

/**
 * Does the whole ledger still sum to zero, per asset?
 *
 * It must, by construction — every entry has a counterpart. A non-zero total
 * means entries were written by something other than `entriesFor`, or that
 * some were lost. Either is a reason to stop rather than to carry on serving
 * balances nobody can justify.
 */
export function isBalanced(entries: Entry[]): boolean {
  const perAsset = new Map<string, bigint>();
  for (const e of entries) perAsset.set(e.asset, (perAsset.get(e.asset) ?? 0n) + e.amount);
  return [...perAsset.values()].every((total) => total === 0n);
}

/** What the venue owes its customers in one asset. */
export function totalOwed(entries: Entry[], asset: string): bigint {
  return entries.reduce(
    (sum, e) => (e.asset === asset && accountKind(e.account) === 'user' ? sum + e.amount : sum),
    0n,
  );
}

/**
 * Where a ledger is kept.
 *
 * An interface because the domain rules above are worth testing without a
 * database, and because the one guarantee the storage must provide —
 * `append` is atomic across both entries, or neither is written — is a
 * property of the store rather than of this file. A ledger that can write one
 * side of a transfer and fail on the other is not a ledger.
 */
export interface LedgerStore {
  /**
   * Write both entries of a transfer, atomically.
   *
   * Rejects a `reference` already recorded for the same reason, which is what
   * makes crediting a deposit idempotent: the chain watcher can see the same
   * transaction twice, and the second attempt must not create money.
   */
  append(transfer: Transfer): Promise<[Entry, Entry]>;
  /**
   * Write several transfers as one indivisible act — all of them, or none.
   *
   * A trade is not one movement. The asset sold leaves, the asset bought
   * arrives, and a fee is taken, and a customer whose sold leg committed while
   * the bought leg failed has simply lost the money: the error says nothing
   * happened, the retry is refused because the reference is already recorded,
   * and reconciliation reports balanced because the books still sum to zero.
   * That is not a hypothetical — one dropped connection does it.
   *
   * So any operation with more than one leg uses this, and the store is
   * responsible for the transaction boundary.
   */
  appendAll(transfers: Transfer[]): Promise<Entry[]>;
  balance(account: AccountId): Promise<bigint>;
  entriesFor(account: AccountId, limit?: number): Promise<Entry[]>;
  /** Every entry for an asset, for reconciliation and solvency checks. */
  allEntries(asset?: string): Promise<Entry[]>;
}

/**
 * Would this transfer overdraw the account it debits?
 *
 * Only customer accounts are checked: `external` is the counterparty for value
 * entering the system and `pool` carries the venue's own position, and both are
 * meant to run negative. Shared by every store so that local development
 * cannot be more permissive than production — a memory store without this
 * mints money while Postgres refuses, and anything proven against it proves
 * nothing.
 */
export function overdraws(transfer: Transfer, balanceOfDebited: bigint): boolean {
  return accountKind(transfer.from) === 'user' && balanceOfDebited < transfer.amount;
}

/**
 * An in-memory store.
 *
 * For tests and for local development, not for holding anyone's money: it
 * forgets everything when the process ends. It exists so the rules above can
 * be exercised exhaustively without Postgres, and so a caller written against
 * the interface is proven to work before the real store is wired in.
 */
export class MemoryLedger implements LedgerStore {
  private entries: Entry[] = [];
  private seenReferences = new Set<string>();

  async append(transfer: Transfer): Promise<[Entry, Entry]> {
    const [pair] = await this.write([transfer]);
    return pair;
  }

  async appendAll(transfers: Transfer[]): Promise<Entry[]> {
    const written = await this.write(transfers);
    return written.flat();
  }

  /**
   * Validate everything, then commit everything.
   *
   * Two passes rather than one so a rejection on the third transfer cannot
   * leave the first two written — the same guarantee Postgres gets from its
   * transaction, which is what makes the two stores interchangeable.
   */
  private async write(transfers: Transfer[]): Promise<[Entry, Entry][]> {
    const pending: [Entry, Entry][] = [];
    const keys: string[] = [];
    // A running view of the balances this batch touches, so two legs debiting
    // the same account inside one trade are checked against each other.
    const provisional = new Map<AccountId, bigint>();

    for (const transfer of transfers) {
      const key = transfer.reference ? `${transfer.reason}:${transfer.reference}` : null;
      if (key && (this.seenReferences.has(key) || keys.includes(key))) {
        throw new DuplicateReference(transfer.reason, transfer.reference!);
      }
      const current =
        provisional.get(transfer.from) ?? balanceOf(this.entries, transfer.from);
      if (overdraws(transfer, current)) {
        throw new LedgerError(
          `${transfer.from} holds ${current} of ${transfer.asset}, cannot spend ${transfer.amount}`,
        );
      }
      const pair = entriesFor(transfer);
      provisional.set(transfer.from, current - transfer.amount);
      provisional.set(
        transfer.to,
        (provisional.get(transfer.to) ?? balanceOf(this.entries, transfer.to)) + transfer.amount,
      );
      pending.push(pair);
      if (key) keys.push(key);
    }

    for (const pair of pending) this.entries.push(...pair);
    for (const key of keys) this.seenReferences.add(key);
    return pending;
  }

  async balance(account: AccountId): Promise<bigint> {
    return balanceOf(this.entries, account);
  }

  async entriesFor(account: AccountId, limit = 100): Promise<Entry[]> {
    return this.entries.filter((e) => e.account === account).slice(-limit).reverse();
  }

  async allEntries(asset?: string): Promise<Entry[]> {
    return asset ? this.entries.filter((e) => e.asset === asset) : [...this.entries];
  }
}

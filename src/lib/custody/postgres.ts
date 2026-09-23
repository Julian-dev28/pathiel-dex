/**
 * The ledger, kept in Postgres.
 *
 * `MemoryLedger` proves the rules; this proves they survive two processes and
 * a crash. Everything specific to a database is here, and it is mostly one
 * question: what stops two requests spending the same dollar?
 *
 * **The choice: a row lock, at READ COMMITTED.** `append` takes
 * `SELECT ... FOR UPDATE` on the debited account's row in `ledger_accounts`,
 * then re-derives that account's balance inside the same transaction and
 * refuses a debit the balance cannot fund.
 *
 * Both halves are necessary and neither is sufficient:
 *
 *   - The lock alone would not help, because the balance check the callers in
 *     `accounts.ts` make happens in a different transaction, before this one
 *     opens. Two trades can both read a sufficient balance and both arrive
 *     here. The last line of defence has to be inside the transaction that
 *     writes.
 *   - The re-check alone would not help either. Without the lock, two
 *     transactions read the same balance concurrently and both pass it — the
 *     classic read-then-write race, which under load looks exactly like a
 *     design that works.
 *
 * READ COMMITTED is part of the choice rather than a default left alone: after
 * `FOR UPDATE` returns, each new statement sees what the transaction that held
 * the lock committed, so the sum that follows includes its entries. At
 * REPEATABLE READ or SERIALIZABLE the sum would be taken from a snapshot older
 * than the lock and miss exactly the spend we are guarding against. The
 * alternative design — SERIALIZABLE everywhere plus a retry loop on
 * serialization_failure (40001) — is defensible, but it puts a retry at every
 * call site and a retried transfer is a correctness question of its own. One
 * lock, held briefly, on the one row that the conflict is about, is the
 * smaller thing to get right.
 *
 * Only the debited account is locked, so a transaction never holds two locks
 * and the deadlock this would otherwise invite cannot occur. A credit only
 * ever raises a balance, so nothing is racing to protect there.
 */

import type { Pool } from 'pg';
import {
  accountKind,
  DuplicateReference,
  entriesFor,
  LedgerError,
  type AccountId,
  type Entry,
  type EntryReason,
  type LedgerStore,
  type Transfer,
} from './ledger';

type Row = Record<string, unknown>;

/** The part of a Postgres client this store uses. */
export interface Sql {
  query(text: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

export interface Database extends Sql {
  /** Runs `fn` in one transaction, committing on return and rolling back on throw. */
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
}

/** Adapt a `pg` pool, which is how this runs anywhere that is not a test. */
export const pgDatabase = (pool: Pool): Database => ({
  query: (text, params) => pool.query(text, params),
  async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      // Stated, never inherited. The guard below re-derives a balance after
      // taking a row lock, and that only sees the spend it is guarding against
      // at READ COMMITTED: at REPEATABLE READ or SERIALIZABLE the sum comes
      // from a snapshot older than the lock and misses it entirely. One
      // `ALTER DATABASE ... SET default_transaction_isolation` would otherwise
      // turn the only real double-spend defence into a no-op, silently.
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
});

// Amounts and timestamps are read back as text and parsed here. A driver that
// decided a NUMERIC was a JS number would round a wei amount silently, and
// silently is the way a ledger loses money.
const COLUMNS = 'id, transfer_id, account, asset, amount::text AS amount, reason, reference, at::text AS at';

const toEntry = (row: Row): Entry => ({
  id: String(row.id),
  transferId: String(row.transfer_id),
  account: String(row.account),
  asset: String(row.asset),
  amount: BigInt(String(row.amount)),
  reason: String(row.reason) as EntryReason,
  reference: row.reference === null ? undefined : String(row.reference),
  at: Number(row.at),
});

/**
 * Was this the reference index, specifically?
 *
 * 23505 is any unique violation, and the caller has to tell a replayed deposit
 * from a reused transfer id: the deposit watcher credits unconditionally and
 * treats a duplicate as "already done, move the cursor on". A watcher that
 * cannot distinguish the two stops advancing and rescans the same range for
 * ever, which reads as an outage while deposits go uncredited. So match the
 * constraint, not the code, and never the message.
 */
const isDuplicateReference = (error: unknown): boolean => {
  const failure = error as { code?: string; constraint?: string } | null;
  return failure?.code === '23505' && failure.constraint === 'ledger_entries_reference';
};

const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: string } | null)?.code === '23505';

export class PostgresLedger implements LedgerStore {
  constructor(private readonly db: Database) {}

  async append(transfer: Transfer): Promise<[Entry, Entry]> {
    // The domain rules first, outside the transaction: a malformed transfer
    // should never have opened one.
    const [pair] = await this.writeAll([transfer]);
    return pair;
  }

  /**
   * Several transfers, one transaction: all of them or none.
   *
   * A trade's legs must not be able to land separately. Writing them one at a
   * time left a customer debited for an asset they never received, with an
   * error claiming nothing had happened and a retry the duplicate index
   * refused — money gone, books balanced, reconciliation clean.
   */
  async appendAll(transfers: Transfer[]): Promise<Entry[]> {
    const written = await this.writeAll(transfers);
    return written.flat();
  }

  private async writeAll(transfers: Transfer[]): Promise<[Entry, Entry][]> {
    const prepared = transfers.map((transfer) => ({ transfer, pair: entriesFor(transfer) }));

    return this.db.transaction(async (tx) => {
      const out: [Entry, Entry][] = [];
      for (const { transfer, pair } of prepared) {
        const [debit] = pair;
        await this.writeOne(tx, transfer, pair, debit);
        out.push(pair);
      }
      return out;
    });
  }

  private async writeOne(
    tx: Sql,
    transfer: Transfer,
    pair: [Entry, Entry],
    debit: Entry,
  ): Promise<void> {
    {
      await tx.query('INSERT INTO ledger_accounts (id) VALUES ($1) ON CONFLICT DO NOTHING', [
        debit.account,
      ]);
      await tx.query('SELECT id FROM ledger_accounts WHERE id = $1 FOR UPDATE', [debit.account]);

      // Pool and external accounts are meant to run negative — external holds
      // the negative of everything ever deposited. A customer's account and
      // their withdrawal hold are the ones that must not.
      if (accountKind(debit.account) === 'user') {
        const held = await this.sum(tx, debit.account);
        if (held < transfer.amount) {
          throw new LedgerError(
            `${debit.account} holds ${held} of ${transfer.asset}, cannot spend ${transfer.amount}`,
          );
        }
      }

      try {
        await tx.query(
          `INSERT INTO ledger_entries (id, transfer_id, account, asset, amount, reason, reference, at)
           VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, $8),
                  ($9, $10, $11, $12, $13::numeric, $14, $15, $16)`,
          pair.flatMap((e) => [
            e.id,
            e.transferId,
            e.account,
            e.asset,
            e.amount.toString(),
            e.reason,
            e.reference ?? null,
            e.at,
          ]),
        );
      } catch (error) {
        if (isDuplicateReference(error) && transfer.reference !== undefined) {
          throw new DuplicateReference(transfer.reason, transfer.reference);
        }
        // The other way to collide is a reused transfer id, which is a caller
        // bug rather than a replay, and must not be reported as one.
        if (isUniqueViolation(error)) {
          throw new LedgerError(`transfer ${transfer.id}: this transfer is already written`);
        }
        throw error;
      }
    }
  }

  async balance(account: AccountId): Promise<bigint> {
    return this.sum(this.db, account);
  }

  async entriesFor(account: AccountId, limit = 100): Promise<Entry[]> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNS} FROM ledger_entries WHERE account = $1 ORDER BY seq DESC LIMIT $2`,
      [account, limit],
    );
    return rows.map(toEntry);
  }

  async allEntries(asset?: string): Promise<Entry[]> {
    const { rows } = asset
      ? await this.db.query(
          `SELECT ${COLUMNS} FROM ledger_entries WHERE asset = $1 ORDER BY seq`,
          [asset],
        )
      : await this.db.query(`SELECT ${COLUMNS} FROM ledger_entries ORDER BY seq`);
    return rows.map(toEntry);
  }

  private async sum(sql: Sql, account: AccountId): Promise<bigint> {
    const { rows } = await sql.query(
      'SELECT COALESCE(SUM(amount), 0)::text AS balance FROM ledger_entries WHERE account = $1',
      [account],
    );
    return BigInt(String(rows[0].balance));
  }
}

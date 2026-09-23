/**
 * Tests for the Postgres ledger, run against Postgres.
 *
 * PGlite is the real engine compiled to wasm, so `schema.sql` is executed as
 * written and the constraints that matter — a unique index, a rollback, a
 * NUMERIC(78,0) — are enforced by the database rather than by a fake that
 * agrees with whatever this file assumes. A hand-rolled mock would pass every
 * test below and prove nothing.
 *
 * The suite has two halves. The first re-runs the behaviour `MemoryLedger`
 * already passes against *both* stores, so the two are shown to be
 * interchangeable instead of assumed to be: a caller written against
 * `LedgerStore` cannot tell them apart. The second attacks what only a
 * database can get wrong.
 *
 * One honest limit: PGlite is a single connection, so two transactions here
 * run one after the other rather than contending for a lock. That still
 * exercises the guard that decides the race — the second transaction reads the
 * first one's committed entries and refuses — but it does not exercise
 * `FOR UPDATE` blocking a concurrent backend, which needs a real server.
 */

import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  DuplicateReference,
  MemoryLedger,
  balanceOf,
  balances,
  externalAccount,
  isBalanced,
  poolAccount,
  revenueAccount,
  totalOwed,
  userAccount,
  type LedgerStore,
  type Transfer,
} from '@/lib/custody/ledger';
import { PostgresLedger, type Database, type Sql } from '@/lib/custody/postgres';
import {
  creditDeposit,
  portfolio,
  recordTrade,
  releaseWithdrawal,
  reserveWithdrawal,
  settleWithdrawal,
  withdrawalHold,
} from '@/lib/custody/accounts';
import { isSolvent, reconcile, reconcileAsset } from '@/lib/custody/reconcile';

const schema = readFileSync(new URL('../src/lib/custody/schema.sql', import.meta.url), 'utf8');

/**
 * PGlite's transaction resolves to `T | undefined` because it can be aborted;
 * ours does not, which is the whole difference between the two interfaces.
 */
const adapt = (db: PGlite): Database => ({
  query: (text, params) => db.query(text, params),
  transaction: async <T,>(fn: (tx: Sql) => Promise<T>): Promise<T> =>
    (await db.transaction(fn)) as T,
});

const freshPostgres = async () => {
  const db = new PGlite();
  await db.exec(schema);
  return { db, store: new PostgresLedger(adapt(db)) };
};

const postgresLedger = async (): Promise<LedgerStore> => (await freshPostgres()).store;
const memoryLedger = async (): Promise<LedgerStore> => new MemoryLedger();

const deposit = (over: Partial<Transfer> = {}): Transfer => ({
  id: 'd1',
  from: externalAccount('USDC'),
  to: userAccount('alice', 'USDC'),
  asset: 'USDC',
  amount: 1_000_000n,
  reason: 'deposit',
  reference: 'base:0xdep#0',
  at: 1,
  ...over,
});

describe.each([
  ['memory', memoryLedger],
  ['postgres', postgresLedger],
])('a %s ledger under ordinary use', (_name, make) => {
  const setup = async () => {
    const ledger = await make();
    await creditDeposit(ledger, {
      userId: 'alice',
      asset: 'USDC',
      amount: 1_000_000_000n, // $1,000
      venue: 'base',
      txHash: '0xdep1',
      logIndex: 0,
    });
    return ledger;
  };

  it('credits a deposit and owes it', async () => {
    const ledger = await setup();
    expect(await ledger.balance(userAccount('alice', 'USDC'))).toBe(1_000_000_000n);
    expect(totalOwed(await ledger.allEntries(), 'USDC')).toBe(1_000_000_000n);
    expect(isBalanced(await ledger.allEntries())).toBe(true);
  });

  it('refuses the same deposit twice', async () => {
    const ledger = await setup();
    await expect(
      creditDeposit(ledger, {
        userId: 'alice',
        asset: 'USDC',
        amount: 1_000_000_000n,
        venue: 'base',
        txHash: '0xdep1',
        logIndex: 0,
      }),
    ).rejects.toThrow(/already recorded/);
    expect(await ledger.balance(userAccount('alice', 'USDC'))).toBe(1_000_000_000n);
  });

  it('lets the same hash credit on two different chains', async () => {
    const ledger = await setup();
    await creditDeposit(ledger, {
      userId: 'alice',
      asset: 'USDC',
      amount: 5n,
      venue: 'xlayer',
      txHash: '0xdep1',
      logIndex: 0,
    });
    expect(await ledger.balance(userAccount('alice', 'USDC'))).toBe(1_000_000_005n);
  });

  it('moves both sides of a trade and takes the fee as its own entry', async () => {
    const ledger = await setup();
    await recordTrade(ledger, {
      userId: 'alice',
      venue: 'xlayer',
      sold: { asset: 'USDC', amount: 500_000_000n },
      bought: { asset: 'NVDA', amount: 2_180_000_000_000_000_000n },
      feeAsset: 'USDC',
      feeAmount: 250_000n,
      reference: 'fill:abc',
    });
    expect(await ledger.balance(userAccount('alice', 'USDC'))).toBe(499_750_000n);
    expect(await ledger.balance(userAccount('alice', 'NVDA'))).toBe(2_180_000_000_000_000_000n);
    expect(await ledger.balance(revenueAccount('USDC'))).toBe(250_000n);
    expect(isBalanced(await ledger.allEntries())).toBe(true);
  });

  it('refuses a trade the balance cannot fund', async () => {
    const ledger = await setup();
    await expect(
      recordTrade(ledger, {
        userId: 'alice',
        venue: 'base',
        sold: { asset: 'USDC', amount: 2_000_000_000n },
        bought: { asset: 'NVDA', amount: 1n },
        reference: 'fill:toobig',
      }),
    ).rejects.toThrow(/cannot spend/);
    expect(await ledger.balance(userAccount('alice', 'USDC'))).toBe(1_000_000_000n);
  });

  it('never lets a user balance go negative across a sequence', async () => {
    const ledger = await setup();
    for (let i = 0; i < 12; i++) {
      await recordTrade(ledger, {
        userId: 'alice',
        venue: 'base',
        sold: { asset: 'USDC', amount: 100_000_000n },
        bought: { asset: 'NVDA', amount: 1n },
        reference: `fill:${i}`,
      }).catch(() => undefined);
      expect(await ledger.balance(userAccount('alice', 'USDC'))).toBeGreaterThanOrEqual(0n);
    }
  });

  it('returns an account’s entries newest first', async () => {
    const ledger = await setup();
    await creditDeposit(ledger, {
      userId: 'alice',
      asset: 'USDC',
      amount: 7n,
      venue: 'base',
      txHash: '0xdep2',
      logIndex: 0,
    });
    const entries = await ledger.entriesFor(userAccount('alice', 'USDC'));
    expect(entries.map((e) => e.amount)).toEqual([7n, 1_000_000_000n]);
    expect(await ledger.entriesFor(userAccount('alice', 'USDC'), 1)).toHaveLength(1);
  });
});

describe.each([
  ['memory', memoryLedger],
  ['postgres', postgresLedger],
])('%s withdrawals', (_name, make) => {
  const funded = async () => {
    const ledger = await make();
    await creditDeposit(ledger, {
      userId: 'bob',
      asset: 'USDC',
      amount: 100_000_000n,
      venue: 'base',
      txHash: '0xb1',
      logIndex: 0,
    });
    return ledger;
  };

  it('reserves out of the spendable balance so it cannot be traded away', async () => {
    const ledger = await funded();
    await reserveWithdrawal(ledger, {
      userId: 'bob',
      asset: 'USDC',
      amount: 60_000_000n,
      requestId: 'w1',
    });
    expect(await ledger.balance(userAccount('bob', 'USDC'))).toBe(40_000_000n);
    expect(await ledger.balance(withdrawalHold('bob', 'USDC'))).toBe(60_000_000n);

    await expect(
      recordTrade(ledger, {
        userId: 'bob',
        venue: 'base',
        sold: { asset: 'USDC', amount: 50_000_000n },
        bought: { asset: 'NVDA', amount: 1n },
        reference: 'fill:race',
      }),
    ).rejects.toThrow(/cannot spend/);
  });

  it('still owes the money while the payment is in flight', async () => {
    const ledger = await funded();
    await reserveWithdrawal(ledger, {
      userId: 'bob',
      asset: 'USDC',
      amount: 60_000_000n,
      requestId: 'w1',
    });
    expect(totalOwed(await ledger.allEntries(), 'USDC')).toBe(100_000_000n);
  });

  it('stops owing it once it has left', async () => {
    const ledger = await funded();
    await reserveWithdrawal(ledger, { userId: 'bob', asset: 'USDC', amount: 60_000_000n, requestId: 'w1' });
    await settleWithdrawal(ledger, {
      userId: 'bob',
      asset: 'USDC',
      amount: 60_000_000n,
      requestId: 'w1',
      txHash: '0xout',
    });
    expect(totalOwed(await ledger.allEntries(), 'USDC')).toBe(40_000_000n);
    expect(await ledger.balance(withdrawalHold('bob', 'USDC'))).toBe(0n);
    expect(isBalanced(await ledger.allEntries())).toBe(true);
  });

  it('gives the money back when the payment failed', async () => {
    const ledger = await funded();
    await reserveWithdrawal(ledger, { userId: 'bob', asset: 'USDC', amount: 60_000_000n, requestId: 'w1' });
    await releaseWithdrawal(ledger, {
      userId: 'bob',
      asset: 'USDC',
      amount: 60_000_000n,
      requestId: 'w1',
      why: 'broadcast failed',
    });
    expect(await ledger.balance(userAccount('bob', 'USDC'))).toBe(100_000_000n);
    const entries = await ledger.allEntries();
    expect(entries.some((e) => e.reason === 'correction')).toBe(true);
    expect(isBalanced(entries)).toBe(true);
  });

  it('reports available and reserved separately to the customer', async () => {
    const ledger = await funded();
    await reserveWithdrawal(ledger, { userId: 'bob', asset: 'USDC', amount: 25_000_000n, requestId: 'w2' });
    expect(await portfolio(ledger, 'bob', ['USDC'])).toEqual([
      { asset: 'USDC', available: 75_000_000n, reserved: 25_000_000n },
    ]);
  });
});

describe.each([
  ['memory', memoryLedger],
  ['postgres', postgresLedger],
])('%s reconciliation', (_name, make) => {
  const booked = async () => {
    const ledger = await make();
    await creditDeposit(ledger, {
      userId: 'alice',
      asset: 'USDC',
      amount: 1_000_000_000n,
      venue: 'base',
      txHash: '0xa',
      logIndex: 0,
    });
    await creditDeposit(ledger, {
      userId: 'bob',
      asset: 'USDC',
      amount: 500_000_000n,
      venue: 'base',
      txHash: '0xb',
      logIndex: 0,
    });
    return ledger;
  };

  it('is balanced when the wallets hold exactly what is owed', async () => {
    const ledger = await booked();
    const report = reconcileAsset(
      await ledger.allEntries(),
      [{ venue: 'base', asset: 'USDC', amount: 1_500_000_000n }],
      'USDC',
    );
    expect(report.status).toBe('balanced');
    expect(report.owed).toBe(1_500_000_000n);
    expect(isSolvent([report])).toBe(true);
  });

  it('calls it a shortfall when the wallets hold less than is owed', async () => {
    const ledger = await booked();
    const report = reconcileAsset(
      await ledger.allEntries(),
      [{ venue: 'base', asset: 'USDC', amount: 1_499_000_000n }],
      'USDC',
    );
    expect(report.status).toBe('shortfall');
    expect(report.difference).toBe(-1_000_000n);
    expect(isSolvent([report])).toBe(false);
  });

  it('checks every asset the books or the wallets mention', async () => {
    const ledger = await booked();
    const report = await reconcile(ledger, [
      { venue: 'base', asset: 'USDC', amount: 1_500_000_000n },
      { venue: 'xlayer', asset: 'NVDA', amount: 7n },
    ]);
    expect(report.map((r) => r.asset)).toEqual(['NVDA', 'USDC']);
    expect(report.find((r) => r.asset === 'NVDA')?.status).toBe('surplus');
  });

  it('derives balances from entries rather than a stored figure', async () => {
    const ledger = await booked();
    const entries = await ledger.allEntries();
    expect(balanceOf(entries, userAccount('alice', 'USDC'))).toBe(1_000_000_000n);
    expect(balances(entries).get(externalAccount('USDC'))).toBe(-1_500_000_000n);
    expect(isBalanced(entries)).toBe(true);
  });

  it('filters entries by asset without losing any', async () => {
    const ledger = await booked();
    expect(await ledger.allEntries('USDC')).toHaveLength(4);
    expect(await ledger.allEntries('NVDA')).toHaveLength(0);
  });
});

describe('what only a database can get wrong', () => {
  it('writes both entries or neither', async () => {
    // A failure part-way through the write, forced by taking the id the second
    // entry will need. The first entry, the account row created before it, and
    // the sequence value all have to go back.
    const { db, store } = await freshPostgres();
    await db.query(
      `INSERT INTO ledger_entries (id, transfer_id, account, asset, amount, reason, at)
       VALUES ('t9:to', 'earlier', 'external:USDC', 'USDC', 1, 'deposit', 1)`,
    );

    await expect(store.append(deposit({ id: 't9', reference: 'base:0xboom#0' }))).rejects.toThrow();

    const entries = await db.query(`SELECT id FROM ledger_entries WHERE id = 't9:from'`);
    expect(entries.rows).toHaveLength(0);
    const accounts = await db.query('SELECT id FROM ledger_accounts');
    expect(accounts.rows).toHaveLength(0);
  });

  it('rejects a duplicate reference in the index, not in application code', async () => {
    // The check that counts happens with the application's own idempotency
    // logic removed: two watchers, two processes, no shared memory between
    // them. Only the index is left to decide.
    const { db, store } = await freshPostgres();
    await store.append(deposit({ id: 'first', reference: 'base:0xdup#0' }));

    // Typed, because the watcher has to tell a replay from a failure: it
    // credits unconditionally, and a duplicate means "already done, advance
    // the cursor" rather than "stop and rescan this range for ever".
    const replay = store.append(deposit({ id: 'second', reference: 'base:0xdup#0' }));
    await expect(replay).rejects.toThrow(DuplicateReference);
    await expect(replay).rejects.toThrow(/already recorded/);
    expect(await store.balance(userAccount('alice', 'USDC'))).toBe(1_000_000n);

    // One transaction paying two recipients is two deposits, not a replay.
    await store.append(deposit({ id: 'third', reference: 'base:0xdup#1' }));
    expect(await store.balance(userAccount('alice', 'USDC'))).toBe(2_000_000n);

    // A correction carries no reference, and two of them must not collide.
    const fix = (id: string): Transfer => ({
      id,
      from: poolAccount('base', 'USDC'),
      to: userAccount('alice', 'USDC'),
      asset: 'USDC',
      amount: 1n,
      reason: 'correction',
      at: 1,
    });
    await store.append(fix('fix1'));
    await store.append(fix('fix2'));

    // Not even a direct write gets past it.
    await expect(
      db.query(
        `INSERT INTO ledger_entries (id, transfer_id, account, asset, amount, reason, reference, at)
         VALUES ('raw', 'raw', 'external:USDC', 'USDC', -1000000, 'deposit', 'base:0xdup#0', 1)`,
      ),
    ).rejects.toThrow(/ledger_entries_reference/);
  });

  it('keeps an amount larger than Number.MAX_SAFE_INTEGER exact', async () => {
    // 1.2 million ETH in wei: eighteen decimals is ordinary, and it overflows
    // both a double and a bigint column long before it is an unusual balance.
    const huge = 1_234_567_890_000_000_000_000_000n;
    expect(huge > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);

    const store = await postgresLedger();
    await store.append({
      id: 'big',
      from: externalAccount('WETH'),
      to: userAccount('whale', 'WETH'),
      asset: 'WETH',
      amount: huge,
      reason: 'deposit',
      reference: 'base:0xbig',
      at: 1,
    });

    expect(await store.balance(userAccount('whale', 'WETH'))).toBe(huge);
    expect(await store.balance(externalAccount('WETH'))).toBe(-huge);
    const [entry] = await store.entriesFor(userAccount('whale', 'WETH'));
    expect(entry.amount).toBe(huge);
    // The round trip is exact, not merely close: a double would land 47776
    // wei away and still look like the right number in a log line.
    expect(BigInt(Number(huge))).not.toBe(huge);
  });

  it('lets only one of two concurrent trades spend the same balance', async () => {
    const store = await postgresLedger();
    await creditDeposit(store, {
      userId: 'alice',
      asset: 'USDC',
      amount: 100_000_000n,
      venue: 'base',
      txHash: '0xfund',
      logIndex: 0,
    });

    // Both read a sufficient balance before either writes — the race the
    // in-transaction re-check exists for.
    const trade = (n: number) =>
      recordTrade(store, {
        userId: 'alice',
        venue: 'base',
        sold: { asset: 'USDC', amount: 100_000_000n },
        bought: { asset: 'NVDA', amount: 1n },
        reference: `fill:race${n}`,
      });
    const results = await Promise.allSettled([trade(1), trade(2)]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await store.balance(userAccount('alice', 'USDC'))).toBe(0n);
    expect(isBalanced(await store.allEntries())).toBe(true);
  });

  it('lets only one of many concurrent debits through', async () => {
    const { store } = await freshPostgres();
    await creditDeposit(store, {
      userId: 'alice',
      asset: 'USDC',
      amount: 1_000n,
      venue: 'base',
      txHash: '0xfund',
      logIndex: 0,
    });

    // Straight at the store this time, so nothing but the store's own guard
    // stands between five requests and five times the money.
    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5].map((n) =>
        store.append({
          id: `spend${n}`,
          from: userAccount('alice', 'USDC'),
          to: poolAccount('base', 'USDC'),
          asset: 'USDC',
          amount: 1_000n,
          reason: 'trade',
          reference: `fill:${n}`,
          at: 1,
        }),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await store.balance(userAccount('alice', 'USDC'))).toBe(0n);
  });

  it('refuses to edit or delete an entry', async () => {
    const { db, store } = await freshPostgres();
    await creditDeposit(store, {
      userId: 'alice',
      asset: 'USDC',
      amount: 1_000n,
      venue: 'base',
      txHash: '0xa',
      logIndex: 0,
    });
    await expect(db.query('UPDATE ledger_entries SET amount = 0')).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM ledger_entries')).rejects.toThrow(/append-only/);
    expect(await store.balance(userAccount('alice', 'USDC'))).toBe(1_000n);
  });

  it('indexes the reads that exist', async () => {
    // Not a performance assertion: a missing index here is a reconciliation
    // that sequentially scans five years of entries every morning.
    const { db } = await freshPostgres();
    const { rows } = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'ledger_entries' ORDER BY indexname`,
    );
    expect(rows.map((r) => r.indexname)).toEqual([
      'ledger_entries_account',
      'ledger_entries_asset',
      'ledger_entries_pkey',
      'ledger_entries_reference',
    ]);
  });

  it('keeps no balance anywhere', async () => {
    // The property the whole design rests on: there is no column a balance
    // could drift in, because there is no column a balance is kept in.
    const { db } = await freshPostgres();
    const { rows } = await db.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name LIKE '%balance%'`,
    );
    expect(rows).toEqual([]);
  });
});

/**
 * Tests for the daily reconciliation record.
 *
 * The question these have to answer is not "does it produce a report" but "is
 * the report evidence". So they check that a tampered history is detectable,
 * that a snapshot can be re-derived from what it carries, and that a shortfall
 * is recorded as one rather than smoothed away.
 */

import { describe, it, expect } from 'vitest';
import { MemoryLedger } from '@/lib/custody/ledger';
import { creditDeposit, recordTrade } from '@/lib/custody/accounts';
import {
  RETENTION_YEARS,
  snapshotHash,
  summarise,
  takeSnapshot,
  verifyChain,
  withinRetention,
  type Snapshot,
} from '@/lib/custody/compliance';

const DAY = 24 * 60 * 60 * 1000;

const booked = async () => {
  const ledger = new MemoryLedger();
  await creditDeposit(ledger, {
    userId: 'alice',
    asset: 'USDC',
    amount: 1_000_000_000n,
    venue: 'base',
    txHash: '0xa', occurrence: 0, from: '0xsender',
  });
  return ledger;
};

const held = (amount: bigint) => [{ venue: 'base', asset: 'USDC', amount }];

describe('the daily snapshot', () => {
  it('records solvency when the wallets match the books', async () => {
    const snap = await takeSnapshot(await booked(), held(1_000_000_000n), null, 1_000);
    expect(snap.solvent).toBe(true);
    expect(snap.assets[0]).toMatchObject({ asset: 'USDC', owed: 1_000_000_000n, status: 'balanced' });
    expect(snap.previousHash).toBeNull();
  });

  it('records a shortfall rather than smoothing it away', async () => {
    const snap = await takeSnapshot(await booked(), held(999_000_000n), null, 1_000);
    expect(snap.solvent).toBe(false);
    expect(snap.assets[0].status).toBe('shortfall');
    expect(summarise(snap)).toContain('USDC shortfall -1000000');
  });

  it('carries the inputs it was computed from', async () => {
    // A snapshot that merely asserts "solvent" cannot be re-derived, and a
    // number nobody can reproduce is an opinion.
    const ledger = await booked();
    const snap = await takeSnapshot(ledger, held(1_000_000_000n), null, 1_000);
    expect(snap.holdings).toEqual(held(1_000_000_000n));
    expect(snap.entryCount).toBe((await ledger.allEntries()).length);
  });

  it('counts a trade that has not been hedged as inventory, not insolvency', async () => {
    const ledger = await booked();
    await recordTrade(ledger, {
      userId: 'alice',
      venue: 'base',
      sold: { asset: 'USDC', amount: 100_000_000n },
      bought: { asset: 'NVDA', amount: 1n },
      reference: 'fill:1',
    });
    const snap = await takeSnapshot(
      ledger,
      [
        { venue: 'base', asset: 'USDC', amount: 1_000_000_000n },
        { venue: 'base', asset: 'NVDA', amount: 0n },
      ],
      null,
      1_000,
    );
    expect(snap.solvent).toBe(true);
  });
});

describe('the record as evidence', () => {
  const chainOf = async (): Promise<Snapshot[]> => {
    const ledger = await booked();
    const first = await takeSnapshot(ledger, held(1_000_000_000n), null, DAY);
    const second = await takeSnapshot(ledger, held(1_000_000_000n), first, 2 * DAY);
    const third = await takeSnapshot(ledger, held(1_000_000_000n), second, 3 * DAY);
    return [first, second, third];
  };

  it('verifies an untouched history', async () => {
    expect(verifyChain(await chainOf())).toEqual({ ok: true });
  });

  it('detects a snapshot edited after the fact', async () => {
    // The failure retention exists to prevent: a day that was insolvent,
    // quietly rewritten as a day that was fine.
    const snapshots = await chainOf();
    snapshots[1] = { ...snapshots[1], solvent: false };
    expect(verifyChain(snapshots)).toMatchObject({ ok: false, brokenAt: 2 * DAY });
  });

  it('detects a snapshot removed from the middle', async () => {
    const snapshots = await chainOf();
    expect(verifyChain([snapshots[0], snapshots[2]])).toMatchObject({ ok: false });
  });

  it('detects one inserted', async () => {
    const snapshots = await chainOf();
    const ledger = await booked();
    const forged = await takeSnapshot(ledger, held(5n), null, 90 * DAY);
    expect(verifyChain([...snapshots, forged])).toMatchObject({ ok: false });
  });

  it('hashes the same body to the same value, whatever the key order', async () => {
    const ledger = await booked();
    const snap = await takeSnapshot(ledger, held(1_000_000_000n), null, DAY);
    const { hash, ...body } = snap;
    // Holdings reversed: a hash that changed here would break for reasons
    // nobody could explain, and an unexplainable change in an audit record is
    // worse than no record.
    expect(snapshotHash({ ...body, holdings: [...body.holdings].reverse() })).toBe(hash);
  });
});

describe('retention', () => {
  it('keeps everything inside the five-year window', () => {
    const now = 10 * 365 * DAY;
    expect(withinRetention(now - 4 * 365 * DAY, now)).toBe(true);
    expect(withinRetention(now - (RETENTION_YEARS + 1) * 365 * DAY, now)).toBe(false);
  });
});

/**
 * Regressions for the audit's finding on the audit record itself.
 *
 * The previous tests covered an edit in the middle of a chain someone already
 * held a copy of. That is not the forgery an operator hiding a bad day would
 * commit: they would drop the day and everything after it, or re-derive the
 * whole history with laundered numbers. Both used to verify as `ok`.
 */
describe('forgeries the chain used to accept', () => {
  const fiveDays = async (): Promise<Snapshot[]> => {
    const ledger = await booked();
    const out: Snapshot[] = [];
    let previous: Snapshot | null = null;
    for (let day = 1; day <= 5; day++) {
      // Days four and five are short: the record has something to hide.
      const holdings = held(day >= 4 ? 900_000_000n : 1_000_000_000n);
      previous = await takeSnapshot(ledger, holdings, previous, day * DAY);
      out.push(previous);
    }
    return out;
  };

  it('accepts the genuine record when it is complete', async () => {
    const record = await fiveDays();
    expect(verifyChain(record, 4)).toEqual({ ok: true });
    expect(record.filter((s) => !s.solvent).map((s) => s.sequence)).toEqual([3, 4]);
  });

  it('detects the insolvent tail being cut off', async () => {
    // The whole point: without the expected length, a truncated record and a
    // shorter one are the same thing.
    const record = await fiveDays();
    const truncated = record.slice(0, 3);
    expect(verifyChain(truncated, 4).ok).toBe(false);
    expect(verifyChain(truncated, 4).why).toMatch(/ends at 2, expected 4/);
  });

  it('detects a history re-derived from laundered numbers', async () => {
    // Re-deriving produces an internally consistent chain; what it cannot
    // produce is the sequence the outside world already recorded.
    const clean = new MemoryLedger();
    await creditDeposit(clean, {
      userId: 'alice',
      asset: 'USDC',
      amount: 1_000_000_000n,
      venue: 'base',
      txHash: '0xa',
      occurrence: 0,
      from: '0xsender',
    });
    let previous: Snapshot | null = null;
    const forged: Snapshot[] = [];
    for (let day = 1; day <= 3; day++) {
      previous = await takeSnapshot(clean, held(1_000_000_000n), previous, day * DAY);
      forged.push(previous);
    }
    expect(forged.every((s) => s.solvent)).toBe(true);
    expect(verifyChain(forged, 4).ok).toBe(false);
  });

  it('detects a snapshot whose sequence was renumbered', async () => {
    const record = await fiveDays();
    const renumbered = [...record];
    renumbered[2] = { ...renumbered[2], sequence: 99 };
    expect(verifyChain(renumbered).ok).toBe(false);
  });

  it('refuses to take a snapshot dated before the one before it', async () => {
    const ledger = await booked();
    const first = await takeSnapshot(ledger, held(1_000_000_000n), null, 2 * DAY);
    await expect(takeSnapshot(ledger, held(1_000_000_000n), first, DAY)).rejects.toThrow(
      /cannot be older/,
    );
  });
});

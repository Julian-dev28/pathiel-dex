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
    txHash: '0xa', logIndex: 0,
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

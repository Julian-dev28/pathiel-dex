/**
 * The records a regulator asks for, produced as a by-product of operating.
 *
 * MAS expects a DPT service provider to reconcile customer assets daily, to
 * keep customer money segregated from its own, and to retain the records for
 * five years. Those are not reporting features bolted on at audit time: a
 * reconciliation that is only run when someone asks is a reconciliation that
 * has never caught anything.
 *
 * So a snapshot is a value — computed, stored, and never edited. It records
 * what was owed, what was held, and where, at a moment, with enough detail
 * that a later reader can tell whether the venue was solvent that day without
 * trusting today's code. Two properties make it worth keeping:
 *
 *   - **It is immutable and hash-chained.** Each snapshot carries the hash of
 *     the one before it, so a retrospectively edited history is detectable.
 *     A record that can be quietly rewritten is not evidence of anything, and
 *     the whole point of retention is that someone can check the past.
 *   - **It states its own inputs.** The entry count and the wallet balances it
 *     was computed from travel with it. A snapshot that merely asserts
 *     "solvent" cannot be re-derived, and a number nobody can reproduce is an
 *     opinion.
 *
 * What this file will not do is correct anything. When the books and the
 * wallets disagree, the disagreement is the finding; a program that writes an
 * adjusting entry so its own report comes out clean has destroyed the evidence
 * of whatever caused the gap.
 */

import { keccak256, toHex } from 'viem';
import { reconcile, type AssetReconciliation, type OnChainHolding } from './reconcile';
import type { LedgerStore } from './ledger';

/** How long MAS expects these to be kept. Stated so nobody has to guess. */
export const RETENTION_YEARS = 5;

export type Snapshot = {
  /** Sortable and unique per run: the moment it was taken. */
  at: number;
  /** What every asset looked like. */
  assets: AssetReconciliation[];
  /** The wallet balances this was computed from, so it can be re-derived. */
  holdings: OnChainHolding[];
  /** How many ledger entries existed. A later gap in the count is a question. */
  entryCount: number;
  solvent: boolean;
  /** The previous snapshot's hash, or null for the first. */
  previousHash: string | null;
  hash: string;
};

/**
 * Hash of everything in the snapshot except the hash itself.
 *
 * Deterministic field order, and bigints as decimal strings, because a hash
 * over JSON whose key order or number formatting can vary is a hash that
 * changes for reasons nobody can explain — and an unexplainable change in an
 * audit record is worse than none.
 */
export function snapshotHash(s: Omit<Snapshot, 'hash'>): string {
  const canonical = JSON.stringify({
    at: s.at,
    previousHash: s.previousHash,
    entryCount: s.entryCount,
    solvent: s.solvent,
    assets: s.assets.map((a) => ({
      asset: a.asset,
      owed: a.owed.toString(),
      held: a.held.toString(),
      revenue: a.revenue.toString(),
      inventory: a.inventory.toString(),
      difference: a.difference.toString(),
      status: a.status,
    })),
    holdings: [...s.holdings]
      .sort((x, y) => `${x.venue}:${x.asset}`.localeCompare(`${y.venue}:${y.asset}`))
      .map((h) => ({ venue: h.venue, asset: h.asset, amount: h.amount.toString() })),
  });
  return keccak256(toHex(canonical));
}

/**
 * Take the daily reconciliation.
 *
 * `holdings` comes from reading the wallets and the exchange, not from the
 * ledger — the entire value of this is that two independent sources are
 * compared. Passing ledger-derived figures in here would produce a report that
 * always balances and means nothing.
 */
export async function takeSnapshot(
  store: LedgerStore,
  holdings: OnChainHolding[],
  previous: Snapshot | null,
  now = Date.now(),
): Promise<Snapshot> {
  const assets = await reconcile(store, holdings);
  const entryCount = (await store.allEntries()).length;
  const body: Omit<Snapshot, 'hash'> = {
    at: now,
    assets,
    holdings,
    entryCount,
    solvent: assets.every((a) => a.status !== 'shortfall'),
    previousHash: previous?.hash ?? null,
  };
  return { ...body, hash: snapshotHash(body) };
}

/**
 * Has the record been tampered with since it was written?
 *
 * Checks each snapshot's own hash and its link to the one before. This is what
 * makes retention meaningful: without it, five years of records prove only
 * that someone could write five years of records.
 */
export function verifyChain(snapshots: Snapshot[]): { ok: boolean; brokenAt?: number } {
  let previousHash: string | null = null;
  for (const s of snapshots) {
    const { hash, ...body } = s;
    if (s.previousHash !== previousHash) return { ok: false, brokenAt: s.at };
    if (snapshotHash(body) !== hash) return { ok: false, brokenAt: s.at };
    previousHash = hash;
  }
  return { ok: true };
}

/**
 * Entries that must never be discarded yet.
 *
 * Retention is a policy about what may be deleted, which means the code has to
 * be able to answer "may this go". Anything inside the window stays, and the
 * boundary is stated here rather than inferred at a call site with a
 * subtraction someone has to check.
 */
export const withinRetention = (at: number, now = Date.now()): boolean =>
  now - at < RETENTION_YEARS * 365.25 * 24 * 60 * 60 * 1000;

/** One line an operator or an alert can act on. */
export function summarise(s: Snapshot): string {
  const failing = s.assets.filter((a) => a.status !== 'balanced');
  if (failing.length === 0) {
    return `${new Date(s.at).toISOString()}: balanced across ${s.assets.length} assets`;
  }
  return `${new Date(s.at).toISOString()}: ${failing
    .map((a) => `${a.asset} ${a.status} ${a.difference}`)
    .join(', ')}`;
}

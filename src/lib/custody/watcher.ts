/**
 * The deposit watcher: an ERC-20 transfer on chain becoming a balance.
 *
 * This is where a custodial venue credits money it never received. Three ways
 * it happens, and what is done about each here:
 *
 *   - **Crediting on sight.** A transfer at the chain head is a proposal, not a
 *     settlement. Credit it, let the chain reorganise, and the balance is real
 *     while the money is not — and the customer withdraws it. So nothing is
 *     credited until it is `CONFIRMATIONS` blocks deep, and a scan simply does
 *     not look at blocks newer than that.
 *   - **Crediting twice.** The window overlaps, the process restarts
 *     mid-batch, two instances run at once. Rather than remember what it has
 *     already done — a memory that is wrong precisely when it matters — the
 *     watcher credits unconditionally and lets the ledger refuse a reference it
 *     already holds. A refused replay is a no-op, not a failure.
 *   - **Skipping a block.** The cursor advances only over ranges whose logs
 *     were credited, so a failed range, a store outage or a crash resumes from
 *     the last *credited* height rather than the last *seen* one. A range that
 *     fails ends the scan and is reported; it is never treated as empty, which
 *     is the shape of bug that had the perps page calling live assets unlisted.
 *
 * What this deliberately does not do is decide where the cursor is kept or how
 * the RPC client is built. Both are the caller's, so the whole thing is
 * testable without a network and without a database.
 */

import { parseAbiItem, type Address, type Hex } from 'viem';
import type { ChainConfig, ChainKey } from '../chain';
import { creditDeposit } from './accounts';
import { DuplicateReference, LedgerError, type LedgerStore } from './ledger';
import type { DepositAccount } from './addresses';

export const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

/**
 * How deep a transfer must be buried before it is money.
 *
 * Counted in blocks, chosen in seconds: block count says nothing about reorg
 * risk on its own, which is why these differ by a factor of thirty for chains
 * that are exposed to much the same failure.
 *
 * Every chain here is an L2 whose head is whatever its single sequencer says it
 * is until the batch reaches the parent chain, so the risk being waited out is
 * a sequencer reordering or dropping what it already served — minutes, not the
 * hours that L1 finality would cost a customer.
 *
 *   - `base` — 2s blocks; 60 blocks ≈ 2 minutes. The most exercised sequencer
 *     of the three, with a well-understood batch cadence.
 *   - `xlayer` — 1s blocks; 180 blocks ≈ 3 minutes. A younger zkEVM whose
 *     sequenced head runs well ahead of proof and settlement.
 *   - `robinhood` — 100ms blocks; 1800 blocks ≈ 3 minutes. Ten blocks a second
 *     makes any block count look enormous and buy almost nothing; the same
 *     three minutes as X Layer, for the same reason.
 *
 * These are a floor on latency for every deposit, so raising one is cheap and
 * lowering one is a decision about how much of someone else's money to risk.
 */
export const CONFIRMATIONS: Record<ChainKey, number> = {
  robinhood: 1_800,
  base: 60,
  xlayer: 180,
};

/**
 * Where the scan got to on each chain.
 *
 * An interface because persistence is the caller's problem — the same cursor is
 * a Postgres row in production and a Map in a test — and because the only thing
 * this file needs to be true of it is that `set` is durable before the next
 * scan reads it.
 */
export interface WatcherCursor {
  /** Last block whose deposits are credited, or null if the chain is unscanned. */
  get(chain: ChainKey): Promise<bigint | null>;
  set(chain: ChainKey, block: bigint): Promise<void>;
}

/**
 * A decoded Transfer log, in the shape viem returns one.
 *
 * Every field an RPC may omit is optional here rather than assumed present: a
 * log with no transaction hash cannot be credited idempotently, and quietly
 * treating one as a deposit would be worse than reporting it.
 */
export type TransferLog = {
  /** The token contract that emitted it. */
  address: Address;
  blockNumber?: bigint | null;
  transactionHash?: Hex | null;
  logIndex?: number | null;
  args: { from?: Address; to?: Address; value?: bigint };
};

/** The part of a viem public client this file uses, so a test can be the rest. */
export interface ChainClient {
  getBlockNumber(): Promise<bigint>;
  getLogs(args: {
    address: readonly Address[];
    event: typeof TRANSFER;
    args: { to: readonly Address[] };
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<TransferLog[]>;
}

export type DepositCredit = {
  chain: ChainKey;
  userId: string;
  asset: string;
  /** The token's own minor units, exactly as the chain reported them. */
  amount: bigint;
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
};

/**
 * Something that needs a human.
 *
 * A transfer of a listed asset to an address the venue watches, which could not
 * be turned into a credit, is a customer missing their money. It goes in the
 * report; it is never dropped for being awkward.
 */
export type WatchAnomaly = {
  chain: ChainKey;
  what: 'range-failed' | 'credit-failed' | 'unattributable' | 'refused';
  detail: string;
};

export type ScanReport = {
  chain: ChainKey;
  /** The head as the node reported it, before the confirmation depth is taken off. */
  head: bigint;
  /** The window covered. `to < from` when the chain had nothing mature to scan. */
  from: bigint;
  to: bigint;
  credited: DepositCredit[];
  /** Transfers the ledger had already recorded. The expected outcome of a replay. */
  duplicates: number;
  anomalies: WatchAnomaly[];
};

/**
 * Scan one chain for deposits and credit them.
 *
 * Returns rather than throws: a scan that fails halfway still credited what it
 * credited, and the caller needs the report to know that and to alert on the
 * anomalies. The cursor is left where the next scan will re-cover the failure.
 */
export async function scanChain(args: {
  chain: ChainConfig;
  client: ChainClient;
  store: LedgerStore;
  cursor: WatcherCursor;
  /** The customers whose addresses are watched, and who each one belongs to. */
  accounts: DepositAccount[];
  /** Where to begin when the cursor is empty. Defaults to the confirmed head. */
  startBlock?: bigint;
}): Promise<ScanReport> {
  const { chain, client, store, cursor, accounts, startBlock } = args;

  const head = await client.getBlockNumber();
  const depth = BigInt(CONFIRMATIONS[chain.key]);
  // Below the depth there is nothing this scan is allowed to trust. Clamped at
  // zero so a chain younger than its own confirmation window is not scanned
  // from a negative block.
  const confirmed = head > depth ? head - depth : 0n;

  const last = await cursor.get(chain.key);
  const from = last !== null ? last + 1n : (startBlock ?? confirmed);
  const report: ScanReport = {
    chain: chain.key,
    head,
    from,
    to: from - 1n,
    credited: [],
    duplicates: 0,
    anomalies: [],
  };

  // An empty watch list would mean a filter matching every transfer on the
  // chain. The cursor stays put: there is nothing to credit, and advancing it
  // past blocks nobody looked at is how a later customer's deposit goes missing.
  if (accounts.length === 0 || confirmed < from) return report;

  const watched = new Map(accounts.map((a) => [a.address.toLowerCase(), a.userId]));
  const listed = new Map(chain.tokens.map((t) => [t.address.toLowerCase(), t]));
  const addresses = chain.tokens.map((t) => t.address);
  const to = accounts.map((a) => a.address);

  // One request per range, in order, never a batch: X Layer serves a hundred
  // blocks per query and fails a batch of more than ten calls, and a scan that
  // is a loop anyway has nothing to gain from being a concurrent one.
  for (const [rangeFrom, rangeTo] of ranges(chain, from, confirmed)) {
    let logs: TransferLog[];
    try {
      logs = await client.getLogs({
        address: addresses,
        event: TRANSFER,
        args: { to },
        fromBlock: rangeFrom,
        toBlock: rangeTo,
      });
    } catch (err) {
      // Not `[]`. An endpoint that failed and an endpoint that saw nothing are
      // the same value and opposite facts, and the cursor must not move past a
      // range whose contents are unknown.
      report.anomalies.push({
        chain: chain.key,
        what: 'range-failed',
        detail: `blocks ${rangeFrom}-${rangeTo}: ${reason(err)}`,
      });
      return report;
    }

    for (const log of logs) {
      const token = listed.get(log.address.toLowerCase());
      const userId = log.args.to ? watched.get(log.args.to.toLowerCase()) : undefined;
      // An unlisted token or an address that is not a customer's is not a
      // deposit. Both are filtered for in the query; an endpoint that answers
      // with more than it was asked for does not get to credit anyone.
      if (!token || !userId) continue;

      const { value } = log.args;
      const { transactionHash, logIndex, blockNumber } = log;
      if (value === undefined || !transactionHash || logIndex == null || blockNumber == null) {
        report.anomalies.push({
          chain: chain.key,
          what: 'unattributable',
          detail: `${token.symbol} to ${log.args.to} in ${transactionHash ?? 'an unidentified transaction'} has no stable identity`,
        });
        continue;
      }

      try {
        await creditDeposit(store, {
          userId,
          asset: token.symbol,
          amount: value,
          venue: chain.key,
          // The hash alone is not the identity of a deposit — one batch payout
          // carries a Transfer per recipient — so the log index goes with it.
          // creditDeposit composes the reference; passing a pre-joined string
          // would put the format in two places.
          txHash: transactionHash,
          logIndex,
        });
        report.credited.push({
          chain: chain.key,
          userId,
          asset: token.symbol,
          amount: value,
          txHash: transactionHash,
          logIndex,
          blockNumber,
        });
      } catch (err) {
        if (isReplay(err)) {
          report.duplicates++;
          continue;
        }
        if (err instanceof LedgerError) {
          // The ledger refused this one transfer on its merits — a zero-value
          // transfer, an asset mismatch. Nothing was written, so the scan can
          // go on, but a listed asset sent to a customer's address that did not
          // become a balance is exactly what must not be swallowed.
          report.anomalies.push({
            chain: chain.key,
            what: 'refused',
            detail: `${value} ${token.symbol} to ${userId} in ${transactionHash}: ${reason(err)}`,
          });
          continue;
        }
        // The store itself is unhappy. Stop before the cursor moves, so the
        // whole range is scanned again; the credits already written will be
        // refused as replays on the retry, which is the point of the reference.
        report.anomalies.push({
          chain: chain.key,
          what: 'credit-failed',
          detail: `${value} ${token.symbol} to ${userId} in ${transactionHash}: ${reason(err)}`,
        });
        return report;
      }
    }

    await cursor.set(chain.key, rangeTo);
    report.to = rangeTo;
  }

  return report;
}

/** Contiguous windows of at most the chain's log span, covering every block once. */
function ranges(chain: ChainConfig, from: bigint, to: bigint): [bigint, bigint][] {
  const span = BigInt(chain.maxLogSpan);
  const out: [bigint, bigint][] = [];
  for (let f = from; f <= to; f += span) {
    const end = f + span - 1n;
    out.push([f, end > to ? to : end]);
  }
  return out;
}

/**
 * Did the ledger refuse this because it already has it?
 *
 * The rejection of a known `(reason, reference)` is what makes the watcher
 * idempotent, so it is the one ledger error that means "all is well". Every
 * other one is a transfer that did not become a balance and is reported as such.
 *
 * Matched on the type rather than the words. A store that phrased its
 * unique-violation differently would otherwise turn every harmless replay into
 * a credit failure, and the cursor would sit behind a range it re-scanned
 * forever while deposits went uncredited.
 */
const isReplay = (err: unknown): boolean => err instanceof DuplicateReference;

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

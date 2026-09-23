/**
 * Tests for the deposit watcher, written to attack it.
 *
 * The watcher decides when money exists, so what is asserted here is the set of
 * properties that have to hold however it is written: a transfer credits once
 * no matter how often it is seen, an unconfirmed transfer credits not at all, a
 * chunked scan misses no block, a failed range leaves the cursor behind it, and
 * an amount survives eighteen decimals unrounded.
 *
 * No network: the client is a fake that answers from a list of logs and records
 * what was asked of it. It deliberately ignores the address and recipient
 * filters it is given, so that the watcher's own guards are what the ignoring
 * tests exercise rather than the fake's helpfulness.
 */

import { describe, it, expect } from 'vitest';
import { CHAINS, type ChainKey } from '@/lib/chain';
import { MemoryLedger, userAccount } from '@/lib/custody/ledger';
import type { DepositAccount } from '@/lib/custody/addresses';
import {
  CONFIRMATIONS,
  scanChain,
  type ChainClient,
  type TransferLog,
  type WatcherCursor,
} from '@/lib/custody/watcher';
import type { Address, Hex } from 'viem';

const ALICE = '0x00000000000000000000000000000000000A11ce' as Address;
const BOB = '0x0000000000000000000000000000000000000B0b' as Address;
const STRANGER = '0x0000000000000000000000000000000000005747' as Address;

const ACCOUNTS: DepositAccount[] = [
  { userId: 'alice', index: 0, address: ALICE },
  { userId: 'bob', index: 1, address: BOB },
];

const USDC = CHAINS.base.tokens.find((t) => t.symbol === 'USDC')!;
const WETH = CHAINS.base.tokens.find((t) => t.symbol === 'WETH')!;
const XL_USDC = CHAINS.xlayer.tokens.find((t) => t.symbol === 'USDC')!;

const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex;

const log = (over: Partial<TransferLog> & { block: bigint; value: bigint }): TransferLog => ({
  address: USDC.address,
  blockNumber: over.block,
  transactionHash: hash(Number(over.block)),
  logIndex: 0,
  args: { from: STRANGER, to: ALICE, value: over.value, ...over.args },
  ...over,
});

/** A node that answers from a list, records its questions, and can fail a range. */
class FakeChain implements ChainClient {
  requested: [bigint, bigint][] = [];
  constructor(
    public head: bigint,
    public logs: TransferLog[] = [],
    /** Ranges to fail, by their start block. */
    public failFrom = new Set<bigint>(),
  ) {}

  async getBlockNumber(): Promise<bigint> {
    return this.head;
  }

  async getLogs(args: { fromBlock: bigint; toBlock: bigint }): Promise<TransferLog[]> {
    this.requested.push([args.fromBlock, args.toBlock]);
    if (this.failFrom.has(args.fromBlock)) throw new Error('endpoint said no');
    return this.logs.filter(
      (l) => l.blockNumber! >= args.fromBlock && l.blockNumber! <= args.toBlock,
    );
  }
}

const memoryCursor = () => {
  const at = new Map<ChainKey, bigint>();
  const cursor: WatcherCursor & { at: Map<ChainKey, bigint> } = {
    at,
    async get(chain) {
      return at.get(chain) ?? null;
    },
    async set(chain, block) {
      at.set(chain, block);
    },
  };
  return cursor;
};

const scan = (client: ChainClient, over: Partial<Parameters<typeof scanChain>[0]> = {}) =>
  scanChain({
    chain: CHAINS.base,
    client,
    store: new MemoryLedger(),
    cursor: memoryCursor(),
    accounts: ACCOUNTS,
    startBlock: 0n,
    ...over,
  });

describe('seeing the same transfer twice', () => {
  it('credits once across a restart', async () => {
    const store = new MemoryLedger();
    const deposit = log({ block: 10n, value: 250_000n });

    // Two processes, each starting cold from block 0 with no memory of the
    // other — only the ledger stands between them and crediting twice.
    for (const _ of [1, 2]) {
      await scan(new FakeChain(1_000n, [deposit]), { store, cursor: memoryCursor() });
    }

    expect(await store.balance(userAccount('alice', 'USDC'))).toBe(250_000n);
  });

  it('credits once when the scan window overlaps', async () => {
    const store = new MemoryLedger();
    const cursor = memoryCursor();
    const client = new FakeChain(1_000n, [log({ block: 10n, value: 250_000n })]);

    await scanChain({ chain: CHAINS.base, client, store, cursor, accounts: ACCOUNTS, startBlock: 0n });
    // The cursor is rewound, as it would be by a crash between the credit and
    // the write, or by an operator replaying a window.
    await cursor.set('base', 0n);
    const second = await scanChain({ chain: CHAINS.base, client, store, cursor, accounts: ACCOUNTS });

    expect(await store.balance(userAccount('alice', 'USDC'))).toBe(250_000n);
    expect(second.duplicates).toBe(1);
    expect(second.credited).toHaveLength(0);
    expect(second.anomalies).toEqual([]);
  });

  it('credits once when two instances scan at the same time', async () => {
    const store = new MemoryLedger();
    const deposit = log({ block: 10n, value: 250_000n });

    const reports = await Promise.all([
      scan(new FakeChain(1_000n, [deposit]), { store, cursor: memoryCursor() }),
      scan(new FakeChain(1_000n, [deposit]), { store, cursor: memoryCursor() }),
    ]);

    expect(await store.balance(userAccount('alice', 'USDC'))).toBe(250_000n);
    expect(reports.reduce((n, r) => n + r.credited.length, 0)).toBe(1);
    expect(reports.reduce((n, r) => n + r.duplicates, 0)).toBe(1);
  });

  it('credits every recipient of a batch payout, which shares one hash', async () => {
    // One transaction, one hash, two customers. Keyed on the hash alone the
    // second would look exactly like a replay and be silently refused.
    const store = new MemoryLedger();
    const tx = hash(77);
    const client = new FakeChain(1_000n, [
      { address: USDC.address, blockNumber: 10n, transactionHash: tx, logIndex: 3, args: { to: ALICE, value: 100n } },
      { address: USDC.address, blockNumber: 10n, transactionHash: tx, logIndex: 4, args: { to: BOB, value: 900n } },
    ]);

    const report = await scan(client, { store });

    expect(report.credited).toHaveLength(2);
    expect(await store.balance(userAccount('alice', 'USDC'))).toBe(100n);
    expect(await store.balance(userAccount('bob', 'USDC'))).toBe(900n);
  });
});

describe('confirmations', () => {
  it('does not credit a transfer that is not yet deep enough', async () => {
    const store = new MemoryLedger();
    const head = 1_000n;
    // One block short of the depth Base deserves.
    const young = head - BigInt(CONFIRMATIONS.base) + 1n;

    const report = await scan(new FakeChain(head, [log({ block: young, value: 5n })]), { store });

    expect(report.credited).toHaveLength(0);
    expect(report.to).toBeLessThan(young);
    expect(await store.balance(userAccount('alice', 'USDC'))).toBe(0n);
  });

  it('credits it once the chain has moved on', async () => {
    const store = new MemoryLedger();
    const cursor = memoryCursor();
    const deposit = log({ block: 941n, value: 5n });

    const early = await scanChain({
      chain: CHAINS.base,
      client: new FakeChain(1_000n, [deposit]),
      store,
      cursor,
      accounts: ACCOUNTS,
      startBlock: 900n,
    });
    expect(early.credited).toHaveLength(0);

    const later = await scanChain({
      chain: CHAINS.base,
      client: new FakeChain(1_100n, [deposit]),
      store,
      cursor,
      accounts: ACCOUNTS,
    });

    expect(later.credited).toHaveLength(1);
    expect(await store.balance(userAccount('alice', 'USDC'))).toBe(5n);
  });
});

describe('chunking', () => {
  it('covers every block exactly once within X Layer’s hundred-block cap', async () => {
    const chain = CHAINS.xlayer;
    const head = 1_000n + BigInt(CONFIRMATIONS.xlayer);
    const client = new FakeChain(head);

    const report = await scanChain({
      chain,
      client,
      store: new MemoryLedger(),
      cursor: memoryCursor(),
      accounts: ACCOUNTS,
      startBlock: 1n,
    });

    expect(report.to).toBe(1_000n);
    for (const [from, to] of client.requested) {
      expect(Number(to - from) + 1).toBeLessThanOrEqual(chain.maxLogSpan);
    }
    // Contiguous: each range starts where the last ended, so no block is
    // scanned twice and none is stepped over.
    expect(client.requested[0][0]).toBe(1n);
    expect(client.requested.at(-1)![1]).toBe(1_000n);
    for (let i = 1; i < client.requested.length; i++) {
      expect(client.requested[i][0]).toBe(client.requested[i - 1][1] + 1n);
    }
  });

  it('resumes after the last block it covered, without a gap or a repeat', async () => {
    const chain = CHAINS.xlayer;
    const cursor = memoryCursor();
    const depth = BigInt(CONFIRMATIONS.xlayer);

    const first = new FakeChain(250n + depth);
    await scanChain({ chain, client: first, store: new MemoryLedger(), cursor, accounts: ACCOUNTS, startBlock: 1n });
    const second = new FakeChain(400n + depth);
    await scanChain({ chain, client: second, store: new MemoryLedger(), cursor, accounts: ACCOUNTS });

    expect(first.requested.at(-1)![1]).toBe(250n);
    expect(second.requested[0][0]).toBe(251n);
    expect(second.requested.at(-1)![1]).toBe(400n);
  });
});

describe('a range that fails', () => {
  it('is reported rather than counted as empty, and the cursor stops before it', async () => {
    const chain = CHAINS.xlayer;
    const store = new MemoryLedger();
    const cursor = memoryCursor();
    const depth = BigInt(CONFIRMATIONS.xlayer);
    const deposit = { ...log({ block: 150n, value: 42n }), address: XL_USDC.address };

    const failing = new FakeChain(300n + depth, [deposit], new Set([101n]));
    const report = await scanChain({ chain, client: failing, store, cursor, accounts: ACCOUNTS, startBlock: 1n });

    expect(report.anomalies.map((a) => a.what)).toEqual(['range-failed']);
    expect(cursor.at.get('xlayer')).toBe(100n);
    expect(await store.balance(userAccount('alice', 'USDC'))).toBe(0n);

    // The deposit in the failed range is credited when the range succeeds.
    const healthy = new FakeChain(300n + depth, [deposit]);
    await scanChain({ chain, client: healthy, store, cursor, accounts: ACCOUNTS });

    expect(healthy.requested[0][0]).toBe(101n);
    expect(await store.balance(userAccount('alice', 'USDC'))).toBe(42n);
  });
});

describe('what is not a deposit', () => {
  it('ignores a transfer to an address no customer owns', async () => {
    const store = new MemoryLedger();
    const report = await scan(
      new FakeChain(1_000n, [log({ block: 10n, value: 1n, args: { to: STRANGER, value: 1n } })]),
      { store },
    );

    expect(report.credited).toHaveLength(0);
    expect(report.anomalies).toEqual([]);
    expect(await store.allEntries()).toEqual([]);
  });

  it('ignores a token the venue does not list', async () => {
    const store = new MemoryLedger();
    const unlisted = { ...log({ block: 10n, value: 1n }), address: STRANGER };

    const report = await scan(new FakeChain(1_000n, [unlisted]), { store });

    expect(report.credited).toHaveLength(0);
    expect(await store.allEntries()).toEqual([]);
  });

  it('surfaces a listed transfer to a known address that it cannot identify', async () => {
    const store = new MemoryLedger();
    const nameless = { ...log({ block: 10n, value: 1n }), transactionHash: null };

    const report = await scan(new FakeChain(1_000n, [nameless]), { store });

    expect(report.credited).toHaveLength(0);
    expect(report.anomalies.map((a) => a.what)).toEqual(['unattributable']);
    expect(await store.allEntries()).toEqual([]);
  });

  it('surfaces a transfer the ledger refuses on its merits', async () => {
    // A zero-value Transfer is legal on chain and is not a deposit; what the
    // watcher must not do is pass over it in silence.
    const store = new MemoryLedger();
    const report = await scan(new FakeChain(1_000n, [log({ block: 10n, value: 0n })]), { store });

    expect(report.credited).toHaveLength(0);
    expect(report.anomalies.map((a) => a.what)).toEqual(['refused']);
  });
});

describe('amounts', () => {
  it('carries eighteen decimals through untouched', async () => {
    const store = new MemoryLedger();
    // 12,345.678901234567890123 WETH — well past what a double can hold, and
    // the last digit is the one a float would eat.
    const amount = 12_345_678_901_234_567_890_123n;
    expect(Number(amount)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);

    const deposit = { ...log({ block: 10n, value: amount }), address: WETH.address };
    const report = await scan(new FakeChain(1_000n, [deposit]), { store });

    expect(report.credited[0].amount).toBe(amount);
    expect(await store.balance(userAccount('alice', 'WETH'))).toBe(amount);
  });
});

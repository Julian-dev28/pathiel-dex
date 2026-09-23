/**
 * Tests for the ledger, written to attack it.
 *
 * Every audit in this project so far has found bugs that passed a suite
 * asserting the implementation back at itself, and a ledger is the last place
 * to repeat that. So these assert properties that hold independently of how
 * the code is written: the books sum to zero, nothing creates value, a replayed
 * deposit is refused, a balance cannot go negative, and a reconciliation
 * notices when the chain and the books disagree.
 */

import { describe, it, expect } from 'vitest';
import {
  MemoryLedger,
  balanceOf,
  balances,
  entriesFor,
  externalAccount,
  isBalanced,
  poolAccount,
  revenueAccount,
  totalOwed,
  userAccount,
  LedgerError,
  type Transfer,
} from '@/lib/custody/ledger';
import {
  creditDeposit,
  portfolio,
  recordTrade,
  releaseWithdrawal,
  reserveWithdrawal,
  settleWithdrawal,
  withdrawalHold,
} from '@/lib/custody/accounts';
import { describe as describeAsset, isSolvent, reconcile, reconcileAsset } from '@/lib/custody/reconcile';

const transfer = (over: Partial<Transfer> = {}): Transfer => ({
  id: 't1',
  from: externalAccount('USDC'),
  to: userAccount('alice', 'USDC'),
  asset: 'USDC',
  amount: 1_000_000n,
  reason: 'deposit',
  at: 1,
  ...over,
});

describe('double entry', () => {
  it('writes two entries that sum to zero', () => {
    const [debit, credit] = entriesFor(transfer());
    expect(debit.amount + credit.amount).toBe(0n);
    expect(debit.transferId).toBe(credit.transferId);
  });

  it('refuses a transfer that would create value from nowhere', () => {
    expect(() => entriesFor(transfer({ amount: 0n }))).toThrow(LedgerError);
    expect(() => entriesFor(transfer({ amount: -5n }))).toThrow(LedgerError);
  });

  it('refuses a transfer from an account to itself', () => {
    const self = userAccount('alice', 'USDC');
    expect(() => entriesFor(transfer({ from: self, to: self }))).toThrow(/same account/);
  });

  it('refuses to credit one asset into an account holding another', () => {
    // A dollar landing in a share account is how a balance becomes fiction.
    expect(() =>
      entriesFor(transfer({ to: userAccount('alice', 'NVDA'), asset: 'USDC' })),
    ).toThrow(/does not hold/);
  });
});

describe('a ledger under ordinary use', () => {
  const setup = async () => {
    const ledger = new MemoryLedger();
    await creditDeposit(ledger, {
      userId: 'alice',
      asset: 'USDC',
      amount: 1_000_000_000n, // $1,000
      venue: 'base',
      txHash: '0xdep1',
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
    // The chain watcher will see this transaction again — a restart, a reorg,
    // an overlapping scan. The second sighting must not be free money.
    const ledger = await setup();
    await expect(
      creditDeposit(ledger, {
        userId: 'alice',
        asset: 'USDC',
        amount: 1_000_000_000n,
        venue: 'base',
        txHash: '0xdep1',
      }),
    ).rejects.toThrow(/already recorded/);
    expect(await ledger.balance(userAccount('alice', 'USDC'))).toBe(1_000_000_000n);
  });

  it('lets the same hash credit on two different chains', async () => {
    // Hashes are unique per chain, not across them; the venue is part of the
    // reference for exactly this reason.
    const ledger = await setup();
    await creditDeposit(ledger, {
      userId: 'alice',
      asset: 'USDC',
      amount: 5n,
      venue: 'xlayer',
      txHash: '0xdep1',
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
    // Revenue is a balance in its own right, not the gap between two numbers.
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
});

describe('withdrawals', () => {
  const funded = async () => {
    const ledger = new MemoryLedger();
    await creditDeposit(ledger, {
      userId: 'bob',
      asset: 'USDC',
      amount: 100_000_000n,
      venue: 'base',
      txHash: '0xb1',
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

    // The reserved half is genuinely gone from the tradeable balance.
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
    // The dangerous version of this reports balanced books precisely while a
    // withdrawal is unsettled.
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
    // Corrected by a reversing entry, not by editing history away.
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

describe('reconciliation', () => {
  const booked = async () => {
    const ledger = new MemoryLedger();
    await creditDeposit(ledger, {
      userId: 'alice',
      asset: 'USDC',
      amount: 1_000_000_000n,
      venue: 'base',
      txHash: '0xa',
    });
    await creditDeposit(ledger, {
      userId: 'bob',
      asset: 'USDC',
      amount: 500_000_000n,
      venue: 'base',
      txHash: '0xb',
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
    expect(describeAsset(report)).toContain('shortfall of 1000000');
  });

  it('reports a surplus rather than ignoring it', async () => {
    // A surplus is usually a deposit nobody credited — a customer missing
    // money they sent, which is the same bug wearing a friendlier face.
    const ledger = await booked();
    const report = reconcileAsset(
      await ledger.allEntries(),
      [{ venue: 'base', asset: 'USDC', amount: 1_600_000_000n }],
      'USDC',
    );
    expect(report.status).toBe('surplus');
    expect(report.difference).toBe(100_000_000n);
  });

  it('counts fees as held but not owed', async () => {
    const ledger = await booked();
    await recordTrade(ledger, {
      userId: 'alice',
      venue: 'base',
      sold: { asset: 'USDC', amount: 100_000_000n },
      bought: { asset: 'NVDA', amount: 1n },
      feeAsset: 'USDC',
      feeAmount: 1_000_000n,
      reference: 'fill:fee',
    });
    // The pooled wallets still hold all 1.5bn; 1m of it is now revenue, and
    // reading that as a surplus would let real fees mask a real shortfall.
    const report = reconcileAsset(
      await ledger.allEntries(),
      [{ venue: 'base', asset: 'USDC', amount: 1_500_000_000n }],
      'USDC',
    );
    expect(report.revenue).toBe(1_000_000n);
    expect(report.status).toBe('balanced');
  });

  it('checks every asset the books or the wallets mention', async () => {
    const ledger = await booked();
    const report = await reconcile(ledger, [
      { venue: 'base', asset: 'USDC', amount: 1_500_000_000n },
      { venue: 'xlayer', asset: 'NVDA', amount: 7n },
    ]);
    expect(report.map((r) => r.asset)).toEqual(['NVDA', 'USDC']);
    // An asset held but owed to nobody is a surplus, not an absence.
    expect(report.find((r) => r.asset === 'NVDA')?.status).toBe('surplus');
  });

  it('derives balances from entries rather than a stored figure', async () => {
    // The property that makes reconciliation mean anything: there is no
    // separate number that could agree with itself while being wrong.
    const ledger = await booked();
    const entries = await ledger.allEntries();
    expect(balanceOf(entries, userAccount('alice', 'USDC'))).toBe(1_000_000_000n);
    expect(balances(entries).get(externalAccount('USDC'))).toBe(-1_500_000_000n);
    expect(isBalanced(entries)).toBe(true);
  });
});

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
      txHash: '0xdep1', occurrence: 0, from: '0xsender',
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
        txHash: '0xdep1', occurrence: 0, from: '0xsender',
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
      txHash: '0xdep1', occurrence: 0, from: '0xsender',
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
      txHash: '0xb1', occurrence: 0, from: '0xsender',
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
      txHash: '0xa', occurrence: 0, from: '0xsender',
    });
    await creditDeposit(ledger, {
      userId: 'bob',
      asset: 'USDC',
      amount: 500_000_000n,
      venue: 'base',
      txHash: '0xb', occurrence: 0, from: '0xsender',
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

/**
 * Regressions for the adversarial audit.
 *
 * Each of these reproduces a way the ledger lost or invented money, and each
 * one failed before the fix beside it. They are written against the behaviour
 * rather than the implementation: what matters is that a customer's balance
 * survives, not which function threw.
 */
describe('what the audit found', () => {
  const funded = async (amount = 1_000_000_000n) => {
    const ledger = new MemoryLedger();
    await creditDeposit(ledger, {
      userId: 'alice',
      asset: 'USDC',
      amount,
      venue: 'base',
      txHash: '0xa',
      occurrence: 0,
      from: '0xsender',
    });
    return ledger;
  };

  it('leaves the balance untouched when a later leg of a trade fails', async () => {
    // The critical one: the fee was spent after both legs were written, so a
    // fee against a balance the trade had just emptied committed the sell,
    // threw, and poisoned the retry. The money was simply gone.
    const ledger = await funded();
    await expect(
      recordTrade(ledger, {
        userId: 'alice',
        venue: 'base',
        sold: { asset: 'USDC', amount: 1_000_000_000n },
        bought: { asset: 'NVDA', amount: 4_000_000_000_000_000_000n },
        feeAsset: 'USDC',
        feeAmount: 500_000n,
        reference: 'fill:doomed',
      }),
    ).rejects.toThrow(/cannot spend/);

    expect(await ledger.balance(userAccount('alice', 'USDC'))).toBe(1_000_000_000n);
    expect(await ledger.balance(userAccount('alice', 'NVDA'))).toBe(0n);
    expect(isBalanced(await ledger.allEntries())).toBe(true);
  });

  it('lets the same trade be retried after it failed', async () => {
    // A half-applied trade left its reference recorded, so the retry was
    // refused forever and the state could never be repaired.
    const ledger = await funded();
    await recordTrade(ledger, {
      userId: 'alice',
      venue: 'base',
      sold: { asset: 'USDC', amount: 1_000_000_000n },
      bought: { asset: 'NVDA', amount: 1n },
      feeAsset: 'USDC',
      feeAmount: 500_000n,
      reference: 'fill:retried',
    }).catch(() => undefined);

    await expect(
      recordTrade(ledger, {
        userId: 'alice',
        venue: 'base',
        sold: { asset: 'USDC', amount: 900_000_000n },
        bought: { asset: 'NVDA', amount: 1n },
        feeAsset: 'USDC',
        feeAmount: 500_000n,
        reference: 'fill:retried',
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses to overdraw in the memory store, as Postgres does', async () => {
    // The two stores were not interchangeable: this one had no guard at all,
    // so local development minted money while production refused.
    const ledger = await funded(100n);
    await expect(
      settleWithdrawal(ledger, {
        userId: 'alice',
        asset: 'USDC',
        amount: 60n,
        requestId: 'w1',
        txHash: '0x1',
      }),
    ).rejects.toThrow(/cannot spend|would strand/);
    expect(await ledger.balance(withdrawalHold('alice', 'USDC'))).toBe(0n);
  });

  it('will not settle a withdrawal for less than was reserved', async () => {
    // The remainder was stranded: owed to the customer, unreachable by them,
    // and counted by reconciliation as an obligation being met.
    const ledger = await funded();
    await reserveWithdrawal(ledger, {
      userId: 'alice',
      asset: 'USDC',
      amount: 60_000_000n,
      requestId: 'w1',
    });
    await expect(
      settleWithdrawal(ledger, {
        userId: 'alice',
        asset: 'USDC',
        amount: 59_000_000n,
        requestId: 'w1',
        txHash: '0x1',
      }),
    ).rejects.toThrow(/strand/);
    expect(await ledger.balance(withdrawalHold('alice', 'USDC'))).toBe(60_000_000n);
  });

  it('settles a withdrawal once however many times it is reported', async () => {
    const ledger = await funded();
    const request = { userId: 'alice', asset: 'USDC', amount: 60_000_000n, requestId: 'w1' };
    await reserveWithdrawal(ledger, request);
    await settleWithdrawal(ledger, { ...request, txHash: '0xfirst' });
    // A second broadcast that also landed is the same settlement, not another.
    await expect(
      settleWithdrawal(ledger, { ...request, txHash: '0xsecond' }),
    ).rejects.toThrow();
    expect(totalOwed(await ledger.allEntries(), 'USDC')).toBe(940_000_000n);
  });

  it('releases a failed withdrawal once, whatever the operator wrote', async () => {
    const ledger = await funded();
    const request = { userId: 'alice', asset: 'USDC', amount: 60_000_000n, requestId: 'w1' };
    await reserveWithdrawal(ledger, request);
    await releaseWithdrawal(ledger, { ...request, why: 'broadcast failed' });
    await expect(
      releaseWithdrawal(ledger, { ...request, why: 'operator cancelled' }),
    ).rejects.toThrow();
    expect(await ledger.balance(userAccount('alice', 'USDC'))).toBe(1_000_000_000n);
  });

  it('treats one address as one customer whatever the casing', async () => {
    // Deposits credited to one casing and withdrawals attempted from another
    // left the money on the books and out of reach, reading as balanced.
    const lower = '0xab5801a7d398351b8be11c439e05c5b3259aec9b';
    const checksummed = '0xaB5801a7D398351b8bE11C439e05C5B3259aeC9B';
    expect(userAccount(lower, 'USDC')).toBe(userAccount(checksummed, 'USDC'));
    expect(withdrawalHold(lower, 'USDC')).toBe(withdrawalHold(checksummed, 'USDC'));
  });

  it('refuses an id that would collide with another customer\'s reserved funds', async () => {
    expect(() => userAccount('bob#hold', 'USDC')).toThrow(/may not contain/);
    expect(() => userAccount('bob', 'USD:C')).toThrow(/may not contain/);
  });

  it('keys a deposit by the transfer, not by its position in the block', async () => {
    // logIndex is an index into the block, so a re-mine — or two RPC nodes
    // that disagree about ordering — renumbered the same transfer and it
    // credited twice.
    const ledger = await funded();
    await expect(
      creditDeposit(ledger, {
        userId: 'alice',
        asset: 'USDC',
        amount: 1_000_000_000n,
        venue: 'base',
        txHash: '0xa',
        // Same movement, seen again after a re-mine that renumbered the logs.
        occurrence: 0,
        from: '0xsender',
      }),
    ).rejects.toThrow(/already recorded/);
    expect(await ledger.balance(userAccount('alice', 'USDC'))).toBe(1_000_000_000n);
  });

  it('still separates two different transfers in one transaction', async () => {
    // A batch payout pays several customers in one transaction; those must
    // still be distinct deposits.
    const ledger = await funded();
    await creditDeposit(ledger, {
      userId: 'bob',
      asset: 'USDC',
      amount: 5n,
      venue: 'base',
      txHash: '0xa',
      occurrence: 1,
      from: '0xsender',
    });
    expect(await ledger.balance(userAccount('bob', 'USDC'))).toBe(5n);
  });
});

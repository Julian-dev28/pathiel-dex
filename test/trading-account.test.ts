/**
 * Tests for what the trading-account panel decides.
 *
 * The panel itself is React and is not rendered here. What is tested is the
 * part that can be wrong quietly: calling a stranded account ready, ordering a
 * withdrawal so the gas leaves before the tokens it was paying for, or telling
 * someone nothing was sent when half of it was.
 */

import { describe, it, expect } from 'vitest';
import { CHAINS, bySymbol } from '@/lib/chain';
import { GAS_FLOOR, statusFor } from '@/lib/account/funding';
import {
  accountStatuses,
  chainToUnfreeze,
  depositSource,
  isFrozen,
  unifiedDollars,
  unifiedPositions,
  fundingNote,
  fundingState,
  landedNote,
  nativeText,
  withdrawalSteps,
} from '@/components/trading-account';

const OWNER = '0x1111111111111111111111111111111111111111' as const;
const base = CHAINS.base;
const usdc = bySymbol('USDC', 'base');
const weth = bySymbol('WETH', 'base');

describe('what state an account is in on a chain', () => {
  it('calls an untouched account empty rather than short of gas', () => {
    expect(fundingState(statusFor('base', 0n, []))).toBe('empty');
  });

  it('calls an account holding tokens and no gas stranded, not empty', () => {
    const status = statusFor('base', 0n, [{ token: usdc, balance: 1_000_000n }]);
    expect(fundingState(status)).toBe('needs-gas');
  });

  it('calls dust below the floor short of gas even with no tokens', () => {
    expect(fundingState(statusFor('base', GAS_FLOOR.base - 1n, []))).toBe('needs-gas');
    expect(fundingState(statusFor('base', GAS_FLOOR.base, []))).toBe('ready');
  });

  it('says how much is missing, not only that something is', () => {
    const status = statusFor('base', 0n, [{ token: usdc, balance: 1_000_000n }]);
    const note = fundingNote(status, 'ETH');
    expect(note).toContain('cannot move them');
    expect(note).toContain(nativeText(GAS_FLOOR.base, 'ETH'));
  });

  it('does not tell a funded account it is missing anything', () => {
    expect(fundingNote(statusFor('base', GAS_FLOOR.base, []), 'ETH')).toContain(
      'enough to pay for its own transactions',
    );
    expect(fundingNote(statusFor('base', 0n, []), 'ETH')).toBe('Nothing here yet.');
  });
});

describe('the per-chain summary', () => {
  const native = [
    { chain: 'base' as const, raw: GAS_FLOOR.base.toString() },
    { chain: 'robinhood' as const, raw: '0' },
  ];
  const holdings = [
    { chain: 'base' as const, token: usdc, raw: '2500000' },
    { chain: 'robinhood' as const, token: bySymbol('USDG', 'robinhood'), raw: '1000000' },
  ];

  it('covers every chain, including ones the account has never touched', () => {
    const rows = accountStatuses(native, holdings);
    expect(rows.map((r) => r.chain)).toEqual(['robinhood', 'base', 'xlayer']);
    expect(fundingState(rows[2])).toBe('empty');
  });

  it('puts each holding on its own chain and reads the balance as base units', () => {
    const rows = accountStatuses(native, holdings);
    const baseRow = rows.find((r) => r.chain === 'base')!;
    expect(baseRow.tokens).toEqual([{ token: usdc, balance: 2_500_000n }]);
    expect(baseRow.canTrade).toBe(true);
    // Funded with tokens and nothing to send them with.
    expect(fundingState(rows.find((r) => r.chain === 'robinhood')!)).toBe('needs-gas');
  });
});

describe('the steps of a withdrawal', () => {
  const status = statusFor('base', 10_000_000_000_000_000n, [
    { token: usdc, balance: 2_500_000n },
    { token: weth, balance: 10n ** 17n },
  ]);
  const steps = withdrawalSteps(base, OWNER, status, 1_000_000_000n);

  it('sends every token before it sends the gas that pays for them', () => {
    expect(steps).toHaveLength(3);
    expect(steps[0].transfer.to).toBe(usdc.address);
    expect(steps[1].transfer.to).toBe(weth.address);
    // The sweep is last, and it is the only transfer carrying value.
    expect(steps[2].transfer.to).toBe(OWNER);
    expect(steps[2].transfer.value).toBeGreaterThan(0n);
    expect(steps.slice(0, 2).every((s) => s.transfer.value === undefined)).toBe(true);
  });

  it('names each step by what leaves, in the order it leaves', () => {
    expect(steps[0].label).toBe(`2.5 USDC → 0x1111…1111`);
    expect(steps[1].label).toBe(`0.1 WETH → 0x1111…1111`);
    expect(steps[2].label).toContain('ETH → 0x1111…1111');
  });

  it('leaves out the sweep when the dust cannot pay for its own transfer', () => {
    const dust = statusFor('base', 1_000n, [{ token: usdc, balance: 1n }]);
    const only = withdrawalSteps(base, OWNER, dust, 1_000_000_000n);
    expect(only).toHaveLength(1);
    expect(only[0].transfer.to).toBe(usdc.address);
  });

  it('has nothing to do for an empty account', () => {
    expect(withdrawalSteps(base, OWNER, statusFor('base', 0n, []), 1_000_000_000n)).toEqual([]);
  });
});

describe('what a stopped withdrawal reports', () => {
  const status = statusFor('base', 10_000_000_000_000_000n, [
    { token: usdc, balance: 2_500_000n },
    { token: weth, balance: 10n ** 17n },
  ]);
  const steps = withdrawalSteps(base, OWNER, status, 1_000_000_000n);

  it('names the transfers that landed rather than failing the whole batch', () => {
    const note = landedNote(steps, 1);
    expect(note).toContain('1 of 3 sent');
    expect(note).toContain('2.5 USDC');
    expect(note).not.toContain('0.1 WETH');
    expect(note).toContain('still in the trading account');
  });

  it('does not claim anything moved when the first transfer failed', () => {
    expect(landedNote(steps, 0)).toBe('Nothing left the account.');
  });

  it('says so plainly when everything landed', () => {
    expect(landedNote(steps, 3)).toContain('All 3 sent');
    expect(landedNote(steps, 3)).not.toContain('still in the trading account');
  });
});

describe('formatting a gas balance', () => {
  it('reads as an amount of the chain’s own currency', () => {
    expect(nativeText(10n ** 18n, 'ETH')).toBe('1 ETH');
    expect(nativeText(6n * 10n ** 14n, 'OKB')).toBe('0.0006 OKB');
    expect(nativeText(0n, 'ETH')).toBe('0 ETH');
  });

  it('does not round a small balance away to zero', () => {
    // Asserted against literal amounts rather than against GAS_FLOOR: the
    // floors are derived from each chain's fee floor and are free to move,
    // and a formatting test that moves with them tests nothing.
    expect(nativeText(3n * 10n ** 14n, 'ETH')).toBe('0.0003 ETH');
    // A single wei does round away, which is right: six decimal places is a
    // balance a person reads, and dust below that is not a balance.
    expect(nativeText(1n, 'ETH')).toBe('0 ETH');
  });

  it('shows every gas floor as a figure a person can read', () => {
    // The floors are what the interface asks someone to fund, so none of them
    // may render as "0".
    for (const [chain, floor] of Object.entries(GAS_FLOOR)) {
      expect(nativeText(floor, 'X'), `${chain} floor renders as zero`).not.toBe('0 X');
    }
  });
});

describe('where a deposit leaves from', () => {
  const holding = (chain: 'base' | 'xlayer' | 'robinhood', symbol: string, raw: string) => ({
    chain,
    token: bySymbol(symbol, chain),
    raw,
  });

  it('leaves from wherever the wallet holds the most dollars', () => {
    const source = depositSource(
      [holding('base', 'USDC', '10000000'), holding('xlayer', 'USDG', '250000000')],
      ['base', 'xlayer', 'robinhood'],
    );
    expect(source?.chain.key).toBe('xlayer');
    expect(source?.balance).toBe(250000000n);
  });

  // The wallet's limit, not a preference: a chain the app never configured
  // cannot be sent from however much sits there.
  it('ignores a chain the wallet was never configured with', () => {
    const source = depositSource(
      [holding('base', 'USDC', '10000000'), holding('xlayer', 'USDG', '250000000')],
      ['base'],
    );
    expect(source?.chain.key).toBe('base');
  });

  // Nothing held anywhere still has to name a chain, or the panel has no
  // address to send to and no amount field to enable.
  it('still names a chain when the wallet holds no dollars', () => {
    const source = depositSource([], ['base', 'xlayer']);
    expect(source?.balance).toBe(0n);
    expect(source?.token.symbol).toBe(CHAINS[source!.chain.key].usd.symbol);
  });

  it('has nothing to offer when no chain is reachable', () => {
    expect(depositSource([holding('base', 'USDC', '1')], [])).toBeNull();
  });

  // Each chain has one dollar the router spends from — USDC on Base, USDG on
  // X Layer — and a balance in anything else is not it, however dollar-like.
  it('does not count a holding that is not the chain\'s own dollar', () => {
    expect(depositSource([holding('base', 'WETH', '1000000000000000000')], ['base'])?.balance).toBe(0n);
    expect(depositSource([holding('xlayer', 'USDC', '250000000')], ['xlayer'])?.balance).toBe(0n);
  });
});

describe('the account as one balance', () => {
  const holding = (chain: 'base' | 'xlayer' | 'robinhood', symbol: string, raw: string, amount: string) => ({
    chain,
    token: bySymbol(symbol, chain),
    raw,
    amount,
  });

  it('adds the dollars across chains into one figure', () => {
    // $60 on Base and $40 on X Layer is $100, which is the whole point.
    const dollars = unifiedDollars([
      holding('base', 'USDC', '60000000', '60'),
      holding('xlayer', 'USDG', '40000000', '40'),
    ]);
    expect(dollars).toBe(100_000_000n);
  });

  it('does not count a position as dollars', () => {
    expect(
      unifiedDollars([holding('base', 'WETH', '1000000000000000000', '1')]),
    ).toBe(0n);
  });

  it('adds one asset up across the chains it is held on', () => {
    const positions = unifiedPositions([
      {
        asset: 'NVDA',
        holdings: [holding('base', 'NVDAc', '2000000000000000000', '2'), holding('robinhood', 'NVDA', '3000000000000000000', '3')],
      },
      { asset: 'USD', holdings: [holding('base', 'USDC', '5000000', '5')] },
    ]);
    expect(positions).toEqual([{ asset: 'NVDA', total: 5, chains: ['base', 'robinhood'] }]);
  });

  it('calls an account frozen when it holds tokens and can sign nowhere', () => {
    const stuck = [
      statusFor('base', 0n, [{ token: usdc, balance: 100_000_000n }]),
      statusFor('xlayer', 0n, []),
      statusFor('robinhood', 0n, []),
    ];
    expect(isFrozen(stuck)).toBe(true);
    // Unfreeze the chain the money is on: gas anywhere else changes nothing.
    expect(chainToUnfreeze(stuck)).toBe('base');
  });

  it('is not frozen once one chain can pay its own way', () => {
    expect(
      isFrozen([
        statusFor('base', GAS_FLOOR.base, [{ token: usdc, balance: 100_000_000n }]),
        statusFor('xlayer', 0n, []),
      ]),
    ).toBe(false);
  });

  // An empty account is not frozen, it is empty — and telling someone to send
  // gas to an account with nothing in it is noise.
  it('is not frozen when it holds nothing at all', () => {
    expect(isFrozen([statusFor('base', 0n, []), statusFor('xlayer', 0n, [])])).toBe(false);
  });
});

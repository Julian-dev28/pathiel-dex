/**
 * Unit tests for the unified account view.
 *
 * No network. What is worth testing here is not the fetching — that is a POST
 * and three `eth_call`s — but the two transformations underneath it: folding
 * three chains' listings of one company into one holding, and reading
 * Hyperliquid's account state without trusting its shape.
 *
 * The balances are fixtures; the tokens are the real table, so a decimals
 * field that changes on a listing changes an expectation here.
 */

import { describe, it, expect } from 'vitest';
import { groupHoldings, parseClearinghouse } from '@/lib/balances';
import { bySymbol, type ChainKey, type Token } from '@/lib/chain';

const row = (chain: ChainKey, symbol: string, raw: bigint): { chain: ChainKey; token: Token; raw: bigint } => ({
  chain,
  token: bySymbol(symbol, chain),
  raw,
});

describe('grouping balances by canonical asset', () => {
  it('folds one company\'s three listings into one holding', () => {
    const assets = groupHoldings([
      row('robinhood', 'NVDA', 1_500000000000000000n),
      row('base', 'NVDAc', 250000000n),
      row('xlayer', 'wNVDAx', 2_000000000000000000n),
    ]);

    expect(assets).toHaveLength(1);
    expect(assets[0].asset).toBe('NVDA');
    expect(assets[0].holdings.map((h) => h.chain)).toEqual(['robinhood', 'base', 'xlayer']);
    expect(assets[0].holdings.map((h) => h.token.symbol)).toEqual(['NVDA', 'NVDAc', 'wNVDAx']);
  });

  it('drops zero balances rather than listing an asset nobody holds', () => {
    const assets = groupHoldings([
      row('robinhood', 'NVDA', 0n),
      row('base', 'NVDAc', 0n),
      row('base', 'WETH', 1n),
    ]);
    expect(assets.map((a) => a.asset)).toEqual(['ETH']);
  });

  it('returns nothing at all for an address holding nothing', () => {
    expect(groupHoldings([])).toEqual([]);
    expect(groupHoldings([row('base', 'USDC', 0n)])).toEqual([]);
  });

  it('scales each balance by its own token\'s decimals', () => {
    // 6, 8, 9 and 18 all appear in the real tables, and the same integer means
    // a different amount under each. One shared constant here would be a
    // twelve-orders-of-magnitude error on a stablecoin balance.
    const assets = groupHoldings([
      row('base', 'USDC', 123456789n), //  6 decimals
      row('base', 'NVDAc', 123456789n), //  8
      row('base', 'SOL', 123456789n), //  9
      row('base', 'WETH', 123456789n), // 18
    ]);
    const amount = (asset: string) => assets.find((a) => a.asset === asset)!.holdings[0].amount;

    expect(amount('USDC')).toBe('123.456789');
    expect(amount('NVDA')).toBe('1.23456789');
    expect(amount('SOL')).toBe('0.123456789');
    expect(amount('ETH')).toBe('0.000000000123456789');
  });

  it('carries base units through as an exact decimal string', () => {
    // JSON has no bigint, and a balance routed through a float loses the low
    // digits of any 18-decimal token.
    const [eth] = groupHoldings([row('base', 'WETH', 12345678901234567890n)]);
    expect(eth.holdings[0].raw).toBe('12345678901234567890');
  });

  it('leads with the asset held in the most places', () => {
    const assets = groupHoldings([
      row('base', 'USDC', 1n),
      row('robinhood', 'NVDA', 1n),
      row('base', 'NVDAc', 1n),
      row('xlayer', 'USDC', 1n),
      row('xlayer', 'wNVDAx', 1n),
    ]);
    expect(assets.map((a) => a.asset)).toEqual(['NVDA', 'USDC']);
    expect(assets[0].holdings).toHaveLength(3);
  });

  it('keeps two different dollars apart even on one chain', () => {
    const assets = groupHoldings([
      row('xlayer', 'USDC', 1_000000n),
      row('xlayer', 'USDG', 2_000000n),
      row('xlayer', 'USD₮0', 3_000000n),
    ]);
    expect(assets.map((a) => a.asset).sort()).toEqual(['USDC', 'USDG', 'USD₮0']);
  });
});

describe('Hyperliquid clearinghouse state', () => {
  const state = {
    marginSummary: {
      accountValue: '10420.55',
      totalNtlPos: '18000.0',
      totalRawUsd: '10420.55',
      totalMarginUsed: '900.0',
    },
    withdrawable: '9520.55',
    assetPositions: [
      {
        type: 'oneWay',
        position: {
          coin: 'xyz:NVDA',
          szi: '40.0',
          leverage: { type: 'cross', value: 20 },
          entryPx: '225.0',
          positionValue: '9128.4',
          unrealizedPnl: '128.4',
          marginUsed: '456.42',
        },
      },
      {
        type: 'oneWay',
        position: {
          coin: 'xyz:TSLA',
          szi: '-12.5',
          leverage: { type: 'isolated', value: 10 },
          entryPx: '410.0',
          positionValue: '5050.0',
          unrealizedPnl: '75.0',
          marginUsed: '505.0',
        },
      },
    ],
  };

  it('reads the margin summary and both sides of the book', () => {
    const account = parseClearinghouse(state, 'xyz');
    expect(account).toMatchObject({
      dex: 'xyz',
      accountValueUsd: 10420.55,
      marginUsedUsd: 900,
      withdrawableUsd: 9520.55,
    });
    expect(account.positions).toHaveLength(2);
    expect(account.positions[0]).toEqual({
      symbol: 'NVDA',
      size: 40,
      entryUsd: 225,
      valueUsd: 9128.4,
      unrealizedPnlUsd: 128.4,
      leverage: 20,
    });
    // Negative size is a short, and the sign is the whole meaning of the row.
    expect(account.positions[1].symbol).toBe('TSLA');
    expect(account.positions[1].size).toBe(-12.5);
  });

  it('strips the dex prefix so a perp shares a symbol with the spot side', () => {
    // `xyz:NVDA` is the same company as NVDA, NVDAc and wNVDAx.
    expect(parseClearinghouse(state, 'xyz').positions.map((p) => p.symbol)).toEqual(['NVDA', 'TSLA']);
  });

  it('reads core markets, which carry no prefix', () => {
    const core = parseClearinghouse(
      {
        marginSummary: { accountValue: '500.0', totalMarginUsed: '0.0' },
        withdrawable: '500.0',
        assetPositions: [{ position: { coin: 'BTC', szi: '0.1', entryPx: '86000', positionValue: '8600' } }],
      },
      '',
    );
    expect(core.dex).toBe('');
    expect(core.positions[0]).toMatchObject({ symbol: 'BTC', size: 0.1 });
    // No leverage field in the payload is 0, not NaN, which would render blank.
    expect(core.positions[0].leverage).toBe(0);
  });

  it('reports a funded account with no positions as funded, not as absent', () => {
    const idle = parseClearinghouse(
      { marginSummary: { accountValue: '250.0', totalMarginUsed: '0.0' }, withdrawable: '250.0', assetPositions: [] },
      'xyz',
    );
    expect(idle.accountValueUsd).toBe(250);
    expect(idle.positions).toEqual([]);
  });

  it('drops a closed position rather than showing a zero-size row', () => {
    const closed = parseClearinghouse(
      { assetPositions: [{ position: { coin: 'xyz:NVDA', szi: '0.0', entryPx: '0' } }] },
      'xyz',
    );
    expect(closed.positions).toEqual([]);
  });

  it('survives a response that is not an account at all', () => {
    // An address that has never touched Hyperliquid, an error body, a truncated
    // response: all of them are zeros, none of them throw.
    const empty = { dex: 'xyz', accountValueUsd: 0, marginUsedUsd: 0, withdrawableUsd: 0, positions: [] };
    for (const junk of [{}, null, undefined, [], 'error', 42, { marginSummary: null }]) {
      expect(parseClearinghouse(junk, 'xyz')).toEqual(empty);
    }
  });

  it('does not let an unparseable figure become NaN', () => {
    const odd = parseClearinghouse(
      { marginSummary: { accountValue: '' }, withdrawable: 'n/a', assetPositions: [{ position: { coin: 'BTC', szi: '1', entryPx: 'x' } }] },
      '',
    );
    expect(odd.accountValueUsd).toBe(0);
    expect(odd.withdrawableUsd).toBe(0);
    expect(odd.positions[0].entryUsd).toBe(0);
  });
});

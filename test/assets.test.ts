/**
 * Unit tests for the asset model and the perp side of it.
 *
 * No network: `fetchPerpMarkets` is a fetch and a filter, and what is worth
 * testing is the parsing and the symbol rules underneath it. The rules matter
 * more than they look — folding `USDC` into an asset called `USD`, or a staking
 * derivative into `ETH`, would quote a basis between two different things and
 * do it silently.
 */

import { describe, it, expect } from 'vitest';
import { canonical, unifiedAssets, listingOn } from '@/lib/assets';
import { parseMarkets, basisBps, annualisedFunding, type PerpMarket } from '@/lib/perps';
import { CHAIN_LIST } from '@/lib/chain';

describe('canonical symbols', () => {
  it('unwraps each chain\'s stock wrapper to the ticker', () => {
    expect(canonical('wNVDAx')).toBe('NVDA');
    expect(canonical('NVDAc')).toBe('NVDA');
    expect(canonical('NVDA')).toBe('NVDA');
    expect(canonical('wSPCXx')).toBe('SPCX');
    expect(canonical('wGOOGLx')).toBe('GOOGL');
  });

  it('unwraps native and wrapped majors', () => {
    expect(canonical('WETH')).toBe('ETH');
    expect(canonical('xETH')).toBe('ETH');
    expect(canonical('cbBTC')).toBe('BTC');
    expect(canonical('xBTC')).toBe('BTC');
    expect(canonical('xSOL')).toBe('SOL');
    expect(canonical('WOKB')).toBe('OKB');
  });

  it('leaves the dollars alone, including the ones ending in C', () => {
    for (const dollar of ['USDC', 'USDbC', 'USDG', 'USD₮0', 'USDT', 'DAI']) {
      expect(canonical(dollar)).toBe(dollar);
    }
  });

  it('leaves staking derivatives as their own asset', () => {
    // These track ETH but are not redeemable for it on demand: a basis quoted
    // against ETH would be measuring the staking spread, not the perp premium.
    for (const lst of ['cbETH', 'wstETH', 'rETH']) expect(canonical(lst)).toBe(lst);
  });

  it('is idempotent — an unwrapped symbol survives another pass', () => {
    for (const s of ['NVDA', 'ETH', 'BTC', 'USDG', 'cbETH']) {
      expect(canonical(canonical(s))).toBe(canonical(s));
    }
  });
});

describe('the asset table these rules produce', () => {
  const assets = unifiedAssets();
  const bySymbol = new Map(assets.map((a) => [a.symbol, a]));

  it('folds NVDA on three chains into one asset', () => {
    const nvda = bySymbol.get('NVDA');
    expect(nvda?.listings.map((l) => l.chain).sort()).toEqual(['base', 'robinhood', 'xlayer']);
    expect(listingOn(nvda!, 'xlayer')?.symbol).toBe('wNVDAx');
    expect(listingOn(nvda!, 'base')?.symbol).toBe('NVDAc');
    expect(listingOn(nvda!, 'robinhood')?.symbol).toBe('NVDA');
  });

  it('folds ETH across its wrappers and keeps OKB separate', () => {
    expect(bySymbol.get('ETH')?.listings.map((l) => l.chain).sort()).toEqual([
      'base',
      'robinhood',
      'xlayer',
    ]);
    // X Layer's gas token, wrapped. One chain, and not ETH.
    expect(bySymbol.get('OKB')?.listings.map((l) => l.chain)).toEqual(['xlayer']);
  });

  it('never folds two tokens on the same chain into one asset', () => {
    // The failure this guards against is a new listing matching a wrapper rule
    // by accident and quietly merging with something it is not.
    for (const asset of assets) {
      const chains = asset.listings.map((l) => l.chain);
      expect(new Set(chains).size, `${asset.symbol} listed twice on one chain`).toBe(chains.length);
    }
  });

  it('accounts for every listed token exactly once', () => {
    const listed = CHAIN_LIST.reduce((n, c) => n + c.tokens.length, 0);
    expect(assets.reduce((n, a) => n + a.listings.length, 0)).toBe(listed);
  });
});

describe('perp market parsing', () => {
  const meta = {
    universe: [
      { name: 'xyz:NVDA', maxLeverage: 20, szDecimals: 3 },
      { name: 'xyz:SP500', maxLeverage: 50, szDecimals: 2 },
      { name: 'xyz:GHOST', maxLeverage: 10, szDecimals: 2 },
    ],
  };
  const ctxs = [
    { markPx: '228.21', funding: '0.00000625', openInterest: '628661', dayNtlVlm: '36700000' },
    { markPx: '7757.8', funding: '-0.0000076849', openInterest: '52838', dayNtlVlm: '217740000' },
    // A market with no mark: not tradeable, and dividing by it later would be
    // worse than leaving it out.
    { funding: '0', openInterest: '0' },
  ];

  it('strips the dex prefix and lines contexts up by index', () => {
    const markets = parseMarkets([meta, ctxs], 'xyz');
    expect(markets.map((m) => m.symbol)).toEqual(['NVDA', 'SP500']);
    expect(markets[0].dex).toBe('xyz');
    expect(markets[0].maxLeverage).toBe(20);
    expect(markets[0].openInterestUsd).toBeCloseTo(628661 * 228.21, 0);
  });

  it('drops a market whose context is missing rather than shifting the rest', () => {
    const markets = parseMarkets([meta, [ctxs[0]]], 'xyz');
    expect(markets).toHaveLength(1);
    expect(markets[0].symbol).toBe('NVDA');
  });

  it('reads core markets, which carry no prefix', () => {
    const core = parseMarkets(
      [{ universe: [{ name: 'BTC', maxLeverage: 40, szDecimals: 5 }] }, [{ markPx: '86000' }]],
      '',
    );
    expect(core[0]).toMatchObject({ symbol: 'BTC', dex: '', markUsd: 86000 });
  });
});

describe('basis and funding', () => {
  const market = (over: Partial<PerpMarket> = {}): PerpMarket => ({
    symbol: 'NVDA',
    dex: 'xyz',
    markUsd: 228.21,
    fundingHourly: 0.00000625,
    openInterestUsd: 0,
    dayVolumeUsd: 0,
    maxLeverage: 20,
    ...over,
  });

  it('prices the perp premium over spot in basis points', () => {
    // The live pair this was written against: X Layer spot 228.71, perp 228.21.
    expect(basisBps(228.21, 228.71)).toBeCloseTo(-21.9, 1);
    expect(basisBps(101, 100)).toBeCloseTo(100, 6);
    expect(basisBps(100, 100)).toBe(0);
  });

  it('does not divide by a spot price it never got', () => {
    expect(basisBps(228.21, 0)).toBe(0);
  });

  it('annualises the hourly funding rate once', () => {
    // 0.00000625/hr is Hyperliquid's floor: about 5.5% a year, not 5.5% an hour.
    expect(annualisedFunding(market())).toBeCloseTo(0.0548, 4);
  });
});

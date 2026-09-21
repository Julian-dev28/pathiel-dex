/**
 * Uniswap V4 routing on Robinhood Chain, without the network.
 *
 * `scripts/simulate-swaps.ts` proves these transactions fill against the live
 * chain. These pin down the parts that decide *which* transaction gets built:
 * the pool registry's shape, the Permit2 approval pair, and the Universal
 * Router command sequence for each combination of native ETH and WETH at the
 * ends of a route.
 */

import { describe, it, expect } from 'vitest';
import { decodeFunctionData, parseAbi, type Address } from 'viem';
import { CHAINS, PERMIT2, bySymbol, type Token, type V4PoolKey } from '@/lib/chain';
import { v4Currency, type Venue } from '@/lib/quote';
import { approvalsFor, buildSwap } from '@/lib/execute';
import { universalRouterAbi } from '@/lib/abis';

const rh = CHAINS.robinhood;
const v4 = rh.v4!;
const NATIVE = '0x0000000000000000000000000000000000000000';
const ME: Address = '0x00000000000000000000000000000000000beef1';

const WETH = bySymbol('WETH');
const USDG = bySymbol('USDG');
const NVDA = bySymbol('NVDA');

const key = (a: Address, b: Address, fee = 3000, tickSpacing = 60): V4PoolKey => {
  const [currency0, currency1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return { currency0, currency1, fee, tickSpacing, hooks: NATIVE };
};

/** A one-pool V4 route from `a` to `b` through `k`. */
const single = (a: Token, b: Token, k: V4PoolKey): Venue => ({
  id: 'test',
  label: 'test',
  family: 'v4',
  path: [a, b],
  hops: [{ family: 'v4', key: k, zeroForOne: v4Currency(rh, k, a)!.toLowerCase() === k.currency0.toLowerCase() }],
  router: v4.universalRouter,
});

const commandsOf = (data: `0x${string}`) => {
  const { args } = decodeFunctionData({ abi: parseAbi(universalRouterAbi), data });
  return args[0];
};

describe('V4 pool registry', () => {
  const listed = new Set([NATIVE, ...rh.tokens.map((t) => t.address.toLowerCase())]);

  it('is not empty', () => {
    expect(v4.pools.length).toBeGreaterThan(0);
  });

  it('holds only hookless pools between listed tokens, sorted as V4 requires', () => {
    for (const p of v4.pools) {
      expect(p.hooks).toBe(NATIVE);
      expect(listed.has(p.currency0.toLowerCase())).toBe(true);
      expect(listed.has(p.currency1.toLowerCase())).toBe(true);
      expect(p.currency0.toLowerCase() < p.currency1.toLowerCase()).toBe(true);
    }
  });
});

describe('v4Currency', () => {
  it('reads native ETH as WETH, and nothing else as anything else', () => {
    const ethPool = key(NATIVE, USDG.address);
    expect(v4Currency(rh, ethPool, WETH)).toBe(NATIVE);
    expect(v4Currency(rh, ethPool, USDG)).toBe(USDG.address);
    expect(v4Currency(rh, ethPool, NVDA)).toBeNull();
  });
});

describe('approvalsFor', () => {
  it('asks for Permit2 and then the router on V4', () => {
    const a = approvalsFor(single(USDG, NVDA, key(USDG.address, NVDA.address)));
    expect(a.map((x) => [x.kind, x.spender])).toEqual([
      ['erc20', PERMIT2],
      ['permit2', v4.universalRouter],
    ]);
  });

  it('asks for the router alone everywhere else', () => {
    const v3: Venue = {
      id: 'v3',
      label: 'v3',
      family: 'v3',
      path: [USDG, NVDA],
      hops: [{ family: 'v3', fee: 500, dex: 0 }],
      router: rh.v3[0].router,
    };
    expect(approvalsFor(v3).map((x) => [x.kind, x.spender])).toEqual([['erc20', rh.v3[0].router]]);
  });
});

describe('V4 swap commands', () => {
  // Universal Router: 0x02 PERMIT2_TRANSFER_FROM, 0x0b WRAP_ETH,
  // 0x0c UNWRAP_WETH, 0x10 V4_SWAP.
  const build = (v: Venue) => buildSwap(v, 10n ** 18n, 1n, ME);

  it('swaps directly when neither end is native ETH', () => {
    const tx = build(single(USDG, NVDA, key(USDG.address, NVDA.address)));
    expect(tx.to).toBe(v4.universalRouter);
    expect(tx.value).toBe(0n);
    expect(commandsOf(tx.data)).toBe('0x10');
  });

  it('pulls and unwraps WETH before swapping in a native-ETH pool', () => {
    expect(commandsOf(build(single(WETH, USDG, key(NATIVE, USDG.address))).data)).toBe('0x020c10');
  });

  it('wraps the output when the pool pays native ETH', () => {
    expect(commandsOf(build(single(USDG, WETH, key(NATIVE, USDG.address))).data)).toBe('0x100b');
  });

  it('treats a WETH pool as an ordinary token', () => {
    expect(commandsOf(build(single(WETH, NVDA, key(WETH.address, NVDA.address))).data)).toBe('0x10');
  });

  it('never sends ETH from the wallet', () => {
    expect(build(single(WETH, USDG, key(NATIVE, USDG.address))).value).toBe(0n);
  });
});

/**
 * The unified-account swap router: planning and execution, with every network
 * call replaced.
 *
 * What is worth proving here is the arithmetic and the ordering — which chain
 * is drawn on first, that the shares add up to exactly what was asked, that a
 * share never asks for more than the chain holds, that native gas money is
 * wrapped only where it is the asset, and that gas lands before anything that
 * needs it. A mistake in any of those is a revert with fees already paid.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseUnits, type Address } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { CHAINS, type ChainKey, type Token } from '@/lib/chain';

// ── fakes ─────────────────────────────────────────────────────────────────

type ChainState = { erc20: Record<string, bigint>; native: bigint; gasPrice: bigint };
const state: Record<ChainKey, ChainState> = {} as never;

vi.mock('@/lib/quote', () => ({
  client: (chain: { key: ChainKey }) => ({
    readContract: async ({ address }: { address: string }) =>
      state[chain.key].erc20[address.toLowerCase()] ?? 0n,
    getBalance: async () => state[chain.key].native,
    getGasPrice: async () => state[chain.key].gasPrice,
  }),
}));

/** Units of output per unit of input, per chain, for in-place quotes. */
const rates: Partial<Record<ChainKey, number>> = {};
const fetchQuote = vi.fn();
vi.mock('@/lib/api', () => ({ fetchQuote: (...a: unknown[]) => fetchQuote(...a) }));

const bridgeQuote = vi.fn();
vi.mock('@/lib/bridge', () => ({ bridgeQuote: (...a: unknown[]) => bridgeQuote(...a) }));

const dollarBalances = vi.fn();
const buyGasQuote = vi.fn();
const routesFor = vi.fn();
const buy = vi.fn();
vi.mock('@/lib/account/autoroute', () => ({
  dollarBalances: (...a: unknown[]) => dollarBalances(...a),
  buyGasQuote: (...a: unknown[]) => buyGasQuote(...a),
  routesFor: (...a: unknown[]) => routesFor(...a),
  buy: (...a: unknown[]) => buy(...a),
  waitFor: async () => true,
}));

const calls: string[] = [];
const swapFromAccount = vi.fn();
const sendFromAccount = vi.fn();
vi.mock('@/lib/account/trade', async (orig) => ({
  ...(await orig<typeof import('@/lib/account/trade')>()),
  swapFromAccount: (...a: unknown[]) => swapFromAccount(...a),
  sendFromAccount: (...a: unknown[]) => sendFromAccount(...a),
}));

const { swapAssets, holdings, planSwap, executeSwap, unifiedBalance, SwapError } =
  await import('@/lib/account/swap');
const { TradeError } = await import('@/lib/account/trade');

// ── helpers ───────────────────────────────────────────────────────────────

const ASSETS = new Map(swapAssets().map((a) => [a.key, a]));
const asset = (k: string) => ASSETS.get(k)!;
const ACCOUNT = '0x00000000000000000000000000000000000000aa' as Address;
const eth = (n: string) => parseUnits(n, 18);
/** gasNeeded(1 wei) = 1 × 3,000,000 × 2. */
const GAS_TARGET = 6_000_000n;

const venue = (id: string, label = id) => ({ id, label, family: 'v3', hops: [], path: [] });

/** A quote shaped like `/api/quote`'s, paying `rate` out per unit in. */
function quoteFor(chain: ChainKey, tokenIn: Token, tokenOut: Token, amount: string) {
  const rate = rates[chain] ?? 0;
  const out = parseUnits((Number(amount) * rate).toFixed(6), tokenOut.decimals);
  const alt = (out * 999n) / 1000n;
  return {
    tokenIn,
    tokenOut,
    route: {
      single: { amountOut: out, allocations: [{ venue: venue(`${chain}-best`, 'Uniswap V3') }] },
    },
    venues: [
      { venue: venue(`${chain}-best`, 'Uniswap V3'), amountOutAtFull: out },
      { venue: venue(`${chain}-alt`, 'PancakeSwap V3'), amountOutAtFull: alt },
    ],
  };
}

function hold(chain: ChainKey, token: Token, amount: bigint) {
  state[chain].erc20[token.address.toLowerCase()] = amount;
}

beforeEach(() => {
  for (const k of ['robinhood', 'base', 'xlayer'] as ChainKey[]) {
    // Every chain can pay for gas unless a test says otherwise.
    state[k] = { erc20: {}, native: GAS_TARGET, gasPrice: 1n };
    delete rates[k];
  }
  calls.length = 0;
  fetchQuote
    .mockReset()
    .mockImplementation(async (chain: ChainKey, inSym: string, outSym: string, amount: string) => {
      const tIn = CHAINS[chain].tokens.find((t) => t.symbol === inSym)!;
      const tOut = CHAINS[chain].tokens.find((t) => t.symbol === outSym)!;
      return quoteFor(chain, tIn, tOut, amount);
    });
  bridgeQuote.mockReset().mockResolvedValue(null);
  dollarBalances.mockReset().mockResolvedValue([]);
  buyGasQuote.mockReset().mockResolvedValue(null);
  routesFor.mockReset();
  buy.mockReset();
  swapFromAccount
    .mockReset()
    .mockImplementation(
      async (_a, chain: ChainKey, v: { id: string }, amountIn: bigint, floor: bigint) => {
        calls.push(`swap ${chain} ${v.id} ${amountIn} floor=${floor}`);
        return [{ step: 'swap', description: `swap on ${chain}`, hash: `0x${chain}` }];
      },
    );
  sendFromAccount
    .mockReset()
    .mockImplementation(async (_a, chain: ChainKey, tx: { to: string; value?: bigint }) => {
      calls.push(`send ${chain} ${tx.to} value=${tx.value ?? 0n}`);
      return `0x${calls.length.toString(16).padStart(64, '0')}`;
    });
});

// ── assets ────────────────────────────────────────────────────────────────

describe('one asset however many chains list it', () => {
  it('folds each chain’s own dollar into USD', () => {
    const usd = asset('USD');
    expect(usd.byChain.robinhood?.address).toBe(CHAINS.robinhood.usd.address);
    expect(usd.byChain.base?.address).toBe(CHAINS.base.usd.address);
    expect(usd.byChain.xlayer?.address).toBe(CHAINS.xlayer.usd.address);
  });

  it('folds wrappers into their underlying: WETH, WETH and xETH are ETH', () => {
    const e = asset('ETH');
    expect(e.byChain.robinhood?.symbol).toBe('WETH');
    expect(e.byChain.base?.symbol).toBe('WETH');
    expect(e.byChain.xlayer?.symbol).toBe('xETH');
  });

  it('folds NVDA, NVDAc and wNVDAx into NVDA', () => {
    const n = asset('NVDA');
    expect(Object.keys(n.byChain).sort()).toEqual(['base', 'robinhood', 'xlayer']);
  });

  it('never lists the same key twice', () => {
    const keys = swapAssets().map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ── holdings ──────────────────────────────────────────────────────────────

describe('what the account holds', () => {
  it('counts native ETH as ETH where ETH is the gas, keeping gas back', async () => {
    state.base.native = eth('1') + GAS_TARGET;
    hold('base', CHAINS.base.weth, eth('0.5'));
    const h = (await holdings(ACCOUNT, asset('ETH'))).find((x) => x.chain === 'base')!;
    expect(h.erc20).toBe(eth('0.5'));
    expect(h.wrappable).toBe(eth('1'));
    expect(h.units).toBeCloseTo(1.5, 12);
  });

  it('does not count OKB as ETH on X Layer, where ETH is an ordinary token', async () => {
    state.xlayer.native = eth('5');
    const x = (await holdings(ACCOUNT, asset('ETH'))).find((h) => h.chain === 'xlayer')!;
    expect(x.wrappable).toBe(0n);
    expect(x.units).toBe(0);
  });

  it('sums every chain into one balance', async () => {
    hold('robinhood', CHAINS.robinhood.weth, eth('0.4'));
    hold('base', CHAINS.base.weth, eth('0.6'));
    expect(await unifiedBalance(ACCOUNT, asset('ETH'))).toBeCloseTo(1, 12);
  });

  it('reports no gas where the native balance is under the target', async () => {
    state.robinhood.native = GAS_TARGET - 1n;
    const r = (await holdings(ACCOUNT, asset('ETH'))).find((h) => h.chain === 'robinhood')!;
    expect(r.hasGas).toBe(false);
    expect(r.wrappable).toBe(0n);
  });
});

// ── planning a sale ───────────────────────────────────────────────────────

describe('planning a sale across the account', () => {
  it('draws on the best-paying chain first and fills the rest from the next', async () => {
    hold('robinhood', CHAINS.robinhood.weth, eth('0.4'));
    hold('base', CHAINS.base.weth, eth('0.6'));
    rates.robinhood = 2700;
    rates.base = 2600;

    const plan = await planSwap(ACCOUNT, asset('ETH'), asset('USD'), 0.8);
    if (plan.kind !== 'sell') throw new Error('expected a sale');
    expect(plan.legs.map((l) => [l.chain, l.amountIn])).toEqual([
      ['robinhood', eth('0.4')],
      ['base', eth('0.4')],
    ]);
    expect(plan.out).toBeCloseTo(0.4 * 2700 + 0.4 * 2600, 6);
  });

  it('re-prices a partial share at its own size rather than scaling the probe', async () => {
    hold('base', CHAINS.base.weth, eth('0.6'));
    hold('robinhood', CHAINS.robinhood.weth, eth('0.4'));
    rates.robinhood = 2700;
    rates.base = 2600;
    await planSwap(ACCOUNT, asset('ETH'), asset('USD'), 0.8);
    const baseAmounts = fetchQuote.mock.calls.filter((c) => c[0] === 'base').map((c) => c[3]);
    expect(baseAmounts).toEqual(['0.6', '0.4']);
  });

  it('asks for exactly what was typed: no floating-point tail', async () => {
    hold('base', CHAINS.base.weth, eth('1'));
    rates.base = 2600;
    const plan = await planSwap(ACCOUNT, asset('ETH'), asset('USD'), 0.05);
    if (plan.kind !== 'sell') throw new Error('expected a sale');
    // 0.05.toFixed(18) is 0.050000000000000003; the leg must be 5e16 exactly.
    expect(plan.legs[0].amountIn).toBe(eth('0.05'));
  });

  it.each([
    // Nine decimals round these up past the holding, and down short of it.
    ['up', 123456789600000000n],
    ['down', 123456789400000000n],
  ])('sells exactly the whole holding on "max" when rounding goes %s', async (_dir, held) => {
    hold('base', CHAINS.base.weth, held);
    rates.base = 2600;
    const max = await unifiedBalance(ACCOUNT, asset('ETH'));
    const plan = await planSwap(ACCOUNT, asset('ETH'), asset('USD'), max);
    if (plan.kind !== 'sell') throw new Error('expected a sale');
    expect(plan.legs[0].amountIn).toBe(held);
  });

  it('leaves the rest alone when selling part of a holding', async () => {
    hold('base', CHAINS.base.weth, eth('1'));
    rates.base = 2600;
    const plan = await planSwap(ACCOUNT, asset('ETH'), asset('USD'), 0.999);
    if (plan.kind !== 'sell') throw new Error('expected a sale');
    expect(plan.legs[0].amountIn).toBe(eth('0.999'));
  });

  it('wraps native ETH only for the part the WETH does not cover', async () => {
    hold('base', CHAINS.base.weth, eth('0.2'));
    state.base.native = eth('1') + GAS_TARGET;
    rates.base = 2600;
    const plan = await planSwap(ACCOUNT, asset('ETH'), asset('USD'), 0.5);
    if (plan.kind !== 'sell') throw new Error('expected a sale');
    expect(plan.legs[0].wrap).toBe(eth('0.3'));
  });

  it('crosses with Relay when the target is not listed where the asset sits, to the best destination', async () => {
    // cbBTC is on Robinhood Chain and Base; SOL is listed on Base and X Layer
    // only, so BTC held on Robinhood Chain has to cross to buy SOL.
    const btc = asset('BTC');
    hold('robinhood', btc.byChain.robinhood!, parseUnits('1', btc.byChain.robinhood!.decimals));
    bridgeQuote.mockImplementation(async (_w, _from, _tok, to: { chain: { key: ChainKey } }) => ({
      amountOutFormatted: to.chain.key === 'base' ? '400' : '390',
      steps: [],
    }));
    const plan = await planSwap(ACCOUNT, btc, asset('SOL'), 1);
    if (plan.kind !== 'sell') throw new Error('expected a sale');
    expect(plan.legs).toHaveLength(1);
    expect(plan.legs[0]).toMatchObject({
      kind: 'cross',
      chain: 'robinhood',
      dest: 'base',
      out: 400,
    });
  });

  it('refuses a sale larger than the whole account, naming what it holds', async () => {
    hold('base', CHAINS.base.weth, eth('0.3'));
    rates.base = 2600;
    await expect(planSwap(ACCOUNT, asset('ETH'), asset('USD'), 1)).rejects.toThrow(
      /holds 0.3 ETH and the trade needs 1/,
    );
  });

  it('refuses when no chain holding the asset will quote it', async () => {
    hold('base', CHAINS.base.weth, eth('1'));
    fetchQuote.mockRejectedValue(new Error('no route'));
    await expect(planSwap(ACCOUNT, asset('ETH'), asset('USD'), 0.5)).rejects.toThrow(
      /nothing quotes/,
    );
  });

  it('refuses a zero amount and a pair of the same asset', async () => {
    await expect(planSwap(ACCOUNT, asset('ETH'), asset('USD'), 0)).rejects.toBeInstanceOf(
      SwapError,
    );
    await expect(planSwap(ACCOUNT, asset('ETH'), asset('ETH'), 1)).rejects.toBeInstanceOf(
      SwapError,
    );
  });

  it('hands a dollar purchase to the account’s buy router', async () => {
    routesFor.mockResolvedValue([{ chain: 'robinhood', unitsOut: 0.5 }]);
    const plan = await planSwap(ACCOUNT, asset('USD'), asset('NVDA'), 100);
    expect(routesFor).toHaveBeenCalledWith(ACCOUNT, 'NVDA', 100);
    expect(plan.kind).toBe('buy');
  });
});

// ── gas ───────────────────────────────────────────────────────────────────

describe('gas on a chain that cannot sign', () => {
  const gasQuote = {
    amountInFormatted: '0.40',
    steps: [{ kind: 'deposit', to: '0x' + '9'.repeat(40), value: '0' }],
  };

  it('buys it from the chain holding the most dollars that can sign', async () => {
    hold('base', CHAINS.base.weth, eth('1'));
    state.base.native = 0n;
    rates.base = 2600;
    dollarBalances.mockResolvedValue([
      { chain: 'robinhood', value: 50_000_000n, hasGas: true },
      { chain: 'xlayer', value: 90_000_000n, hasGas: true },
    ]);
    buyGasQuote.mockResolvedValue(gasQuote);
    const plan = await planSwap(ACCOUNT, asset('ETH'), asset('USD'), 0.5);
    if (plan.kind !== 'sell') throw new Error('expected a sale');
    expect(plan.gas).toEqual([
      { chain: 'base', payer: 'xlayer', quote: gasQuote, target: GAS_TARGET, usd: 0.4 },
    ]);
  });

  it('says so plainly when nothing in the account can pay for it', async () => {
    hold('base', CHAINS.base.weth, eth('1'));
    state.base.native = 0n;
    rates.base = 2600;
    dollarBalances.mockResolvedValue([{ chain: 'robinhood', value: 0n, hasGas: false }]);
    await expect(planSwap(ACCOUNT, asset('ETH'), asset('USD'), 0.5)).rejects.toThrow(
      /Base has no ETH for gas/,
    );
  });

  it('asks for nothing when the chains that sign already have gas', async () => {
    hold('base', CHAINS.base.weth, eth('1'));
    rates.base = 2600;
    const plan = await planSwap(ACCOUNT, asset('ETH'), asset('USD'), 0.5);
    if (plan.kind !== 'sell') throw new Error('expected a sale');
    expect(plan.gas).toEqual([]);
    expect(dollarBalances).not.toHaveBeenCalled();
  });
});

// ── execution ─────────────────────────────────────────────────────────────

const SIGNER = { address: ACCOUNT } as PrivateKeyAccount;

describe('carrying out a plan', () => {
  it('buys gas, then wraps, then swaps — in that order', async () => {
    hold('base', CHAINS.base.weth, eth('0.2'));
    state.base.native = eth('1') + GAS_TARGET;
    rates.base = 2600;
    const plan = await planSwap(ACCOUNT, asset('ETH'), asset('USD'), 0.5);
    if (plan.kind !== 'sell') throw new Error('expected a sale');
    plan.gas.push({
      chain: 'base',
      payer: 'robinhood',
      quote: { steps: [{ kind: 'deposit', to: '0x' + '9'.repeat(40), value: '7' }] } as never,
      target: GAS_TARGET,
      usd: 0.4,
    });

    await executeSwap(SIGNER, plan, 50, {});
    expect(calls[0]).toBe(`send robinhood 0x${'9'.repeat(40)} value=7`);
    expect(calls[1]).toBe(`send base ${CHAINS.base.weth.address} value=${eth('0.3')}`);
    expect(calls[2]).toMatch(/^swap base base-best 500000000000000000 /);
  });

  it('prices the swap again at send time and floors it at the slippage', async () => {
    hold('base', CHAINS.base.weth, eth('1'));
    rates.base = 2600;
    const plan = await planSwap(ACCOUNT, asset('ETH'), asset('USD'), 1);
    rates.base = 2500; // the market moved between planning and sending
    await executeSwap(SIGNER, plan, 50, {});
    const expected = parseUnits('2500', CHAINS.base.usd.decimals);
    const floor = (expected * 9_950n) / 10_000n;
    expect(calls.at(-1)).toBe(`swap base base-best ${eth('1')} floor=${floor}`);
  });

  it('honours a venue picked for a chain, flooring on that venue’s own quote', async () => {
    hold('base', CHAINS.base.weth, eth('1'));
    rates.base = 2600;
    const plan = await planSwap(ACCOUNT, asset('ETH'), asset('USD'), 1);
    await executeSwap(SIGNER, plan, 100, { venueFor: { base: 'base-alt' } });
    const alt = (parseUnits('2600', CHAINS.base.usd.decimals) * 999n) / 1000n;
    expect(calls.at(-1)).toBe(`swap base base-alt ${eth('1')} floor=${(alt * 9_900n) / 10_000n}`);
  });

  it('sends a crossing’s fresh Relay steps from the chain the asset sits on', async () => {
    const btc = asset('BTC');
    hold('robinhood', btc.byChain.robinhood!, parseUnits('1', btc.byChain.robinhood!.decimals));
    bridgeQuote.mockResolvedValue({
      amountOutFormatted: '400',
      steps: [
        { kind: 'approve', to: '0x' + '1'.repeat(40) },
        { kind: 'deposit', to: '0x' + '2'.repeat(40), value: '0' },
      ],
    });
    const plan = await planSwap(ACCOUNT, btc, asset('SOL'), 1);
    await executeSwap(SIGNER, plan, 50, {});
    expect(calls).toEqual([
      `send robinhood 0x${'1'.repeat(40)} value=0`,
      `send robinhood 0x${'2'.repeat(40)} value=0`,
    ]);
  });

  it('reports every transaction that landed when a later one fails', async () => {
    hold('robinhood', CHAINS.robinhood.weth, eth('0.4'));
    hold('base', CHAINS.base.weth, eth('0.6'));
    rates.robinhood = 2700;
    rates.base = 2600;
    const plan = await planSwap(ACCOUNT, asset('ETH'), asset('USD'), 0.8);
    swapFromAccount
      .mockImplementationOnce(async () => [{ step: 'swap', description: 'first', hash: '0x01' }])
      .mockRejectedValueOnce(
        new TradeError('the swap reverted on Base', [
          { step: 'approve', description: 'approve', hash: '0x02' },
        ]),
      );
    const err = await executeSwap(SIGNER, plan, 50, {}).catch((e) => e);
    expect(err).toBeInstanceOf(TradeError);
    expect(err.message).toBe('the swap reverted on Base');
    expect((err as InstanceType<typeof TradeError>).sent.map((s) => s.description)).toEqual([
      'first',
      'approve',
    ]);
  });

  it('hands a purchase to the buy router with the chosen chain', async () => {
    const routes = [{ chain: 'robinhood' }, { chain: 'base' }];
    buy.mockResolvedValue([]);
    await executeSwap(SIGNER, { kind: 'buy', routes } as never, 30, { routeIndex: 1 });
    expect(buy).toHaveBeenCalledWith(SIGNER, routes[1], 30, undefined);
  });
});

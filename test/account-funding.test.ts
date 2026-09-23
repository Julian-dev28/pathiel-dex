/**
 * Tests for funding the trading account and emptying it again.
 *
 * Two failures are worth more attention than the happy path: an account
 * holding tokens and no gas, which cannot move its own money; and a
 * "withdraw everything" that leaves something behind. Both look like a broken
 * button to the customer and like nothing at all in a log.
 */

import { describe, it, expect } from 'vitest';
import { decodeFunctionData, parseAbi } from 'viem';
import { CHAINS, bySymbol } from '@/lib/chain';
import { erc20Abi } from '@/lib/abis';
import {
  GAS_FLOOR,
  canPayGas,
  fundGas,
  fundToken,
  gasShortfall,
  statusFor,
  withdrawEverything,
  withdrawGas,
  withdrawToken,
} from '@/lib/account/funding';

const ERC20 = parseAbi(erc20Abi);
const OWNER = '0x1111111111111111111111111111111111111111' as const;
const ACCOUNT = '0x2222222222222222222222222222222222222222' as const;
const base = CHAINS.base;
const usdc = bySymbol('USDC', 'base');

const decoded = (data: `0x${string}`) => decodeFunctionData({ abi: ERC20, data });

describe('funding', () => {
  it('sends a token to the account, not to the owner', () => {
    const tx = fundToken(base, usdc, ACCOUNT, 1_000_000n);
    const { functionName, args } = decoded(tx.data!);
    expect(functionName).toBe('transfer');
    expect(args?.[0]).toBe(ACCOUNT);
    expect(args?.[1]).toBe(1_000_000n);
    expect(tx.chainId).toBe(base.id);
  });

  it('sends native currency as value, with no calldata', () => {
    const tx = fundGas(base, ACCOUNT, 5n);
    expect(tx).toEqual({ to: ACCOUNT, value: 5n, chainId: base.id });
  });
});

describe('whether the account can act at all', () => {
  it('knows a funded account from a stranded one', () => {
    // Tokens and no gas is the state that reads as a broken button.
    expect(canPayGas('base', GAS_FLOOR.base)).toBe(true);
    expect(canPayGas('base', GAS_FLOOR.base - 1n)).toBe(false);
    expect(canPayGas('base', 0n)).toBe(false);
  });

  it('says how much is missing rather than only that something is', () => {
    expect(gasShortfall('xlayer', 0n)).toBe(GAS_FLOOR.xlayer);
    expect(gasShortfall('xlayer', GAS_FLOOR.xlayer)).toBe(0n);
    expect(gasShortfall('xlayer', GAS_FLOOR.xlayer + 10n)).toBe(0n);
  });

  it('has a floor for every chain, since each prices gas in its own token', () => {
    // A missing entry would be `undefined >= x`, which is false, and would
    // report every account on that chain as unable to trade.
    for (const chain of Object.values(CHAINS)) {
      expect(GAS_FLOOR[chain.key], `${chain.key} has no gas floor`).toBeGreaterThan(0n);
    }
  });

  it('reports only the balances worth showing', () => {
    const status = statusFor('base', 0n, [
      { token: usdc, balance: 0n },
      { token: bySymbol('WETH', 'base'), balance: 5n },
    ]);
    expect(status.tokens.map((t) => t.token.symbol)).toEqual(['WETH']);
    expect(status.canTrade).toBe(false);
  });
});

describe('withdrawing', () => {
  const gasPrice = 2_000_000_000n;

  it('keeps enough back to pay for its own transaction', () => {
    // Sending the entire balance cannot pay for itself; the transaction
    // simply fails and the customer sees a button that does nothing.
    const balance = 1_000_000_000_000_000n;
    const tx = withdrawGas(base, OWNER, balance, gasPrice)!;
    expect(tx.value).toBeLessThan(balance);
    expect(tx.value).toBe(balance - 21_000n * gasPrice * 2n);
  });

  it('refuses to sweep dust that costs more than it is worth', () => {
    expect(withdrawGas(base, OWNER, 1_000n, gasPrice)).toBeNull();
    expect(withdrawGas(base, OWNER, 21_000n * gasPrice * 2n, gasPrice)).toBeNull();
  });

  it('sends a token balance back to the owner', () => {
    const tx = withdrawToken(base, usdc, OWNER, 250n);
    const { args } = decoded(tx.data!);
    expect(args?.[0]).toBe(OWNER);
    expect(args?.[1]).toBe(250n);
  });

  it('moves the tokens before it sweeps the gas', () => {
    // The ordering is the difference between "withdraw everything" meaning it
    // and stranding tokens with nothing left to pay their way out.
    const status = statusFor('base', 1_000_000_000_000_000_000n, [
      { token: usdc, balance: 100n },
      { token: bySymbol('WETH', 'base'), balance: 200n },
    ]);
    const txs = withdrawEverything(base, OWNER, status, gasPrice);
    expect(txs).toHaveLength(3);
    expect(txs.slice(0, 2).every((t) => t.data !== undefined)).toBe(true);
    // The sweep is last and carries value rather than calldata.
    expect(txs[2].data).toBeUndefined();
    expect(txs[2].value).toBeGreaterThan(0n);
  });

  it('leaves the token transfers enough gas to land', () => {
    const balance = 1_000_000_000_000_000_000n;
    const status = statusFor('base', balance, [{ token: usdc, balance: 100n }]);
    const [, sweep] = withdrawEverything(base, OWNER, status, gasPrice);
    const reserved = balance - (sweep.value ?? 0n);
    // Enough for the token transfer plus the sweep itself, not merely the sweep.
    expect(reserved).toBeGreaterThan(21_000n * gasPrice * 2n);
  });

  it('still empties the tokens when the gas is too thin to sweep', () => {
    // The tokens are the part worth rescuing; the dust can stay.
    const status = statusFor('base', 1_000n, [{ token: usdc, balance: 100n }]);
    const txs = withdrawEverything(base, OWNER, status, gasPrice);
    expect(txs).toHaveLength(1);
    expect(txs[0].data).toBeDefined();
  });

  it('does nothing for an account that is already empty', () => {
    expect(withdrawEverything(base, OWNER, statusFor('base', 0n, []), gasPrice)).toEqual([]);
  });
});

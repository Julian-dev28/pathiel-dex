/**
 * One address, everything it holds.
 *
 * The same person's money is scattered across three chains and a perp venue,
 * and the wallet on each of them shows a different slice of it. This module
 * reads all four and puts them in one shape.
 *
 * Two things it deliberately does not do:
 *
 *   1. **It does not price anything.** Quoting every listed token on every
 *      chain is a hundred-odd contract calls to answer a question nobody
 *      asked; a balance is a fact about the chain, a dollar value is a claim
 *      about a market. The one dollar figure here is the perp margin, which
 *      Hyperliquid denominates in USDC before we see it.
 *   2. **It does not sign, hold or spend.** Every call below is a read.
 *
 * The spot side is grouped by canonical asset (see `./assets`): NVDA on
 * Robinhood Chain, NVDAc on Base and wNVDAx on X Layer are one holding in
 * three places, which is the entire reason this view exists.
 *
 * The perp side comes from Hyperliquid and is a different kind of number. A
 * balance below is chain state; the margin summary is a third party's ledger
 * entry for an account on a venue it operates. Callers should keep them
 * visibly apart rather than adding them up.
 */

import {
  encodeFunctionData,
  decodeFunctionResult,
  formatUnits,
  parseAbi,
  type Address,
} from 'viem';
import { CHAIN_LIST, MULTICALL3, type ChainConfig, type ChainKey, type Token } from './chain';
import { canonical } from './assets';
import { client } from './quote';
import { STOCK_PERP_DEX } from './perps';
import { erc20Abi, multicall3Abi } from './abis';

const ERC20 = parseAbi(erc20Abi);
const MC3 = parseAbi(multicall3Abi);

const INFO_URL = 'https://api.hyperliquid.xyz/info';

/** Amounts travel as decimal strings: JSON has no bigint, and this payload is
 *  read by a browser that only ever displays them. */
export type Holding = {
  chain: ChainKey;
  token: Token;
  /** Base units, as a decimal string. */
  raw: string;
  /** The same figure, scaled by the token's decimals. */
  amount: string;
};

/** One asset and every chain this address holds it on. */
export type AssetHoldings = { asset: string; holdings: Holding[] };

export type NativeBalance = {
  chain: ChainKey;
  symbol: string;
  decimals: number;
  raw: string;
  amount: string;
};

export type PerpPosition = {
  symbol: string;
  /** Signed size in contracts. Negative is short. */
  size: number;
  entryUsd: number;
  valueUsd: number;
  unrealizedPnlUsd: number;
  leverage: number;
};

/** Hyperliquid's ledger for this address on one dex. `dex` is '' for core. */
export type PerpAccount = {
  dex: string;
  accountValueUsd: number;
  marginUsedUsd: number;
  withdrawableUsd: number;
  positions: PerpPosition[];
};

/** A source that did not answer. Named rather than dropped: a chain whose RPC
 *  failed looks exactly like an address holding nothing on it. */
export type SourceError = { source: string; message: string };

export type AccountBalances = {
  address: Address;
  spot: { assets: AssetHoldings[]; native: NativeBalance[] };
  /** Hyperliquid denominates margin in USDC before we see it. */
  perps: { marginCurrency: 'USDC'; accounts: PerpAccount[] };
  errors: SourceError[];
};

/* ── pure: grouping and parsing ───────────────────────────────────────── */

/**
 * Balances grouped by the asset they represent, zero balances dropped.
 *
 * Ordered by how many chains carry the holding, then alphabetically, matching
 * `unifiedAssets()`: something held in three places is what this view is for.
 */
export function groupHoldings(
  rows: { chain: ChainKey; token: Token; raw: bigint }[],
): AssetHoldings[] {
  const byAsset = new Map<string, Holding[]>();
  for (const { chain, token, raw } of rows) {
    if (raw <= 0n) continue;
    const asset = canonical(token.symbol);
    const holdings = byAsset.get(asset) ?? [];
    holdings.push({
      chain,
      token,
      raw: raw.toString(),
      amount: formatUnits(raw, token.decimals),
    });
    byAsset.set(asset, holdings);
  }
  return [...byAsset.entries()]
    .map(([asset, holdings]) => ({ asset, holdings }))
    .sort((a, b) => b.holdings.length - a.holdings.length || a.asset.localeCompare(b.asset));
}

/** What `clearinghouseState` returns. Every figure arrives as a string. */
type ClearinghouseState = {
  marginSummary?: { accountValue?: string; totalMarginUsed?: string };
  withdrawable?: string;
  assetPositions?: {
    position?: {
      coin?: string;
      szi?: string;
      entryPx?: string;
      positionValue?: string;
      unrealizedPnl?: string;
      leverage?: { value?: number };
    };
  }[];
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Hyperliquid's account state for one dex.
 *
 * Written to survive a response that is not the expected shape — an address
 * that has never traded, an error object, an empty body. An account with no
 * positions and an account the endpoint could not describe are both reported
 * as zeros rather than as an exception, because neither is a failure the
 * reader can act on.
 */
export function parseClearinghouse(data: unknown, dex: string): PerpAccount {
  const state = (typeof data === 'object' && data !== null ? data : {}) as ClearinghouseState;
  const positions: PerpPosition[] = [];
  for (const entry of state.assetPositions ?? []) {
    const p = entry?.position;
    if (!p?.coin) continue;
    const size = num(p.szi);
    if (size === 0) continue;
    positions.push({
      // HIP-3 markets carry their dex as a prefix, as they do in the universe.
      symbol: canonical(p.coin.includes(':') ? p.coin.slice(p.coin.indexOf(':') + 1) : p.coin),
      size,
      entryUsd: num(p.entryPx),
      valueUsd: num(p.positionValue),
      unrealizedPnlUsd: num(p.unrealizedPnl),
      leverage: num(p.leverage?.value),
    });
  }
  return {
    dex,
    accountValueUsd: num(state.marginSummary?.accountValue),
    marginUsedUsd: num(state.marginSummary?.totalMarginUsed),
    withdrawableUsd: num(state.withdrawable),
    positions,
  };
}

/* ── reads ────────────────────────────────────────────────────────────── */

/**
 * A token balance, or null when the call did not answer.
 *
 * Null rather than zero, because this module's whole policy is that a source
 * which failed must be named rather than dropped — a chain whose RPC died
 * looks exactly like an address holding nothing on it. That was enforced per
 * chain and abandoned per token: one paused proxy in the table reported the
 * holding as absent with nothing in `errors` to say otherwise.
 */
const decodeBalance = (
  res: { success: boolean; returnData: `0x${string}` } | undefined,
): bigint | null => {
  if (!res?.success || res.returnData === '0x') return null;
  try {
    return decodeFunctionResult({ abi: ERC20, functionName: 'balanceOf', data: res.returnData }) as bigint;
  } catch {
    return null;
  }
};

/**
 * Every listed token on one chain, plus the gas token.
 *
 * One `aggregate3` rather than one `balanceOf` per token: X Layer answers an
 * eleventh call in a JSON-RPC batch with `-32014` and fails the whole batch,
 * which would read as an empty wallet. `client()` already sizes its transport
 * batches to `chain.maxRpcBatch`, and Multicall3 folds the token reads into a
 * single `eth_call` underneath that.
 */
async function chainBalances(chain: ChainConfig, address: Address) {
  const c = client(chain);
  const [native, results] = await Promise.all([
    c.getBalance({ address }),
    c.readContract({
      address: MULTICALL3,
      abi: MC3,
      functionName: 'aggregate3',
      args: [
        chain.tokens.map((t) => ({
          target: t.address as Address,
          allowFailure: true,
          callData: encodeFunctionData({ abi: ERC20, functionName: 'balanceOf', args: [address] }),
        })),
      ],
    }) as Promise<readonly { success: boolean; returnData: `0x${string}` }[]>,
  ]);

  return {
    native: {
      chain: chain.key,
      symbol: chain.viem.nativeCurrency.symbol,
      decimals: chain.viem.nativeCurrency.decimals,
      raw: native.toString(),
      amount: formatUnits(native, chain.viem.nativeCurrency.decimals),
    } satisfies NativeBalance,
    rows: chain.tokens.map((token, i) => ({
      chain: chain.key,
      token,
      raw: decodeBalance(results[i]),
    })),
  };
}

async function perpAccount(address: Address, dex: string): Promise<PerpAccount> {
  const res = await fetch(INFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user: address, ...(dex ? { dex } : {}) }),
  });
  if (!res.ok) throw new Error(`hyperliquid ${dex || 'core'}: ${res.status}`);
  return parseClearinghouse(await res.json(), dex);
}

const why = (e: unknown): string => (e instanceof Error ? e.message : 'unavailable');

/**
 * The whole account. Sources are read in parallel and one failing does not
 * take the others with it — it is named in `errors` instead.
 */
export async function fetchAccount(address: Address): Promise<AccountBalances> {
  const [spot, perps] = await Promise.all([
    Promise.allSettled(CHAIN_LIST.map((c) => chainBalances(c, address))),
    Promise.allSettled(['', STOCK_PERP_DEX].map((dex) => perpAccount(address, dex))),
  ]);

  const errors: SourceError[] = [];
  const rows: { chain: ChainKey; token: Token; raw: bigint }[] = [];
  const native: NativeBalance[] = [];
  spot.forEach((r, i) => {
    if (r.status === 'rejected') return errors.push({ source: CHAIN_LIST[i].key, message: why(r.reason) });
    native.push(r.value.native);
    for (const row of r.value.rows) {
      // A token whose balanceOf did not answer is named, not counted as zero.
      if (row.raw === null) {
        errors.push({
          source: `${row.chain}:${row.token.symbol}`,
          message: 'balanceOf did not answer',
        });
        continue;
      }
      rows.push({ chain: row.chain, token: row.token, raw: row.raw });
    }
  });

  const accounts: PerpAccount[] = [];
  perps.forEach((r, i) => {
    const dex = i === 0 ? '' : STOCK_PERP_DEX;
    if (r.status === 'rejected') {
      errors.push({ source: `hyperliquid:${dex || 'core'}`, message: why(r.reason) });
      return;
    }
    accounts.push(r.value);
  });

  return {
    address,
    spot: { assets: groupHoldings(rows), native },
    perps: { marginCurrency: 'USDC', accounts },
    errors,
  };
}

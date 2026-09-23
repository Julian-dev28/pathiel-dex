/**
 * Perp orders for the `xyz` stock dex, built and signed but never sent.
 *
 * This is the first module in the project that can move money, so it is built
 * to be small and to be boring. Two rules shape all of it:
 *
 *   1. **Building and sending are different functions**, exactly as `build_swap`
 *      is to `swap` in `mcp.ts`. Everything here returns a signed request that
 *      a caller can print, diff and reject; `sendExchange` is the only thing
 *      that reaches the network, it takes an already-signed request, and it is
 *      never called from inside a builder.
 *   2. **There is no withdrawal path, deliberately.** `withdraw3`, `usdSend`
 *      and `spotSend` — the three actions that move USDC to a stranger — are
 *      not implemented here and must never be. Code that cannot withdraw
 *      cannot be talked into withdrawing, by a prompt, a bug or a bad route,
 *      and the only account key held near this module is an agent key that
 *      Hyperliquid will not honour for them anyway.
 *
 * Every private key is a parameter. Nothing in this file reads the environment,
 * at import time or later: a module that never learns a key cannot leak one.
 *
 * The agent (API) key signs orders. The master key signs exactly two things —
 * `approveAgent` and `approveBuilderFee` — and those two builders say so.
 */

import { type Address, type Hex } from 'viem';
import { floatToWire, signL1Action, signUserAction, SIGNATURE_CHAIN_ID, type Signature } from './hl-sign';
import { fetchUniverse, STOCK_PERP_DEX } from './perps';

const EXCHANGE_URL = 'https://api.hyperliquid.xyz/exchange';

/**
 * `xyz`'s position in the `perpDexs` info response, whose first entry is
 * `null` for Hyperliquid's own universe. The list is append-only, so the index
 * of a dex is fixed once it is deployed; `xyz` was the first.
 */
export const STOCK_PERP_DEX_INDEX = 1;

/** Perp collateral, as `sendAsset` names it: token name and its spot token id. */
export const USDC_TOKEN = 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054';

/**
 * The integer that picks the market.
 *
 * A core market is simply its index in `meta.universe`. A HIP-3 builder dex is
 * offset: `100000 + perpDexIndex * 10000 + indexInUniverse`, so `xyz`'s first
 * market is 110000 and NVDA at universe index 7 is 110007.
 *
 * This is the one number with no error message behind it. A wrong index is not
 * rejected — it is a perfectly valid market somewhere else. Asset 7 is a coin
 * on the core dex; 110007 is a stock. The same order sent with the wrong one
 * buys the wrong thing at the wrong price, successfully.
 */
export const perpAssetId = (perpDexIndex: number, indexInUniverse: number): number =>
  perpDexIndex === 0 ? indexInUniverse : 100_000 + perpDexIndex * 10_000 + indexInUniverse;

/** Good-til-cancel, immediate-or-cancel, add-liquidity-only (post only). */
export type Tif = 'Gtc' | 'Ioc' | 'Alo';

export type OrderInput = {
  asset: number;
  isBuy: boolean;
  size: number;
  /** The limit price. A market order is `Ioc` at a `marketPrice`. */
  price: number;
  reduceOnly?: boolean;
  /** Defaults to `Gtc`. */
  tif?: Tif;
  /** Client order id: 16 bytes, the caller's own handle on the order. */
  cloid?: Hex;
  /** A referral fee to the builder, in tenths of a basis point. */
  builder?: { address: Address; feeTenthsBps: number };
};

/** What the exchange endpoint takes, and all any of these builders produce. */
export type ExchangeRequest = {
  action: Record<string, unknown>;
  nonce: number;
  signature: Signature;
  expiresAfter?: number;
};

/**
 * `nonce` is the millisecond timestamp the exchange orders actions by, and
 * `expiresAfter` is a millisecond deadline after which it refuses one outright.
 */
export type L1Opts = { nonce?: number; expiresAfter?: number };

async function l1Request(
  agentKey: Hex,
  action: Record<string, unknown>,
  { nonce = Date.now(), expiresAfter }: L1Opts,
): Promise<ExchangeRequest> {
  const signature = await signL1Action(agentKey, action, nonce, { expiresAfter: expiresAfter ?? null });
  return { action, nonce, signature, ...(expiresAfter === undefined ? {} : { expiresAfter }) };
}

/**
 * The order action, unsigned.
 *
 * Field order in the action is not cosmetic: it is msgpack'd in this order to
 * produce the hash that gets signed, so a reordering here silently invalidates
 * every signature. Shared with `perp-browser.ts` so that a wallet-signed order
 * and a key-signed one are the same bytes rather than two copies of them.
 */
export function orderAction(o: OrderInput): Record<string, unknown> {
  return {
    type: 'order',
    orders: [
      {
        a: o.asset,
        b: o.isBuy,
        p: floatToWire(o.price),
        s: floatToWire(o.size),
        r: o.reduceOnly ?? false,
        t: { limit: { tif: o.tif ?? 'Gtc' } },
        ...(o.cloid ? { c: o.cloid } : {}),
      },
    ],
    grouping: 'na',
    ...(o.builder ? { builder: { b: o.builder.address.toLowerCase(), f: o.builder.feeTenthsBps } } : {}),
  };
}

/** One order, signed and ready, sent nowhere. */
export async function buildOrder(agentKey: Hex, o: OrderInput, opts: L1Opts = {}): Promise<ExchangeRequest> {
  return l1Request(agentKey, orderAction(o), opts);
}

/**
 * The aggressive limit price that stands in for a market order.
 *
 * Hyperliquid has no market order type; a market order is an IOC limit priced
 * through the book. The rounding is the part that bites: a perp price carries
 * at most 5 significant figures and `6 - szDecimals` decimal places, and a
 * price breaking either rule is rejected. Mirrors `_slippage_price` in the
 * Python SDK, minus its spot branch — nothing here trades spot.
 */
export function marketPrice(refPx: number, isBuy: boolean, slippage: number, szDecimals: number): number {
  return roundPrice(refPx * (isBuy ? 1 + slippage : 1 - slippage), szDecimals);
}

/**
 * A price the exchange will accept.
 *
 * At most five significant figures and at most `6 - szDecimals` decimals. A
 * price breaking either is rejected, and the rejection says only that the
 * order is invalid — so a limit the user typed goes through this too, rather
 * than being signed verbatim and bounced.
 */
export function roundPrice(px: number, szDecimals: number): number {
  return Number(Number(px.toPrecision(5)).toFixed(6 - szDecimals));
}

export async function buildCancel(
  agentKey: Hex,
  cancels: { asset: number; oid: number }[],
  opts: L1Opts = {},
): Promise<ExchangeRequest> {
  const action = { type: 'cancel', cancels: cancels.map((c) => ({ a: c.asset, o: c.oid })) };
  return l1Request(agentKey, action, opts);
}

export async function buildUpdateLeverage(
  agentKey: Hex,
  { asset, isCross, leverage }: { asset: number; isCross: boolean; leverage: number },
  opts: L1Opts = {},
): Promise<ExchangeRequest> {
  return l1Request(agentKey, { type: 'updateLeverage', asset, isCross, leverage }, opts);
}

/**
 * The dead man's switch: at `time`, every open order is cancelled.
 *
 * Pass null to clear a scheduled cancel. The exchange wants the time at least
 * five seconds out and allows ten triggers a day. Worth setting before anything
 * runs unattended — it is the only protection that survives this process dying.
 */
export async function buildScheduleCancel(
  agentKey: Hex,
  time: number | null,
  opts: L1Opts = {},
): Promise<ExchangeRequest> {
  return l1Request(agentKey, { type: 'scheduleCancel', ...(time === null ? {} : { time }) }, opts);
}

async function userRequest(
  privateKey: Hex,
  action: Record<string, unknown>,
  fields: { name: string; type: string }[],
  primaryType: string,
  nonce: number,
): Promise<ExchangeRequest> {
  const full = { signatureChainId: SIGNATURE_CHAIN_ID, hyperliquidChain: 'Mainnet' as const, ...action };
  const signature = await signUserAction(privateKey, full, fields, primaryType);
  return { action: full, nonce, signature };
}

/**
 * Authorise an agent (API) wallet to trade for the account. **Master key.**
 *
 * This is the one action that has to be signed by the account itself, and it is
 * what makes every other signature in this file safe to automate: the agent key
 * it names can open and close positions and nothing else. Put the expiry in the
 * name — Hyperliquid reads `valid_until <ms>` out of it — and generate the
 * agent key somewhere this process never sees it again.
 */
export async function buildApproveAgent(
  masterKey: Hex,
  { agentAddress, agentName }: { agentAddress: Address; agentName: string },
  nonce = Date.now(),
): Promise<ExchangeRequest> {
  return userRequest(
    masterKey,
    { type: 'approveAgent', agentAddress, agentName, nonce },
    [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'agentAddress', type: 'address' },
      { name: 'agentName', type: 'string' },
      { name: 'nonce', type: 'uint64' },
    ],
    'HyperliquidTransaction:ApproveAgent',
    nonce,
  );
}

/**
 * Agree to pay a builder up to `maxFeeRate` on fills routed through them.
 * **Master key** — a fee approval is a spending decision, so an agent cannot
 * make it. The rate is a percent string, e.g. `'0.01%'`.
 */
export async function buildApproveBuilderFee(
  masterKey: Hex,
  { builder, maxFeeRate }: { builder: Address; maxFeeRate: string },
  nonce = Date.now(),
): Promise<ExchangeRequest> {
  return userRequest(
    masterKey,
    { type: 'approveBuilderFee', maxFeeRate, builder, nonce },
    [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'maxFeeRate', type: 'string' },
      { name: 'builder', type: 'address' },
      { name: 'nonce', type: 'uint64' },
    ],
    'HyperliquidTransaction:ApproveBuilderFee',
    nonce,
  );
}

/**
 * Move USDC between the account's own perp dexes — core margin to the `xyz`
 * stock dex's margin, or back.
 *
 * This is the whole shape of what an agent key is allowed to do with money: it
 * can fund the margin that backs its own trades, and it cannot pay anybody. A
 * transfer to another address is `usdSend`, which this module does not
 * implement and never will.
 *
 * Note what this does and does not guarantee. The destination is whatever the
 * caller passes as `address`, so the restriction to self is Hyperliquid's —
 * it refuses an agent-signed transfer to anyone else — and not this code's. An
 * earlier comment here claimed the parameter could not be anything else, which
 * was simply untrue of the signature above it.
 *
 * `sourceDex`/`destinationDex` are dex names: `''` is Hyperliquid's own perp
 * dex, `'xyz'` the stock dex. Only the collateral token can cross.
 */
export async function buildAgentSendAsset(
  agentKey: Hex,
  {
    address,
    sourceDex,
    destinationDex,
    amount,
  }: { address: Address; sourceDex: string; destinationDex: string; amount: number },
  nonce = Date.now(),
): Promise<ExchangeRequest> {
  return userRequest(
    agentKey,
    {
      type: 'sendAsset',
      destination: address,
      sourceDex,
      destinationDex,
      token: USDC_TOKEN,
      amount: floatToWire(amount),
      fromSubAccount: '',
      nonce,
    },
    [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'destination', type: 'string' },
      { name: 'sourceDex', type: 'string' },
      { name: 'destinationDex', type: 'string' },
      { name: 'token', type: 'string' },
      { name: 'amount', type: 'string' },
      { name: 'fromSubAccount', type: 'string' },
      { name: 'nonce', type: 'uint64' },
    ],
    'HyperliquidTransaction:SendAsset',
    nonce,
  );
}

/**
 * The only function here that touches the network.
 *
 * It takes a request that has already been built, signed and — the point of
 * the split — looked at. A failed action comes back as HTTP 200 with a status
 * of `err`, so the body is checked rather than the status code.
 */
/** A market, resolved to everything an order needs to name it. */
export type MarketRef = {
  symbol: string;
  /** '' for Hyperliquid's own universe, otherwise the HIP-3 dex. */
  dex: string;
  assetId: number;
  szDecimals: number;
  maxLeverage: number;
};

/**
 * Find a market by asset symbol, stocks first.
 *
 * The asset id is the whole point of this: an index into a universe means
 * nothing without knowing which universe, and `xyz`'s NVDA and a core market
 * sharing an index are different instruments. Resolved from the live universe
 * rather than a table, because a list that grows by one shifts nothing today
 * and everything tomorrow.
 */
export async function resolveMarket(symbol: string, dex?: string): Promise<MarketRef | null> {
  const wanted = symbol.toUpperCase();
  // Naming the dex matters the day the `xyz` deployer lists a ticker the core
  // universe already has. They share none today, so stocks-first resolves
  // correctly — and would keep resolving "correctly" to the wrong venue after
  // such a listing, with the mark agreeing and nothing looking wrong.
  const only = (d: string) => dex === undefined || dex === d;
  const [stocks, core] = await Promise.all([
    fetchUniverse(STOCK_PERP_DEX),
    fetchUniverse(''),
  ]);

  const stockIndex = only(STOCK_PERP_DEX)
    ? stocks.findIndex((m) => m.name.toUpperCase() === `${STOCK_PERP_DEX.toUpperCase()}:${wanted}`)
    : -1;
  if (stockIndex >= 0) {
    const m = stocks[stockIndex];
    return {
      symbol: wanted,
      dex: STOCK_PERP_DEX,
      assetId: perpAssetId(STOCK_PERP_DEX_INDEX, stockIndex),
      szDecimals: m.szDecimals,
      maxLeverage: m.maxLeverage,
    };
  }

  const coreIndex = only('') ? core.findIndex((m) => m.name.toUpperCase() === wanted) : -1;
  if (coreIndex < 0) return null;
  return {
    symbol: wanted,
    dex: '',
    assetId: coreIndex,
    szDecimals: core[coreIndex].szDecimals,
    maxLeverage: core[coreIndex].maxLeverage,
  };
}

export async function sendExchange(req: ExchangeRequest): Promise<unknown> {
  const res = await fetch(EXCHANGE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`hyperliquid exchange: ${res.status}`);
  const body = (await res.json()) as {
    status?: string;
    response?: { data?: { statuses?: { error?: string }[] } };
  };
  if (body.status === 'err') throw new Error(`hyperliquid exchange: ${JSON.stringify(body.response)}`);
  // A rejected order is an HTTP 200 with status "ok" and the reason buried in
  // the per-order statuses — which is how both an unfilled IOC and an
  // insufficient-margin refusal come back. Reported as sent, they would read
  // as a filled position that does not exist.
  const rejected = body.response?.data?.statuses?.find((st) => st?.error);
  if (rejected) throw new Error(`hyperliquid rejected the order: ${rejected.error}`);
  return body;
}

/**
 * The same perp order, signed by the wallet in the browser instead of by a key.
 *
 * `perp-order.ts` signs with a raw private key, which is right for the local
 * MCP server and impossible in a page: the key belongs to the wallet and never
 * leaves it. So the split here is not build-then-send but build-then-sign-then-
 * send — `prepareOrder` returns the EIP-712 payload to hand to wagmi's
 * `useSignTypedData`, and `finalize` turns the signature it gives back into the
 * request the exchange takes.
 *
 * Two properties are worth stating because they are what this module is for:
 *
 *   1. **It is the same bytes.** The action comes from `orderAction` and the
 *      payload from `l1Payload`, both shared with the key path, so a browser
 *      order and an MCP order of the same intent are byte-identical.
 *      `test/perp-browser.test.ts` signs one both ways and compares; if that
 *      ever fails, the UI is producing orders the exchange will reject.
 *   2. **Nothing here holds key material, and nothing is delegated.** An order
 *      signed by the connected wallet is an ordinary L1 action — there is no
 *      agent wallet in this path, and a session key in a browser is not
 *      something this module offers.
 */

import { l1Payload, splitSignature } from './hl-sign';
import { cancelAction, type OpenOrder } from './perp-orders';
import {
  marketPrice,
  roundPrice,
  orderAction,
  resolveMarket,
  sendExchange,
  type ExchangeRequest,
} from './perp-order';
import { fetchPerpMarkets } from './perps';

/** The whole contract lives here; a caller need not know where the type does. */
export type { ExchangeRequest };

/** How far through the book a market order reaches, when nothing says. */
const DEFAULT_SLIPPAGE_BPS = 50;

/**
 * The smallest order Hyperliquid accepts, in notional dollars.
 *
 * Checked here rather than discovered from the exchange, because the rejection
 * comes back as a bare string after the customer has already signed — and a
 * signature spent on an order that could never be accepted is the one kind of
 * failure this module can prevent outright.
 */
export const MIN_ORDER_USD = 10;

export type PerpOrderIntent = {
  /** Canonical symbol, e.g. 'NVDA'. */
  asset: string;
  side: 'buy' | 'sell';
  /** Notional before leverage. */
  usd: number;
  /** Omit for a market order (IOC through the book). */
  limitPrice?: number;
  reduceOnly?: boolean;
  /**
   * Which universe the market is in: '' for Hyperliquid's own, 'xyz' for the
   * stock dex. Omitted resolves stocks-first, which is right today only
   * because the two share no symbols.
   */
  dex?: string;
  /** Market orders only; defaults to 50. */
  slippageBps?: number;
};

export type PreparedOrder = {
  /** What the order does, in the terms a person can check it in. */
  summary: {
    market: string;
    assetId: number;
    side: 'buy' | 'sell';
    size: number;
    markUsd: number;
    priceUsd: number;
    notionalUsd: number;
    orderType: string;
    maxLeverage: number;
  };
  /** Pass straight to wagmi's `useSignTypedData`. */
  typedData: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  };
  /** The wallet's 65-byte signature, split into the r/s/v the exchange wants. */
  finalize: (signature: `0x${string}`) => ExchangeRequest;
};

/**
 * Price and size an intent, and return it ready to sign.
 *
 * The nonce is fixed here rather than at signing time: it is part of the hash
 * inside `typedData`, so the request `finalize` builds has to carry the same
 * one. A prepared order left sitting is therefore stale — prepare again rather
 * than signing an old one.
 */
export async function prepareOrder(intent: PerpOrderIntent): Promise<PreparedOrder> {
  const market = await resolveMarket(intent.asset, intent.dex);
  if (!market) throw new Error(`no perp market for ${intent.asset}`);

  const [live] = (await fetchPerpMarkets()).filter(
    (m) => m.symbol === market.symbol && m.dex === market.dex,
  );
  if (!live) throw new Error(`no mark price for ${intent.asset}`);

  const isBuy = intent.side === 'buy';
  const isLimit = intent.limitPrice !== undefined;
  const slippage = (intent.slippageBps ?? DEFAULT_SLIPPAGE_BPS) / 10_000;
  // A user's limit price goes through the same rounding as a computed one. The
  // exchange rejects a price carrying more than five significant figures or
  // more than `6 - szDecimals` decimals, and says only that it is invalid.
  const price = isLimit
    ? roundPrice(intent.limitPrice!, market.szDecimals)
    : marketPrice(live.markUsd, isBuy, slippage, market.szDecimals);

  // Sized at the price the order will actually rest at, not at the mark. A
  // limit set away from the mark used to buy `usd × limit / mark` — a limit
  // 65% above the mark bought 65% more than the dollar figure asked for, and
  // the margin check upstream had already approved the smaller number.
  //
  // Rounded down, not to nearest: rounding up hands back a position larger
  // than the dollars requested, which on a coarse market is a fifth again and
  // a margin requirement nobody agreed to.
  const step = 10 ** market.szDecimals;
  const size = Math.floor((intent.usd / price) * step) / step;
  if (size <= 0) throw new Error(`${intent.usd} USD is below one tick of ${market.symbol}`);
  // Measured on the rounded size, which is what the exchange will see: $10.40
  // of a coarse market can round down to nine dollars of notional and be
  // rejected for a minimum the customer thought they had cleared.
  if (size * price < MIN_ORDER_USD) {
    throw new Error(
      `Hyperliquid will not take an order under $${MIN_ORDER_USD}; this one works out at $${(size * price).toFixed(2)}`,
    );
  }

  const action = orderAction({
    asset: market.assetId,
    isBuy,
    size,
    price,
    reduceOnly: intent.reduceOnly ?? false,
    tif: isLimit ? 'Gtc' : 'Ioc',
  });
  const nonce = Date.now();

  return {
    summary: {
      market: `${market.dex || 'core'}:${market.symbol}`,
      assetId: market.assetId,
      side: intent.side,
      size,
      markUsd: live.markUsd,
      priceUsd: price,
      notionalUsd: size * price,
      orderType: isLimit ? 'limit (Gtc)' : 'market (IOC through the book)',
      maxLeverage: market.maxLeverage,
    },
    typedData: l1Payload(action, nonce),
    finalize: (signature) => ({ action, nonce, signature: splitSignature(signature) }),
  };
}

/**
 * Send a signed order to Hyperliquid, straight from the browser.
 *
 * There is deliberately no server route in front of this. Hyperliquid answers
 * `/exchange` with `access-control-allow-origin: *`, so the order can go from
 * the user's wallet to the venue without this app's server in the path: a
 * server that never sees an order cannot delay it, reorder it or log it.
 */
export async function submitOrder(req: ExchangeRequest): Promise<unknown> {
  return sendExchange(req);
}

/**
 * A cancel, ready for the same wallet to sign.
 *
 * Built the same way as an order and sent to the same endpoint, because to the
 * exchange it is the same kind of thing: an L1 action, signed by whoever owns
 * the order. The summary is what the customer is cancelling rather than what
 * they are buying, since that is what they are about to confirm.
 */
export function prepareCancel(order: OpenOrder): {
  summary: { market: string; side: 'buy' | 'sell'; sizeLeft: number; limitUsd: number };
  typedData: PreparedOrder['typedData'];
  finalize: (signature: `0x${string}`) => ExchangeRequest;
} {
  const action = cancelAction([{ assetId: order.assetId, oid: order.oid }]);
  const nonce = Date.now();
  return {
    summary: {
      market: `${order.dex || 'core'}:${order.symbol}`,
      side: order.side,
      sizeLeft: order.sizeLeft,
      limitUsd: order.limitUsd,
    },
    typedData: l1Payload(action, nonce),
    finalize: (signature) => ({ action, nonce, signature: splitSignature(signature) }),
  };
}

/**
 * Hyperliquid's rejections, in the customer's terms.
 *
 * The exchange answers with a bare string, and two of them mean something the
 * customer can act on but would never guess. "does not exist" is not a bug and
 * not a lost order: it is what an account that has never been funded on
 * Hyperliquid is called, and the fix is a margin transfer. Anything unrecognised
 * is passed through unchanged rather than dressed up — a wrong explanation is
 * worse than a venue's own words.
 */
export function explainExchangeError(message: string): string {
  if (/does not exist/i.test(message)) {
    return 'This account has never been funded on Hyperliquid, so the venue has no record of it yet. Move some dollars into the margin account above and the same order will work.';
  }
  if (/insufficient margin|not enough margin/i.test(message)) {
    return 'Not enough margin behind this order. Reduce the size, or move more dollars into the margin account above.';
  }
  return message;
}

/**
 * The arithmetic behind the order ticket.
 *
 * These live beside the component rather than inside it because they are the
 * only part of an order that can be wrong in a way a test catches — a size, a
 * leverage, the reason a button refuses — and this repo's unit tests cannot
 * import a `.tsx`. Nothing here touches the network, the wallet or React.
 */

/** A dollar field is worth nothing until it is a positive number. */
export function usdAmount(text: string): number {
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Contracts a dollar amount buys at a price. The venue rounds it; this is the
 *  figure shown beside the field so the size is never a surprise. */
export const sizeAtPrice = (usd: number, priceUsd: number): number =>
  priceUsd > 0 ? usd / priceUsd : 0;

/**
 * The collateral this order locks up.
 *
 * Initial margin is the reciprocal of the market's maximum leverage — a 5×
 * market holds a fifth of the notional — and that ceiling is set by the dex's
 * deployer, not by this app.
 */
/**
 * Initial margin for a notional at a given leverage.
 *
 * The leverage that matters is the account's own setting, not the market's
 * ceiling. Nothing here ever sends updateLeverage, so an account sits at
 * whatever Hyperliquid defaults it to — quoting a $1,000 NVDA order as needing
 * $50 "at 20×" while the account runs at 2× understates the requirement by
 * ten times, and understating it is the direction that lets an order through.
 */
export const marginRequiredUsd = (notionalUsd: number, leverage: number): number =>
  leverage > 0 ? notionalUsd / leverage : 0;

/**
 * The notional against the whole margin account, which is the leverage the
 * account is actually running. Null when there is no margin: a ratio over zero
 * is not "infinite leverage", it is an account that cannot trade at all.
 */
export function accountLeverage(notionalUsd: number, accountValueUsd: number): number | null {
  if (accountValueUsd <= 0) return null;
  return notionalUsd / accountValueUsd;
}

/**
 * How far the price may move against the position before it is liquidated.
 *
 * Maintenance margin on Hyperliquid is half the initial margin at the market's
 * maximum leverage, so the buffer is the gap between what the position holds
 * (1/leverage) and what it must keep. Approximate on purpose: it assumes this
 * is the only position in the account and ignores fees and funding, both of
 * which move the line closer rather than further away.
 */
export function liquidationDropPct(leverage: number, maxLeverage: number): number | null {
  if (leverage <= 0 || maxLeverage <= 0) return null;
  return Math.max(0, (1 / leverage - 1 / (2 * maxLeverage)) * 100);
}

/** A signed size read out loud. Negative is short, and saying so beats a minus
 *  sign the reader has to interpret. */
export const positionLabel = (size: number, symbol: string): string =>
  size === 0
    ? `No ${symbol} position`
    : `${size > 0 ? 'Long' : 'Short'} ${Math.abs(size).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${symbol}`;

/** The order that flattens a position: the other side, at the mark, reduce-only. */
export const closeOrder = (size: number, markUsd: number): { side: 'buy' | 'sell'; usd: number } => ({
  side: size > 0 ? 'sell' : 'buy',
  usd: Math.abs(size) * markUsd,
});

export type Ticket = {
  connected: boolean;
  /** Account value in this dex's own margin account, in USDC. */
  /** Collateral that is not already backing a position. */
  freeMarginUsd: number;
  usd: number;
  isLimit: boolean;
  limitUsd: number;
  reduceOnly: boolean;
  /** Signed size of the position already open in this market. */
  positionSize: number;
  /** The account's own leverage setting for this market, not the market's ceiling. */
  leverage: number;
  acknowledged: boolean;
};

/**
 * Why the ticket will not send, in the order the user should hear it.
 *
 * Null means it will. Every branch here is a condition the exchange would
 * reject or a decision the user has not made yet, because a button that can
 * only fail is worse than a button that says what is missing.
 */
export function blockedReason(t: Ticket): string | null {
  if (!t.connected) return 'Connect a wallet';
  if (t.freeMarginUsd <= 0) return 'Fund this margin account first';
  if (t.usd <= 0) return 'Enter a dollar size';
  if (t.isLimit && t.limitUsd <= 0) return 'Enter a limit price';
  if (t.reduceOnly && t.positionSize === 0) return 'No position to reduce';
  // A close frees margin rather than locking more, so it is never blocked by
  // the size of the account that already backs the position.
  // Free collateral, not account value: an account whose value is entirely
  // backing other positions has nothing left to open another one with.
  if (!t.reduceOnly && marginRequiredUsd(t.usd, t.leverage) > t.freeMarginUsd)
    return 'More margin than this account has free';
  if (!t.acknowledged) return 'Acknowledge the liquidation risk';
  return null;
}

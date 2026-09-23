/**
 * Unit tests for the arithmetic and the refusals behind the perp ticket.
 *
 * No network and no rendering: what is worth testing here is not that a card
 * appears but that the numbers beside the risk checkbox are the right ones, and
 * that the button refuses in the right order. A ticket that offers to send an
 * order the exchange will reject — no margin, no size, a reduce-only order with
 * nothing to reduce — is the failure this file exists to catch.
 */

import { describe, it, expect } from 'vitest';
import {
  accountLeverage,
  blockedReason,
  closeOrder,
  liquidationDropPct,
  marginRequiredUsd,
  positionLabel,
  sizeAtPrice,
  usdAmount,
  type Ticket,
} from '@/components/perp-ticket';

const ticket = (t: Partial<Ticket> = {}): Ticket => ({
  connected: true,
  freeMarginUsd: 1_000,
  usd: 500,
  isLimit: false,
  limitUsd: 0,
  reduceOnly: false,
  positionSize: 0,
  leverage: 5,
  acknowledged: true,
  ...t,
});

describe('usdAmount', () => {
  it('reads a dollar field', () => {
    expect(usdAmount('250.5')).toBe(250.5);
  });

  it('treats anything that is not a positive number as nothing', () => {
    for (const text of ['', '  ', 'abc', '0', '-10', 'NaN', 'Infinity']) {
      expect(usdAmount(text)).toBe(0);
    }
  });
});

describe('sizeAtPrice', () => {
  it('divides the notional by the price', () => {
    expect(sizeAtPrice(1_000, 200)).toBe(5);
  });

  it('has no size without a price rather than an infinite one', () => {
    expect(sizeAtPrice(1_000, 0)).toBe(0);
  });
});

describe('marginRequiredUsd', () => {
  it('takes the reciprocal of the market maximum leverage', () => {
    expect(marginRequiredUsd(1_000, 5)).toBe(200);
    expect(marginRequiredUsd(1_000, 20)).toBe(50);
  });

  it('is zero when the market states no leverage ceiling', () => {
    expect(marginRequiredUsd(1_000, 0)).toBe(0);
  });
});

describe('accountLeverage', () => {
  it('measures the notional against the whole margin account', () => {
    expect(accountLeverage(2_000, 500)).toBe(4);
  });

  it('is null rather than infinite when there is no margin', () => {
    expect(accountLeverage(2_000, 0)).toBeNull();
    expect(accountLeverage(2_000, -1)).toBeNull();
  });
});

describe('liquidationDropPct', () => {
  it('leaves the gap between the initial margin and the maintenance margin', () => {
    // 4× on a 5× market: holding 25%, must keep 10%, so 15% of room.
    expect(liquidationDropPct(4, 5)).toBeCloseTo(15, 9);
  });

  it('shrinks as the leverage rises', () => {
    expect(liquidationDropPct(2, 5)!).toBeGreaterThan(liquidationDropPct(4, 5)!);
  });

  it('never reports negative room', () => {
    expect(liquidationDropPct(50, 5)).toBe(0);
  });

  it('has nothing to say without a position or a market', () => {
    expect(liquidationDropPct(0, 5)).toBeNull();
    expect(liquidationDropPct(4, 0)).toBeNull();
  });
});

describe('positionLabel', () => {
  it('says long and short rather than printing a minus sign', () => {
    expect(positionLabel(12.5, 'NVDA')).toBe('Long 12.5 NVDA');
    expect(positionLabel(-12.5, 'NVDA')).toBe('Short 12.5 NVDA');
  });

  it('names the market when there is no position in it', () => {
    expect(positionLabel(0, 'NVDA')).toBe('No NVDA position');
  });
});

describe('closeOrder', () => {
  it('flattens a long by selling its value at the mark', () => {
    expect(closeOrder(4, 250)).toEqual({ side: 'sell', usd: 1_000 });
  });

  it('flattens a short by buying it back', () => {
    expect(closeOrder(-4, 250)).toEqual({ side: 'buy', usd: 1_000 });
  });
});

describe('blockedReason', () => {
  it('sends a funded, sized, acknowledged order', () => {
    expect(blockedReason(ticket())).toBeNull();
  });

  it('asks for a wallet first', () => {
    expect(blockedReason(ticket({ connected: false, freeMarginUsd: 0, usd: 0 }))).toBe(
      'Connect a wallet',
    );
  });

  it('refuses an order against an empty margin account', () => {
    expect(blockedReason(ticket({ freeMarginUsd: 0 }))).toBe('Fund this margin account first');
  });

  it('refuses a zero size', () => {
    expect(blockedReason(ticket({ usd: 0 }))).toBe('Enter a dollar size');
  });

  it('refuses a limit order with no limit price', () => {
    expect(blockedReason(ticket({ isLimit: true }))).toBe('Enter a limit price');
    expect(blockedReason(ticket({ isLimit: true, limitUsd: 210 }))).toBeNull();
  });

  it('refuses to reduce a position that is not open', () => {
    expect(blockedReason(ticket({ reduceOnly: true }))).toBe('No position to reduce');
  });

  it('refuses a size the account cannot post margin for', () => {
    // $10,000 at 5× needs $2,000 of the $1,000 free.
    expect(blockedReason(ticket({ usd: 10_000 }))).toBe('More margin than this account has free');
  });

  it('measures against free collateral, not the whole account value', () => {
    // An account worth plenty but with all of it backing other positions has
    // nothing left to open another one with. Gating on account value let this
    // through; the panel was showing the free figure two lines away.
    expect(blockedReason(ticket({ usd: 1_000, freeMarginUsd: 100 }))).toBe(
      'More margin than this account has free',
    );
  });

  it('uses the account leverage it was given, not the market ceiling', () => {
    // $1,000 at 20× is $50 of margin; the same order at 2× is $500. Nothing
    // here sets leverage, so the lower, real figure is the one that gates.
    expect(blockedReason(ticket({ usd: 1_000, leverage: 20, freeMarginUsd: 100 }))).toBeNull();
    expect(blockedReason(ticket({ usd: 1_000, leverage: 2, freeMarginUsd: 100 }))).toBe(
      'More margin than this account has free',
    );
  });

  it('lets a close through at any size, because it frees margin', () => {
    expect(blockedReason(ticket({ usd: 10_000, reduceOnly: true, positionSize: -40 }))).toBeNull();
  });

  it('holds the order until the liquidation risk is acknowledged', () => {
    expect(blockedReason(ticket({ acknowledged: false }))).toBe(
      'Acknowledge the liquidation risk',
    );
  });
});

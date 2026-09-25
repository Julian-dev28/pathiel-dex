/**
 * Moving dollars from the account into a perp margin account.
 *
 * The same account trades spot on three chains and perps on Hyperliquid, but a
 * perp settles in USDC held inside the dex's *own* margin account — dollars on
 * Base cannot back it, however unified the balance looks on screen. Until this
 * existed the ticket said so and left the customer to go and bridge, which is
 * the drag the rest of this product removes.
 *
 * One source chain rather than several. A margin top-up is a transfer the
 * customer chooses the size of, not a trade that has to fill, so if one chain
 * cannot cover it the honest answer is the amount that can — not four crossings
 * and three waits.
 */

import type { Address, PrivateKeyAccount } from 'viem';
import { CHAINS } from '../chain';
import { bridgeQuote, type BridgeQuote } from '../bridge';
import { dollarBalances } from './autoroute';
import { sendFromAccount, type SentStep } from './trade';
import { fromMicro, toMicroUsd, totalDollars, usdOf, type DollarSide } from './plan';

export class MarginError extends Error {}

/** Which dex's margin the dollars are going to. */
export type MarginDex = 'xyz' | 'core';

export type MarginFunding = {
  from: DollarSide['chain'];
  dex: MarginDex;
  quote: BridgeQuote;
  /** Dollars leaving the account. */
  usd: number;
  /** USDC the bridge says will land in the margin account. */
  arrivingUsd: number;
};

/**
 * Price a top-up without sending it.
 *
 * Quoted from the chain holding the most dollars it can actually sign on,
 * because a crossing from a chain with no gas cannot be signed and a crossing
 * from a chain short of dollars cannot be filled.
 */
export async function quoteMarginFunding(
  account: Address,
  dex: MarginDex,
  usd: number,
): Promise<MarginFunding> {
  if (!Number.isFinite(usd) || usd <= 0) throw new MarginError('enter an amount to move');
  const sides = await dollarBalances(account);
  const need = toMicroUsd(usd);

  const source = sides
    .filter((s) => s.hasGas)
    .sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0))
    .find((s) => s.value >= need);

  if (!source) {
    const held = totalDollars(sides);
    const signable = totalDollars(sides.filter((s) => s.hasGas));
    throw new MarginError(
      signable < need && held >= need
        ? `these dollars are on a chain this account has no gas on — $${usdOf(signable).toFixed(2)} can be moved right now`
        : `this account holds $${usdOf(held).toFixed(2)} and you asked to move $${usd.toFixed(2)}`,
    );
  }

  const from = CHAINS[source.chain];
  const quote = await bridgeQuote(
    account,
    from,
    from.usd,
    { kind: 'perpMargin', dex },
    fromMicro(need, from.usd.decimals),
  ).catch(() => null);

  if (!quote || !/^\d+(\.\d+)?$/.test(quote.amountOutFormatted)) {
    throw new MarginError(`no route from ${from.name} into the ${dex} margin account right now`);
  }

  return {
    from: source.chain,
    dex,
    quote,
    usd,
    arrivingUsd: Number(quote.amountOutFormatted),
  };
}

/**
 * Send it.
 *
 * Nothing waits for the deposit to credit: Hyperliquid's own ledger is what
 * shows it, and the ticket re-reads that. Reporting the transactions that were
 * sent is the truthful thing this can say — the credit is the venue's to make.
 */
export async function fundMargin(
  account: PrivateKeyAccount,
  funding: MarginFunding,
): Promise<SentStep[]> {
  const from = CHAINS[funding.from];
  const sent: SentStep[] = [];
  for (const step of funding.quote.steps) {
    if (!step.to) continue;
    const hash = await sendFromAccount(account, funding.from, {
      to: step.to,
      data: step.data,
      value: step.value ? BigInt(step.value) : 0n,
    });
    sent.push({
      step: 'approve',
      description: `$${funding.usd.toFixed(2)} from ${from.name} into ${funding.dex} margin`,
      hash,
    });
  }
  if (sent.length === 0) throw new MarginError('the bridge returned nothing to send');
  return sent;
}

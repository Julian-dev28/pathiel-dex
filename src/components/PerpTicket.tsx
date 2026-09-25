'use client';

import { useEffect, useState, useRef } from 'react';
import { useAccount, useSignTypedData } from 'wagmi';
import type { AccountBalances, PerpAccount } from '@/lib/balances';
import { STOCK_PERP_DEX, type PerpRow } from '@/lib/perps';
import { CHAINS } from '@/lib/chain';
import {
  fundMargin,
  quoteMarginFunding,
  type MarginFunding,
} from '@/lib/account/margin';
import type { SentStep } from '@/lib/account/trade';
import {
  explainExchangeError,
  prepareOrder,
  submitOrder,
  type PreparedOrder,
} from '@/lib/perp-browser';
import { useTradingAccount } from './AccountProvider';
import { Card, Answer, Answers, Chip, Empty, ErrorNote, Reveal, Segmented, Suggest } from './ui';
import {
  accountLeverage,
  blockedReason,
  closeOrder,
  liquidationDropPct,
  marginRequiredUsd,
  positionLabel,
  sizeAtPrice,
  usdAmount,
} from './perp-ticket';

const usd = (v: number) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const dexName = (dex: string) => dex || 'core';

/**
 * The order ticket.
 *
 * Everything above this on the page is a read; this is the one thing on it that
 * spends money, and it spends it on the only instrument in this product whose
 * downside is not bounded by a spread. Two facts therefore sit in the ticket
 * itself rather than in a footnote:
 *
 *   1. **The collateral is somewhere else.** USDC on Base cannot back a trade
 *      on the `xyz` dex; only USDC already sitting in that dex's own margin
 *      account can. An empty margin account is stated plainly and the button
 *      refuses, because a rejected order is a worse way to learn this.
 *   2. **A position can be liquidated.** The swap form asks for an
 *      acknowledgement when a trade moves the price 3%; losing the entire
 *      margin deserves at least the same, with the leverage and the distance to
 *      liquidation both on screen beside the checkbox.
 *
 * The build-then-send split is the same one the swap form and the MCP tools
 * use: `prepareOrder` returns a summary and typed data and touches nothing,
 * and only the confirm button signs and submits.
 */
export function PerpTicket({ row }: { row: PerpRow | null }) {
  const { address: wallet, isConnected } = useAccount();
  // The trading account is the Hyperliquid account when it is unlocked: same
  // key, same address, and margin funded to it rather than to the wallet.
  const { account: signer } = useTradingAccount();
  const address = signer?.address ?? wallet;
  const { signTypedDataAsync } = useSignTypedData();

  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [isLimit, setIsLimit] = useState(false);
  const [amount, setAmount] = useState('100');
  const [limit, setLimit] = useState('');
  const [reduceOnly, setReduceOnly] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  /** Bumped by every edit, so a pricing call that outlives its form is dropped. */
  const formToken = useRef(0);

  const [accounts, setAccounts] = useState<PerpAccount[] | null>(null);
  // Separate from `accounts` because an account that has never traded on this
  // dex and an account still being read both have no margin, and only one of
  // them is something to tell the user about.
  const [readMargin, setReadMargin] = useState(false);
  const [prepared, setPrepared] = useState<PreparedOrder | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<unknown>(null);
  const [placedAt, setPlacedAt] = useState(0);

  // Funding margin out of the account's own dollars. Held apart from the order
  // state: a top-up is not an order, and a failed one must not read as a
  // rejected trade.
  const [topUp, setTopUp] = useState('100');
  const [funding, setFunding] = useState<MarginFunding | null>(null);
  const [fundingBusy, setFundingBusy] = useState(false);
  const [fundingError, setFundingError] = useState<string | null>(null);
  const [funded, setFunded] = useState<SentStep[] | null>(null);

  // The margin account is read from the same endpoint the account page uses;
  // re-read after a fill, because the position it shows is the thing that just
  // changed.
  useEffect(() => {
    if (!address) {
      setAccounts(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/balances?address=${address}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `balances: ${res.status}`);
        return body as AccountBalances;
      })
      .then((b) => !cancelled && setAccounts(b.perps.accounts))
      .catch(() => !cancelled && setAccounts(null))
      .finally(() => !cancelled && setReadMargin(true));
    return () => {
      cancelled = true;
    };
  }, [address, placedAt]);

  // Anything the user edits invalidates the reviewed order: a signature has to
  // belong to the summary they read, not to an earlier one.
  //
  // The token is what makes that true of a pricing call still in flight. The
  // effect clears `prepared` immediately, but an awaited prepareOrder from
  // before the edit would otherwise resolve afterwards and reinstate an order
  // for the side, size or market the user has just moved away from.
  useEffect(() => {
    formToken.current += 1;
    setPrepared(null);
    setAcknowledged(false);
    setError(null);
  }, [row?.symbol, row?.dex, side, isLimit, amount, limit, reduceOnly]);

  if (!isConnected || !address) {
    return (
      <Card title="Trade a perp" step={2}>
        <Empty>
          Connect a wallet from the masthead to trade one of these markets. Collateral is USDC in
          the dex&rsquo;s own margin account, so the ticket reads that account before it offers you
          anything.
        </Empty>
      </Card>
    );
  }

  if (!row) {
    return (
      <Card title="Trade a perp" step={2}>
        <Empty>Pick a market in the table above to open a ticket on it.</Empty>
      </Card>
    );
  }

  const account = accounts?.find((a) => a.dex === row.dex);
  const marginUsd = account?.accountValueUsd ?? 0;
  // What can actually back a new position. Value already committed to open
  // positions cannot, and the panel two lines down has always shown both.
  const freeMarginUsd = account?.withdrawableUsd ?? 0;
  const position = account?.positions.find((p) => p.symbol === row.symbol);
  const positionSize = position?.size ?? 0;
  // The account's own setting where a position reveals it, the market ceiling
  // only as a fallback. Nothing here sends updateLeverage, so this is a read.
  const accountLev = position?.leverage && position.leverage > 0 ? position.leverage : row.maxLeverage;

  const sizeUsd = usdAmount(amount);
  const limitUsd = usdAmount(limit);
  const priceUsd = isLimit && limitUsd > 0 ? limitUsd : row.markUsd;
  const size = sizeAtPrice(sizeUsd, priceUsd);
  const leverage = accountLeverage(sizeUsd, marginUsd);
  const liqDrop = leverage === null ? null : liquidationDropPct(leverage, row.maxLeverage);
  const severe = liqDrop !== null && liqDrop < 10;

  const blocked = blockedReason({
    connected: isConnected,
    freeMarginUsd,
    leverage: accountLev,
    usd: sizeUsd,
    isLimit,
    limitUsd,
    reduceOnly,
    positionSize,

    acknowledged,
  });

  const onReview = async () => {
    const token = formToken.current;
    setBusy(true);
    setError(null);
    setResponse(null);
    try {
      const built = await prepareOrder({
        asset: row.symbol,
        // The row the user clicked names its own universe; resolving by symbol
        // alone would pick stocks-first regardless of which they chose.
        dex: row.dex,
        side,
        usd: sizeUsd,
        ...(isLimit ? { limitPrice: limitUsd } : {}),
        reduceOnly,
      });
      // The form changed while this was pricing. Dropping the result is the
      // only safe answer: showing it would put a summary on screen that no
      // longer matches the controls above it.
      if (token !== formToken.current) return;
      setPrepared(built);
    } catch (e) {
      if (token === formToken.current) {
        setError(e instanceof Error ? e.message : 'could not build the order');
      }
    } finally {
      if (token === formToken.current) setBusy(false);
    }
  };

  const onConfirm = async () => {
    if (!prepared) return;
    // Checked again here rather than trusted from review. The acknowledgement
    // can be withdrawn after the order is prepared, and margin can be spent by
    // another tab in between; neither should be able to reach a signature.
    if (blocked) {
      setError(blocked);
      setPrepared(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // The typed data is Hyperliquid's own EIP-712 payload, handed over as
      // plain records; whoever signs is asked for exactly what was reviewed.
      // The account signs in the page when it is unlocked, which is the whole
      // point of it — a perp order should not need a popup either.
      const typedData = prepared.typedData as unknown as Parameters<
        typeof signTypedDataAsync
      >[0];
      const signature = signer
        ? await signer.signTypedData(
            prepared.typedData as unknown as Parameters<typeof signer.signTypedData>[0],
          )
        : await signTypedDataAsync(typedData);
      setResponse(await submitOrder(prepared.finalize(signature)));
      setPrepared(null);
      setPlacedAt(Date.now());
    } catch (e) {
      setError(
        e instanceof Error
          ? explainExchangeError(e.message.split('\n')[0])
          : 'the order was not placed',
      );
    } finally {
      setBusy(false);
    }
  };

  /** One line that is always true about what the button will do next. */
  const buttonLabel = (): string => {
    if (!readMargin) return 'Reading your margin…';
    if (busy) return prepared ? 'Confirm in your wallet…' : 'Pricing the order…';
    // Read from the prepared summary, never from the live form: those are the
    // same only when nothing has changed since review, and if they have
    // diverged this button is the last place it can be caught.
    if (prepared)
      return `Sign and place — ${prepared.summary.side} ${prepared.summary.size} ${prepared.summary.market.split(':')[1]} at ${usd(prepared.summary.priceUsd)}`;
    return blocked ?? `Review ${side === 'buy' ? 'long' : 'short'} ${usd(sizeUsd)} ${row.symbol}`;
  };

  return (
    <>
      <Card
        title={`Trade ${row.symbol}`}
        step={2}
        meta={<Chip tone={row.dex ? 'accent' : 'mut'}>{dexName(row.dex)}</Chip>}
      >
        <Answers>
          <Answer
            label={`Margin on ${dexName(row.dex)}`}
            value={usd(marginUsd)}
            unit="USDC"
            size="xl"
            tone={marginUsd > 0 ? undefined : 'bad'}
            note={
              account
                ? `${usd(account.marginUsedUsd)} already backing positions, ${usd(account.withdrawableUsd)} free`
                : readMargin
                  ? `this address has never held collateral on ${dexName(row.dex)}`
                  : 'reading this address on Hyperliquid…'
            }
          />
          <Answer
            label="Your position"
            value={positionLabel(positionSize, row.symbol)}
            tone={positionSize === 0 ? 'mut' : positionSize > 0 ? 'good' : 'bad'}
            note={
              position
                ? `entry ${usd(position.entryUsd)} · ${usd(position.unrealizedPnlUsd)} unrealised · ${position.leverage}×`
                : 'nothing open in this market'
            }
          />
        </Answers>

        {readMargin && signer && (
          <div className={marginUsd <= 0 ? undefined : 'c-secondary'}>
            {marginUsd <= 0 && (
              <Suggest tone="warn">
                <strong>There is no collateral here to trade with.</strong> A perp on{' '}
                {dexName(row.dex)} settles in USDC held in that dex&rsquo;s own margin account —
                dollars sitting on Base, Robinhood Chain or X Layer cannot back it. Move some across
                below and every order here starts working; until it lands, they are all rejected.
              </Suggest>
            )}

            <div className="c-slot-label">
              {marginUsd <= 0 ? 'Fund this margin account' : 'Add margin'}
            </div>
            <div className="c-controls">
              <input
                className="c-input"
                inputMode="decimal"
                value={topUp}
                onChange={(e) => {
                  setTopUp(e.target.value);
                  setFunding(null);
                  setFunded(null);
                }}
                aria-label={`Dollars to move into the ${dexName(row.dex)} margin account`}
              />
              <button
                className="c-ghost"
                type="button"
                disabled={fundingBusy}
                onClick={() => {
                  setFundingError(null);
                  setFundingBusy(true);
                  quoteMarginFunding(signer.address, row.dex === STOCK_PERP_DEX ? 'xyz' : 'core', Number(topUp))
                    .then(setFunding)
                    .catch((e) => setFundingError(e instanceof Error ? e.message : 'could not price that'))
                    .finally(() => setFundingBusy(false));
                }}
              >
                {fundingBusy ? 'Pricing…' : 'Price the transfer'}
              </button>
            </div>

            {funding && (
              <>
                <p className="c-empty" style={{ marginTop: 10 }}>
                  ${funding.usd.toFixed(2)} from {CHAINS[funding.from].name} arrives as $
                  {funding.arrivingUsd.toFixed(2)} of margin, in about {funding.quote.etaSeconds}s.
                  The ${(funding.usd - funding.arrivingUsd).toFixed(2)} difference is close to a flat
                  fee rather than a percentage, so one transfer costs far less than three.
                </p>
                <button
                  className="c-go"
                  type="button"
                  disabled={fundingBusy}
                  onClick={() => {
                    setFundingBusy(true);
                    setFundingError(null);
                    fundMargin(signer, funding)
                      .then((sent) => {
                        setFunded(sent);
                        setFunding(null);
                        setPlacedAt(Date.now());
                      })
                      .catch((e) =>
                        setFundingError(e instanceof Error ? e.message : 'the transfer failed'),
                      )
                      .finally(() => setFundingBusy(false));
                  }}
                >
                  Move ${funding.usd.toFixed(2)} into {dexName(row.dex)} margin
                </button>
              </>
            )}

            {funded && (
              <div className="c-tx ok">
                <span>✓ Sent — Hyperliquid credits it when the solver delivers</span>
                <span className="mono">{funded[funded.length - 1]?.hash.slice(0, 10)}…</span>
              </div>
            )}
            {fundingError && <ErrorNote>{fundingError}</ErrorNote>}
          </div>
        )}

        {positionSize !== 0 && (
          <Suggest
            action="Close it"
            onAction={() => {
              const close = closeOrder(positionSize, row.markUsd);
              setSide(close.side);
              setIsLimit(false);
              setAmount(close.usd.toFixed(2));
              setReduceOnly(true);
            }}
          >
            {positionLabel(positionSize, row.symbol)}, worth {usd(position?.valueUsd ?? 0)} at the
            mark. Closing it is a reduce-only order the other way.
          </Suggest>
        )}

        <div className="c-slot-label">Side</div>
        <Segmented
          label="Order side"
          value={side}
          onChange={setSide}
          options={[
            { value: 'buy', label: 'Buy — long' },
            { value: 'sell', label: 'Sell — short' },
          ]}
        />

        <div className="c-slot-label" style={{ marginTop: 14 }}>
          Size in dollars
        </div>
        <div className="c-field">
          <input
            className="c-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            aria-label={`Notional size in dollars of the ${row.symbol} order`}
          />
          <span className="mono">USD</span>
        </div>
        <div className="c-field-foot">
          <span>
            ≈ {size.toLocaleString('en-US', { maximumFractionDigits: 4 })} {row.symbol} at{' '}
            {usd(priceUsd)}, holding {usd(marginRequiredUsd(sizeUsd, accountLev))} of margin at{' '}
            {accountLev}×
          </span>
        </div>

        <div className="c-slot-label" style={{ marginTop: 14 }}>
          Price
        </div>
        <div className="c-controls">
          <Segmented
            label="Order type"
            value={isLimit ? 'limit' : 'market'}
            onChange={(v) => setIsLimit(v === 'limit')}
            options={[
              { value: 'market', label: 'Market' },
              { value: 'limit', label: 'Limit' },
            ]}
          />
          {isLimit && (
            <input
              className="c-input"
              inputMode="decimal"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder={row.markUsd.toFixed(2)}
              aria-label="Limit price in dollars"
            />
          )}
          <label className="c-ctl-label">
            <input
              type="checkbox"
              checked={reduceOnly}
              onChange={(e) => setReduceOnly(e.target.checked)}
            />{' '}
            Reduce only
          </label>
        </div>

        <label className={`c-ack${severe ? ' severe' : ''}`}>
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>
            <strong>A perp position can be liquidated.</strong>{' '}
            {leverage === null || liqDrop === null ? (
              <>
                The margin backing it is the whole loss, not a few basis points of it. A swap that
                goes wrong costs the spread; this costs the account.
              </>
            ) : (
              <>
                {usd(sizeUsd)} against {usd(marginUsd)} of margin is{' '}
                <strong className="mono">{leverage.toFixed(2)}×</strong>. Roughly a{' '}
                <strong className="mono">{liqDrop.toFixed(1)}%</strong> move against you closes the
                position and takes that margin with it — before fees and funding, which move the
                line closer.
              </>
            )}
          </span>
        </label>

        <Reveal summary="What kind of price is the mark, and who sets the rules?">
          <p>
            <strong>The mark is an oracle, not a pool.</strong> Everywhere else in this app a price
            is read from pool state and anyone can re-read the same contracts to check it. The mark
            above is published by the deployer of the HIP-3 dex this market lives on — the same
            party that sets its {row.maxLeverage}× ceiling, its margin requirements and its funding.
            Your fill, your liquidation price and your funding payments all follow their number.
          </p>
          <p>
            <strong>Collateral lives on the venue.</strong> The margin figure above is
            Hyperliquid&rsquo;s ledger entry for this address on the{' '}
            <Chip tone={row.dex ? 'accent' : 'mut'}>{dexName(row.dex)}</Chip> dex. It is not a chain
            balance and it is not the USDC in your wallet; funding it is a bridge deposit you sign,
            and nothing on this page moves money into it for you.
          </p>
          <p>
            A market order is an immediate-or-cancel limit priced through the book, because
            Hyperliquid has no market order type. Nothing is signed until you confirm the summary
            below.
          </p>
        </Reveal>
      </Card>

      {prepared && (
        <Card title="Review" step={3} tone="warn">
          <ul className="c-list">
            <li>
              <span>Market</span>
              <span className="mono">{prepared.summary.market}</span>
            </li>
            <li>
              <span>Side</span>
              <span className="mono">
                {prepared.summary.side === 'buy' ? 'buy — long' : 'sell — short'}
              </span>
            </li>
            <li>
              <span>Size</span>
              <span className="mono">
                {prepared.summary.size} {prepared.summary.market.split(':')[1]}
              </span>
            </li>
            <li>
              <span>Price</span>
              <span className="mono">
                {usd(prepared.summary.priceUsd)} · mark {usd(prepared.summary.markUsd)}
              </span>
            </li>
            <li>
              <span>Notional</span>
              <span className="mono">{usd(prepared.summary.notionalUsd)}</span>
            </li>
            <li>
              <span>Order type</span>
              <span className="mono">{prepared.summary.orderType}</span>
            </li>
            <li>
              <span>Maximum leverage</span>
              <span className="mono">{prepared.summary.maxLeverage}×</span>
            </li>
          </ul>
          <div className="c-guarantee">
            <span>
              Nothing has been signed. Confirming signs this order with your wallet and sends it to
              Hyperliquid, where it can fill immediately. It was priced when you asked for it — if
              it has been sitting, review it again rather than signing a stale mark.
            </span>
            <button className="c-ghost" type="button" onClick={() => setPrepared(null)}>
              Back
            </button>
          </div>
        </Card>
      )}

      <button
        className="c-go"
        type="button"
        onClick={prepared ? onConfirm : onReview}
        disabled={busy || !readMargin || (!prepared && blocked !== null)}
      >
        {buttonLabel()}
      </button>

      {error && <ErrorNote>{error}</ErrorNote>}

      {response !== null && (
        <div className="c-tx ok">
          <span>✓ Sent to Hyperliquid</span>
          <span className="mono">{JSON.stringify(response)}</span>
        </div>
      )}
    </>
  );
}

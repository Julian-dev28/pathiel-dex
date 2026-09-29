'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CHAINS, type ChainKey } from '@/lib/chain';
import { planSummary } from '@/lib/account/plan';
import type { BuyProgress } from '@/lib/account/autoroute';
import { TradeError, type SentStep } from '@/lib/account/trade';
import {
  executeSwap,
  planSwap,
  swapAssets,
  unifiedBalance,
  type SellLeg,
  type SwapPlan,
} from '@/lib/account/swap';
import { TokenSelect } from './TokenSelect';
import { useTradingAccount } from './AccountProvider';
import { Card, Chip, Empty, ErrorNote, Loading, Segmented } from './ui';

const SLIPPAGE_CHOICES = [10, 30, 50, 100];
/** A plan older than this is re-priced before it can be sent. */
const PLAN_TTL_MS = 30_000;

const ASSETS = swapAssets();
const ASSET = new Map(ASSETS.map((a) => [a.key, a]));
const DISPLAY_TOKENS = ASSETS.map((a) => a.display);

const fmt = (n: number, digits = 6) => n.toLocaleString('en-US', { maximumFractionDigits: digits });

const legLabel = (l: SellLeg) =>
  l.kind === 'local'
    ? `${CHAINS[l.chain].name} → ${l.venue.label}`
    : `${CHAINS[l.chain].name} → Relay → ${CHAINS[l.dest].name}`;

/**
 * The trade ticket, on the one trading account.
 *
 * The account is one balance per asset across every chain, so the ticket
 * never names a chain as a choice: it asks what to sell and what to buy, and
 * the router works out where each part of the account trades and what has to
 * move. The route it picked is shown — chain, then venue — and can be
 * overridden where there is a real alternative.
 */
export function Terminal() {
  const { account } = useTradingAccount();
  const [inKey, setInKey] = useState('USD');
  const [outKey, setOutKey] = useState('NVDA');
  const [amount, setAmount] = useState('100');
  const [slippageBps, setSlippageBps] = useState(50);

  const [balance, setBalance] = useState<number | null>(null);
  const [plan, setPlan] = useState<SwapPlan | null>(null);
  const [pricedAt, setPricedAt] = useState(0);
  const [pricing, setPricing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [routeIndex, setRouteIndex] = useState(0);
  const [venueFor, setVenueFor] = useState<Partial<Record<ChainKey, string>>>({});
  const [progress, setProgress] = useState<BuyProgress | null>(null);
  const [done, setDone] = useState<SentStep[] | null>(null);

  const assetIn = ASSET.get(inKey)!;
  const assetOut = ASSET.get(outKey)!;
  const units = Number(amount);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  // One number for the whole account, however many chains it sits on.
  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    setBalance(null);
    unifiedBalance(account.address, assetIn)
      .then((b) => !cancelled && setBalance(b))
      .catch(() => !cancelled && setBalance(null));
    return () => {
      cancelled = true;
    };
  }, [account, assetIn, done]);

  const run = useRef(0);
  const price = useCallback(async () => {
    if (!account || !(units > 0) || inKey === outKey) return;
    const token = ++run.current;
    setPricing(true);
    setError(null);
    try {
      const next = await planSwap(account.address, assetIn, assetOut, units);
      if (token !== run.current) return;
      setPlan(next);
      setPricedAt(Date.now());
    } catch (e) {
      if (token !== run.current) return;
      setPlan(null);
      setError(e instanceof Error ? e.message : 'could not price this');
    } finally {
      if (token === run.current) setPricing(false);
    }
  }, [account, assetIn, assetOut, inKey, outKey, units]);

  // Re-priced when the ask changes, never carried over: a plan for a
  // different pair or size is not a plan for this one.
  useEffect(() => {
    setPlan(null);
    setRouteIndex(0);
    setVenueFor({});
    setError(null);
    const t = setTimeout(() => void price(), 600);
    return () => clearTimeout(t);
  }, [price]);

  const stale = !!plan && now - pricedAt > PLAN_TTL_MS;
  const buyRoute = plan?.kind === 'buy' ? (plan.routes[routeIndex] ?? plan.routes[0]) : null;
  const receive = plan ? (plan.kind === 'buy' ? (buyRoute?.unitsOut ?? 0) : plan.out) : null;
  const insufficient = balance !== null && units > balance;

  const onTrade = async () => {
    if (!account || !plan) return;
    if (stale) return void price();
    setError(null);
    setDone(null);
    setProgress({ stage: 'swapping', detail: 'starting' });
    try {
      setDone(await executeSwap(account, plan, slippageBps, { routeIndex, venueFor }, setProgress));
      setPlan(null);
    } catch (e) {
      const landed = e instanceof TradeError ? e.sent : [];
      setError(
        (e instanceof Error ? e.message : 'the trade failed') +
          (landed.length > 0
            ? ` — ${landed.map((s) => s.description).join(', ')} already went through.`
            : ''),
      );
    } finally {
      setProgress(null);
    }
  };

  const buttonLabel = () => {
    if (progress) {
      return progress.stage === 'gas'
        ? 'Buying gas…'
        : progress.stage === 'waiting'
          ? 'Waiting for it to arrive…'
          : progress.stage === 'bridging'
            ? 'Moving it across…'
            : 'Trading…';
    }
    if (insufficient) return `Not enough ${inKey} in your account`;
    if (pricing && !plan) return 'Finding the best route…';
    if (!plan) return 'Enter an amount';
    if (stale) return 'Price expired — refresh';
    return `Trade ${fmt(units)} ${inKey} for ${fmt(receive ?? 0)} ${outKey}`;
  };

  const flip = () => {
    setInKey(outKey);
    setOutKey(inKey);
  };

  const buyChains = useMemo(() => (plan?.kind === 'buy' ? plan.routes : []), [plan]);

  if (!account) {
    return (
      <Card title="Trade">
        <Empty>
          <Link href="/account">Sign in to your trading account</Link> to trade. Everything here
          trades from that one account, across every chain it holds money on.
        </Empty>
      </Card>
    );
  }

  return (
    <Card
      title="Swap"
      meta={
        plan && !stale ? (
          <Chip tone="mut">priced {Math.round((now - pricedAt) / 1000)}s ago</Chip>
        ) : undefined
      }
    >
      <div className="c-slot-label">You pay</div>
      <div className="c-field">
        <input
          className="c-amount"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.0"
          aria-label={`Amount of ${inKey} to sell`}
        />
        <TokenSelect value={inKey} onChange={setInKey} tokens={DISPLAY_TOKENS} exclude={outKey} />
      </div>
      <div className="c-field-foot">
        <span>
          {balance === null ? 'Reading your account…' : `${fmt(balance)} ${inKey} in your account`}
        </span>
        {balance !== null && balance > 0 && (
          <button className="c-ghost" type="button" onClick={() => setAmount(String(balance))}>
            Use max
          </button>
        )}
      </div>

      <div className="c-flip-row">
        <button className="c-flip" type="button" aria-label="Flip pay and receive" onClick={flip}>
          ⇅
        </button>
      </div>

      <div className="c-slot-label">You receive</div>
      <div className="c-field">
        <output
          className={`c-amount${receive ? '' : ' c-t-mut'}`}
          aria-label={`${outKey} received`}
        >
          {receive ? fmt(receive) : '0.0'}
        </output>
        <TokenSelect value={outKey} onChange={setOutKey} tokens={DISPLAY_TOKENS} exclude={inKey} />
      </div>

      {!plan ? (
        <div style={{ marginTop: 12 }}>
          {pricing ? (
            <Loading rows={2} />
          ) : error ? (
            <ErrorNote onRetry={() => void price()}>{error}</ErrorNote>
          ) : null}
        </div>
      ) : plan.kind === 'buy' && buyRoute ? (
        <>
          <label className="c-route-pick">
            <span>Route</span>
            <select
              className="c-route-select"
              value={routeIndex}
              onChange={(e) => setRouteIndex(Number(e.target.value))}
            >
              {buyChains.map((r, i) => (
                <option key={r.chain} value={i}>
                  {CHAINS[r.chain].name} → {r.venue.label} — {r.unitsOut.toPrecision(6)} {outKey}
                  {i === 0 ? ' (best)' : ''}
                </option>
              ))}
            </select>
          </label>
          <div className="c-field-foot">
            <span>
              {planSummary(buyRoute.plan)}
              {buyRoute.gasBuy
                ? ` · buys $${buyRoute.gasCostUsd.toFixed(2)} of ${CHAINS[buyRoute.chain].viem.nativeCurrency.symbol} for gas first`
                : ''}
            </span>
          </div>
        </>
      ) : plan.kind === 'sell' ? (
        <>
          <div className="c-slot-label" style={{ marginTop: 12 }}>
            Route
          </div>
          <ul className="c-list">
            {plan.legs.map((l) => (
              <li key={`${l.chain}:${l.dest}`}>
                <span>
                  {fmt(Number(l.amountIn) / 10 ** l.tokenIn.decimals)} {inKey} · {legLabel(l)}
                  {l.kind === 'local' && l.quote.venues.length > 1 && (
                    <select
                      className="c-route-select"
                      style={{ marginLeft: 8, flex: 'none', width: 'auto' }}
                      value={venueFor[l.chain] ?? l.venue.id}
                      onChange={(e) => setVenueFor({ ...venueFor, [l.chain]: e.target.value })}
                      aria-label={`Venue on ${CHAINS[l.chain].name}`}
                    >
                      {[...l.quote.venues]
                        .sort((a, b) => (a.amountOutAtFull > b.amountOutAtFull ? -1 : 1))
                        .map((v) => (
                          <option key={v.venue.id} value={v.venue.id}>
                            {v.venue.label}
                            {v.venue.id === l.venue.id ? ' (best)' : ''}
                          </option>
                        ))}
                    </select>
                  )}
                </span>
                <span className="mono">
                  {fmt(l.out)} {l.tokenOut.symbol}
                </span>
              </li>
            ))}
            {plan.gas.map((g) => (
              <li key={`gas:${g.chain}`}>
                <span>
                  Gas for {CHAINS[g.chain].name}, bought from {CHAINS[g.payer].name}
                </span>
                <span className="mono">${g.usd.toFixed(2)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <div className="c-slot-label" style={{ marginTop: 16 }}>
        Maximum slippage
      </div>
      <Segmented
        label="Maximum slippage"
        value={slippageBps}
        onChange={setSlippageBps}
        options={SLIPPAGE_CHOICES.map((s) => ({ value: s, label: `${(s / 100).toFixed(2)}%` }))}
      />

      <button
        className="c-go"
        type="button"
        onClick={() => void onTrade()}
        disabled={progress !== null || insufficient || (!plan && !stale) || pricing}
        style={{ marginTop: 16 }}
      >
        {buttonLabel()}
      </button>

      {progress && (
        <p className="c-empty" style={{ marginTop: 10 }}>
          {progress.detail}
        </p>
      )}
      {plan && error && <ErrorNote>{error}</ErrorNote>}

      {done && (
        <ul className="c-list" style={{ marginTop: 12 }}>
          {done.map((s) => (
            <li key={s.hash}>
              <span>✓ {s.description}</span>
              <span className="mono">{s.hash.slice(0, 10)}…</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

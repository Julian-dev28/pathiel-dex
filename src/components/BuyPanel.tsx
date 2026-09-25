'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTradingAccount } from './AccountProvider';
import { CHAINS } from '@/lib/chain';
import { unifiedAssets } from '@/lib/assets';
import {
  buy,
  dollarBalances,
  routesFor,
  type BuyProgress,
  type DollarBalance,
  type Route,
} from '@/lib/account/autoroute';
import { planSummary, totalDollars, usdOf } from '@/lib/account/plan';
import { TradeError, type SentStep } from '@/lib/account/trade';
import { Card, Chip, Empty, ErrorNote, Reveal, Answer, Answers } from './ui';

/**
 * Buy an asset. One balance, one form, no chain.
 *
 * The account is one number here, because that is what it is: dollars on three
 * chains are one balance the router spends out of. A trade may draw on two of
 * them and buy gas on a third, and none of that is a question for the customer
 * — it is arithmetic, and it is what the panel shows *after* pricing rather
 * than asks before it.
 *
 * Deciding on someone's behalf is only honest if they can see what was decided
 * and what it cost, which is why the plan, the crossings, the gas and the
 * margin over the next-best chain are all on screen before anything is signed.
 */

/** Assets worth offering: listed somewhere, and not a dollar. */
const buyableAssets = () =>
  unifiedAssets()
    .filter((a) => !a.listings.every((l) => l.token.symbol === CHAINS[l.chain].usd.symbol))
    .filter((a) => !/^USD/.test(a.symbol) && a.symbol !== 'DAI');

export function BuyPanel() {
  const { account } = useTradingAccount();
  const [held, setHeld] = useState<DollarBalance[] | null>(null);
  const [asset, setAsset] = useState('NVDA');
  const [amount, setAmount] = useState('100');
  const [routes, setRoutes] = useState<Route[] | null>(null);
  const [pricing, setPricing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<BuyProgress | null>(null);
  const [done, setDone] = useState<SentStep[] | null>(null);

  const usd = Number(amount);
  const ready = account && Number.isFinite(usd) && usd > 0;
  const balance = held ? totalDollars(held) : null;

  // The account as one number, read once and again after a trade lands. Three
  // balances on three chains is the implementation, not the account.
  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    dollarBalances(account.address)
      .then((b) => !cancelled && setHeld(b))
      .catch(() => !cancelled && setHeld(null));
    return () => {
      cancelled = true;
    };
  }, [account, done]);

  const price = useCallback(async () => {
    if (!account || !Number.isFinite(usd) || usd <= 0) return;
    setPricing(true);
    setError(null);
    setDone(null);
    try {
      setRoutes(await routesFor(account.address, asset, usd));
    } catch (e) {
      setRoutes(null);
      setError(e instanceof Error ? e.message : 'could not price this');
    } finally {
      setPricing(false);
    }
  }, [account, asset, usd]);

  // Re-priced when the ask changes, never carried over: a route priced for a
  // different asset or amount is not a route for this one.
  useEffect(() => {
    setRoutes(null);
    setError(null);
  }, [asset, amount]);

  const best = routes?.[0];
  const runnerUp = routes?.[1];
  // In price terms rather than units, because the two routes may not be
  // spending the same dollars: one of them might be buying gas as well.
  const edgeBps =
    best && runnerUp && runnerUp.allInPriceUsd > 0
      ? ((runnerUp.allInPriceUsd - best.allInPriceUsd) / runnerUp.allInPriceUsd) * 10_000
      : 0;

  const onBuy = async () => {
    if (!account || !best) return;
    setError(null);
    setProgress({ stage: 'bridging', detail: 'starting' });
    try {
      setDone(await buy(account, best, 50, setProgress));
      setRoutes(null);
    } catch (e) {
      const landed = e instanceof TradeError ? e.sent : [];
      setError(
        (e instanceof Error ? e.message : 'the purchase failed') +
          (landed.length > 0 ? ` — ${landed.map((s) => s.description).join(', ')} already went through.` : ''),
      );
    } finally {
      setProgress(null);
    }
  };

  if (!account) {
    return (
      <Card title="Buy" step={1}>
        <Empty>
          Sign in on the <a href="/account">account page</a> first. Everything here is bought with
          the dollars held in your trading account.
        </Empty>
      </Card>
    );
  }

  return (
    <>
      <Card
        title="Buy"
        step={1}
        meta={
          balance === null ? undefined : (
            <Chip tone={balance > 0n ? 'good' : 'mut'}>${usdOf(balance).toFixed(2)} available</Chip>
          )
        }
      >
        <div className="c-slot-label">Asset</div>
        <div className="c-field">
          <select
            className="c-wallet"
            value={asset}
            onChange={(e) => setAsset(e.target.value)}
            aria-label="Asset to buy"
            style={{ width: '100%' }}
          >
            {buyableAssets().map((a) => (
              <option key={a.symbol} value={a.symbol}>
                {a.symbol} · on {a.listings.length} chain{a.listings.length === 1 ? '' : 's'}
              </option>
            ))}
          </select>
        </div>

        <div className="c-slot-label" style={{ marginTop: 14 }}>
          Amount in dollars
        </div>
        <div className="c-field">
          <input
            className="c-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="100"
            aria-label="Dollars to spend"
          />
        </div>

        <button
          className="c-go"
          type="button"
          onClick={() => void price()}
          disabled={!ready || pricing || progress !== null}
          style={{ marginTop: 16 }}
        >
          {pricing ? 'Finding the best chain…' : `Price ${asset}`}
        </button>

        {error && <ErrorNote>{error}</ErrorNote>}
      </Card>

      {best && (
        <Card
          title="Where this will happen"
          step={2}
          tone="good"
          meta={<Chip tone="good">chosen for you</Chip>}
        >
          <Answers>
            <Answer
              label={`${asset} you receive`}
              value={best.unitsOut.toPrecision(6)}
              size="xl"
              tone="good"
              note={`$${best.allInPriceUsd.toFixed(2)} each, counting the crossings and the gas`}
            />
            <Answer label="Chain" value={CHAINS[best.chain].name} note={best.venue.label} />
            <Answer
              label="Getting the money there"
              value={
                best.plan.legs.length === 0
                  ? 'nothing to move'
                  : `${best.plan.legs.length} crossing${best.plan.legs.length === 1 ? '' : 's'}`
              }
              note={
                best.crossings.length === 0
                  ? 'these dollars are already on that chain'
                  : `${best.crossings
                      .map((c) => (c.costBps === null ? '?' : `${c.costBps.toFixed(0)}bp`))
                      .join(' + ')}, ~${best.etaSeconds}s`
              }
            />
          </Answers>

          <p style={{ marginTop: 12 }}>{planSummary(best.plan)}.</p>

          {best.gasBuy && (
            <p className="c-empty">
              This account has never traded on {CHAINS[best.chain].name} and holds no{' '}
              {CHAINS[best.chain].viem.nativeCurrency.symbol} to pay for a transaction there, so
              ${best.gasCostUsd.toFixed(2)} of it is bought first. That stays in the account and pays
              for later trades on that chain too.
            </p>
          )}

          {runnerUp && (
            <p style={{ marginTop: 12 }}>
              {edgeBps >= 1
                ? `${edgeBps.toFixed(0)}bp better than ${CHAINS[runnerUp.chain].name}, after everything it costs to get there.`
                : `Within a basis point of ${CHAINS[runnerUp.chain].name}; either would do.`}
            </p>
          )}

          <button
            className="c-go"
            type="button"
            onClick={() => void onBuy()}
            disabled={progress !== null}
            style={{ marginTop: 14 }}
          >
            {progress
              ? progress.stage === 'gas'
                ? 'Buying gas…'
                : progress.stage === 'waiting'
                  ? 'Waiting for it to arrive…'
                  : progress.stage === 'bridging'
                    ? 'Moving your dollars…'
                    : 'Buying…'
              : `Buy ${best.unitsOut.toPrecision(6)} ${asset}`}
          </button>

          {progress && <p className="c-empty" style={{ marginTop: 10 }}>{progress.detail}</p>}

          <Reveal summary="Every chain, and what each would return">
            <div className="c-scroll">
              <table className="c-table">
                <thead>
                  <tr>
                    <th>Chain</th>
                    <th className="num">{asset}</th>
                    <th className="num">All-in price</th>
                    <th className="num">Crossings</th>
                    <th className="num">Gas bought</th>
                  </tr>
                </thead>
                <tbody>
                  {routes?.map((r) => (
                    <tr key={r.chain}>
                      <td>{CHAINS[r.chain].name}</td>
                      <td className={`num mono ${r === best ? 'up' : ''}`}>
                        {r.unitsOut.toPrecision(6)}
                      </td>
                      <td className="num mono">${r.allInPriceUsd.toFixed(2)}</td>
                      <td className="num mono">
                        {r.crossings.length === 0
                          ? '—'
                          : r.crossings
                              .map((c) => (c.costBps === null ? '?' : `${c.costBps.toFixed(0)}bp`))
                              .join(' + ')}
                      </td>
                      <td className="num mono">
                        {r.gasCostUsd > 0 ? `$${r.gasCostUsd.toFixed(2)}` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              Ranked by how much of the asset arrives per dollar that leaves the account, not by the
              headline price: a crossing takes its cut before the pool sees the money, and a chain
              this account has no gas on costs a few dollars to start using. Gas spent on the
              transactions themselves is not counted.
            </p>
          </Reveal>
        </Card>
      )}

      {done && (
        <Card title="Done" step={3} tone="good">
          <ul className="c-list">
            {done.map((s) => (
              <li key={s.hash}>
                <span>{s.description}</span>
                <span className="mono">{s.hash.slice(0, 10)}…</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTradingAccount } from './AccountProvider';
import { CHAINS } from '@/lib/chain';
import { unifiedAssets } from '@/lib/assets';
import {
  RouteError,
  buy,
  routesFor,
  type BuyProgress,
  type Route,
} from '@/lib/account/autoroute';
import { TradeError, type SentStep } from '@/lib/account/trade';
import { Card, Chip, Empty, ErrorNote, Reveal, Answer, Answers } from './ui';

/**
 * Buy an asset. Nothing here asks which chain.
 *
 * The chain a trade happens on is arithmetic — where the dollars are, what the
 * crossing costs, which pool is deepest — and making the customer answer it
 * was the thing this product set out to remove. So the form takes an asset and
 * an amount, the router picks, and the choice is shown afterwards rather than
 * demanded beforehand.
 *
 * Deciding on someone's behalf is only honest if they can see what was decided
 * and what it cost, which is why the chosen route, the crossing and the margin
 * over the next-best chain are all on screen before anything is signed.
 */

/** Assets worth offering: listed somewhere, and not a dollar. */
const buyableAssets = () =>
  unifiedAssets()
    .filter((a) => !a.listings.every((l) => l.token.symbol === CHAINS[l.chain].usd.symbol))
    .filter((a) => !/^USD/.test(a.symbol) && a.symbol !== 'DAI');

export function BuyPanel() {
  const { account } = useTradingAccount();
  const [asset, setAsset] = useState('NVDA');
  const [amount, setAmount] = useState('100');
  const [routes, setRoutes] = useState<Route[] | null>(null);
  const [pricing, setPricing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<BuyProgress | null>(null);
  const [done, setDone] = useState<SentStep[] | null>(null);

  const usd = Number(amount);
  const ready = account && Number.isFinite(usd) && usd > 0;

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
  const edgeBps =
    best && runnerUp && runnerUp.unitsOut > 0
      ? ((best.unitsOut - runnerUp.unitsOut) / runnerUp.unitsOut) * 10_000
      : 0;

  const onBuy = async () => {
    if (!account || !best) return;
    setError(null);
    setProgress({ stage: 'bridging', detail: 'starting' });
    try {
      setDone(await buy(account, best, usd, 50, setProgress));
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
      <Card title="Buy" step={1}>
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
              note={`$${best.effectivePriceUsd.toFixed(2)} each, all in`}
            />
            <Answer label="Chain" value={CHAINS[best.chain].name} note={best.venue.label} />
            <Answer
              label="Crossing"
              value={
                best.bridge
                  ? `${best.bridge.costBps === null ? '?' : best.bridge.costBps.toFixed(0)}bp`
                  : 'none'
              }
              note={
                best.bridge
                  ? `from ${CHAINS[best.from].name}, ~${best.bridge.etaSeconds}s`
                  : 'your dollars are already there'
              }
            />
          </Answers>

          {runnerUp && (
            <p style={{ marginTop: 12 }}>
              {edgeBps >= 1
                ? `${edgeBps.toFixed(0)}bp better than ${CHAINS[runnerUp.chain].name}, after paying to get there.`
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
              ? progress.stage === 'waiting'
                ? 'Waiting for your dollars to arrive…'
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
                    <th className="num">Crossing</th>
                  </tr>
                </thead>
                <tbody>
                  {routes?.map((r) => (
                    <tr key={r.chain}>
                      <td>{CHAINS[r.chain].name}</td>
                      <td className={`num mono ${r === best ? 'up' : ''}`}>
                        {r.unitsOut.toPrecision(6)}
                      </td>
                      <td className="num mono">${r.effectivePriceUsd.toFixed(2)}</td>
                      <td className="num mono">
                        {r.bridge
                          ? `${r.bridge.costBps === null ? '?' : r.bridge.costBps.toFixed(0)}bp`
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              Ranked by how much of the asset arrives, not by the headline price: a crossing takes
              its cut before the pool sees the money. Gas is not counted on either side.
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

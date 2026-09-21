'use client';

import { useEffect, useState } from 'react';
import { useChain } from './ChainProvider';
import { Card, Answer, Answers, Reveal, Chip, Empty, ErrorNote, Loading } from './ui';

type Edge = {
  from: { symbol: string };
  to: { symbol: string };
  rate: number;
  venue: string;
  hops: number;
  gasFraction: number;
};

type Cycle = {
  path: { symbol: string }[];
  edges: Edge[];
  grossBps: number;
  netBps: number;
  profitable: boolean;
};

type Payload = {
  blockNumber: string;
  notionalUsd: number;
  tokens: string[];
  edgeCount: number;
  pairsAttempted: number;
  buildMs: number;
  cached: boolean;
  cycle: Cycle | null;
  triangles: Cycle[];
};

/**
 * The arbitrage loop finder.
 *
 * A loop is drawn as a loop. A table of legs is technically the same
 * information and reads as homework; an actual cycle — token, arrow, token,
 * arrow, back to the start — is the shape of the thing being described, and the
 * reader gets it without parsing anything.
 *
 * Loaded on demand rather than on mount. Building the rate graph costs twenty
 * real quotes and takes the better part of half a minute, which is a rude thing
 * to start doing to someone who came to the page to read the other tools.
 */
export function CycleRoute() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const { chain } = useChain();

  useEffect(() => {
    if (!started) return;
    let cancelled = false;
    setLoading(true);
    setData(null);
    fetch(`/api/cycles?chain=${chain.key}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((b) => {
        if (cancelled) return;
        if (b.error) setError(b.error);
        else {
          setData(b as Payload);
          setError(null);
        }
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [started, chain.key]);

  const best = data?.triangles?.[0] ?? null;

  return (
    <Card
      title="Arbitrage loops"
      step={6}
      meta={
        data ? (
          data.cycle ? (
            <Chip tone="good">loop open</Chip>
          ) : (
            <Chip tone="mut">market closed</Chip>
          )
        ) : undefined
      }
    >
      {!started ? (
        <>
          <p className="c-empty" style={{ marginBottom: 12 }}>
            Searches every loop of tokens for one that returns more than it started with —
            {chain.weth.symbol} → {chain.usd.symbol} → cbBTC → {chain.weth.symbol} and so on, on{' '}
            {chain.name}. Costs about twenty live quotes.
          </p>
          <button className="c-suggest-btn" type="button" onClick={() => setStarted(true)}>
            Scan the market
          </button>
        </>
      ) : loading && !data ? (
        <Loading rows={3} />
      ) : error ? (
        <ErrorNote onRetry={() => setStarted(true)}>{error}</ErrorNote>
      ) : data ? (
        <>
          <Answers>
            <Answer
              label="Best loop"
              value={best ? bpsLabel(best.netBps) : '—'}
              tone={best?.profitable ? 'good' : 'mut'}
              size="xl"
              note={best?.profitable ? 'profitable after gas' : 'short of profitable, after gas'}
            />
            <Answer
              label="Loops checked"
              value={data.triangles.length}
              note={`${data.edgeCount} of ${data.pairsAttempted} routes live`}
            />
            <Answer
              label="Graph built in"
              value={(data.buildMs / 1000).toFixed(1)}
              unit="s"
              note={data.cached ? 'cached' : `at $${data.notionalUsd} per leg`}
            />
          </Answers>

          {best && (
            <div className="c-cycle">
              {best.path.map((t, i) => (
                <span key={`${t.symbol}-${i}`} className="c-cycle-node-wrap">
                  <span className={`c-cycle-node${i === 0 ? ' start' : ''}`}>{t.symbol}</span>
                  {i < best.edges.length && (
                    <span className="c-cycle-edge">
                      <span className="c-cycle-arrow" aria-hidden="true" />
                      <span className="c-cycle-venue">{best.edges[i].venue}</span>
                    </span>
                  )}
                </span>
              ))}
            </div>
          )}

          {data.triangles.length > 0 && (
            <ul className="c-list" style={{ marginTop: 16 }}>
              {data.triangles.slice(0, 5).map((t, i) => (
                <li key={i}>
                  <span className="mono" style={{ fontSize: 12 }}>
                    {t.path.map((x) => x.symbol).join(' → ')}
                  </span>
                  <span className={`mono ${t.netBps > 0 ? 'up' : 'dn'}`}>{bpsLabel(t.netBps)}</span>
                </li>
              ))}
            </ul>
          )}

          {!data.cycle && (
            <p className="c-empty" style={{ marginTop: 12 }}>
              No loop clears its own gas right now. That is the normal state of a working market.
            </p>
          )}

          <Reveal summary="How does it search?">
            <p>
              A loop is profitable when its exchange rates multiply to more than one. Take
              logarithms and that product becomes a sum; negate it and the profitable case becomes
              a <em>negative cycle</em>, which Bellman-Ford finds in a graph. The transformation is
              the whole trick — a multiplicative search over paths becomes an additive one, and an
              additive one has a textbook algorithm.
            </p>
            <p>
              Gas is folded into each edge rather than subtracted at the end, so a loop that clears
              3 bp across four hops is correctly preferred to nothing at all rather than to a
              two-hop loop clearing the same amount.
            </p>
            <p>
              Expect nothing to be open. These loops are contested by searchers running colocated
              infrastructure and close inside a single block. Finding none is the honest result of
              a correct search, and the near-misses above are the interesting part: they say how
              far the market is from opening.
            </p>
          </Reveal>
        </>
      ) : (
        <Empty>Nothing to show.</Empty>
      )}
    </Card>
  );
}

const bpsLabel = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} bp`;

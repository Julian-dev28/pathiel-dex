'use client';

import { useEffect, useMemo, useState } from 'react';
import { bySymbol } from '@/lib/chain';
import { usePair } from './ChainProvider';
import { fetchQuote, type QuoteResponse } from '@/lib/api';
import { sig, bps } from '@/lib/format';
import { DepthChart } from './DepthChart';
import { TokenSelect } from './TokenSelect';
import { ChainTabs } from './ChainTabs';
import { Card, Answer, Answers, Reveal, Empty, ErrorNote, Loading, PageHead, Segmented } from './ui';

const SIZES = ['0.1', '1', '10', '50'];
const SERIES_CLASS = ['vc-0', 'vc-1', 'vc-2', 'vc-3', 'vc-4'];

/**
 * Depth.
 *
 * One question — what does size cost here — answered by one chart, with the
 * per-venue detail underneath it rather than beside it.
 */
export function DepthView() {
  const { chain, inSym, outSym, setInSym, setOutSym } = usePair();
  const [amount, setAmount] = useState('10');
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const tokenIn = useMemo(() => bySymbol(inSym, chain), [inSym, chain]);
  const tokenOut = useMemo(() => bySymbol(outSym, chain), [outSym, chain]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchQuote(chain.key, inSym, outSym, amount)
      .then((q) => !cancelled && (setQuote(q), setError(null)))
      .catch((e) => !cancelled && (setError(e.message), setQuote(null)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [chain.key, inSym, outSym, amount]);

  /** Price impact at full size against the smallest rung, per venue. */
  const impact = useMemo(() => {
    if (!quote) return [];
    return quote.venues
      .map((v) => {
        const first = v.rungs[0];
        const last = v.rungs[v.rungs.length - 1];
        if (!first || !last || first.amountIn === 0n || last.amountIn === 0n) return null;
        const pxSmall = Number(first.amountOut) / Number(first.amountIn);
        const pxFull = Number(last.amountOut) / Number(last.amountIn);
        if (!Number.isFinite(pxSmall) || pxSmall === 0) return null;
        return {
          venue: v.venue,
          impactBps: ((pxFull - pxSmall) / pxSmall) * 10_000,
          amountOutAtFull: v.amountOutAtFull,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => (a.amountOutAtFull > b.amountOutAtFull ? -1 : 1));
  }, [quote]);

  const best = impact[0];

  return (
    <>
      <PageHead
        title="Depth"
        lede="What size costs, venue by venue. Where two lines cross is where the best venue changes."
      />

      <ChainTabs />

      <Card title="Pair and size">
        <div className="c-controls">
          <TokenSelect value={inSym} onChange={setInSym} tokens={chain.tokens} exclude={outSym} />
          <span className="c-arrow">→</span>
          <TokenSelect value={outSym} onChange={setOutSym} tokens={chain.tokens} exclude={inSym} />
          <Segmented
            label="Size"
            value={amount}
            onChange={setAmount}
            options={SIZES.map((s) => ({ value: s, label: s }))}
          />
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
      </Card>

      {loading && !quote ? (
        <Card title="Quoting every venue">
          <Loading rows={3} />
        </Card>
      ) : quote ? (
        <>
          <Card
            title={`Cost of trading ${amount} ${inSym}`}
            step={1}
            meta={<span className="mono">block {quote.blockNumber.toString()}</span>}
          >
            {best && (
              <Answers>
                <Answer
                  label="Best venue"
                  value={sig(best.amountOutAtFull, tokenOut)}
                  unit={tokenOut.symbol}
                  size="xl"
                  note={best.venue.label}
                />
                <Answer
                  label="Price impact"
                  value={best.impactBps.toFixed(1)}
                  unit="bp"
                  tone={best.impactBps < -100 ? 'bad' : best.impactBps < -30 ? 'warn' : 'good'}
                  note="at this size, on the best venue"
                />
                <Answer
                  label="Venues quoted"
                  value={quote.venues.length}
                  note={`${quote.venues.filter((v) => v.multiHop).length} via an intermediate`}
                />
              </Answers>
            )}

            <div style={{ marginTop: 18 }}>
              <DepthChart venues={quote.venues} tokenIn={tokenIn} tokenOut={tokenOut} />
            </div>

            <div className="c-legend">
              {quote.venues.slice(0, 5).map((v, i) => (
                <span key={v.venue.id}>
                  <span className={`leg-dot ${SERIES_CLASS[i % 5]}`} />
                  {v.venue.label}
                </span>
              ))}
            </div>

            <Reveal summary="How do I read this?">
              <p>
                Horizontal is trade size in {tokenIn.symbol}, log-spaced. Vertical is{' '}
                {tokenOut.symbol} received per {tokenIn.symbol} — so a line sloping down means
                bigger trades get a worse price, which every pool does.
              </p>
              <p>
                The window is clipped to the top of the price range. A drained pool quotes orders
                of magnitude below the real price and would otherwise flatten every venue that
                matters into a single line.
              </p>
            </Reveal>
          </Card>

          <Card title="Every venue at this size" step={2}>
            <div className="c-scroll">
              <table className="c-table">
                <thead>
                  <tr>
                    <th>Venue</th>
                    <th className="num">Receives</th>
                    <th className="num">Impact</th>
                  </tr>
                </thead>
                <tbody>
                  {impact.map((r) => (
                    <tr key={r.venue.id}>
                      <td>{r.venue.label}</td>
                      <td className="num mono">
                        {sig(r.amountOutAtFull, tokenOut)} {tokenOut.symbol}
                      </td>
                      <td className={`num mono ${r.impactBps < -50 ? 'dn' : 'mut'}`}>
                        {bps(r.impactBps)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      ) : (
        <Card title="Depth">
          <Empty>No quote yet.</Empty>
        </Card>
      )}
    </>
  );
}

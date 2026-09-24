'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bySymbol } from '@/lib/chain';
import { usePair } from './ChainProvider';
import { ChainTabs } from './ChainTabs';
import { sig, bps, addr } from '@/lib/format';
import { TokenSelect } from './TokenSelect';
import { CycleRoute } from './CycleRoute';
import {
  Card,
  Answer,
  Answers,
  Reveal,
  Chip,
  Empty,
  ErrorNote,
  Loading,
  PageHead,
  Segmented,
} from './ui';

type Analysis = {
  tokenIn: { symbol: string; decimals: number };
  tokenOut: { symbol: string; decimals: number };
  blockNumber: string;
  quotedOut: string;
  latencyMs: number;
  exposure: {
    slippageBps: number;
    exposure: string;
    atRecommended: { slippageBps: number; exposure: string };
    savedByTightening: string;
  };
  drift: {
    pool: string;
    legs?: number;
    lookbackBlocks?: number;
    observations: number;
    p50: number;
    p95: number;
    max: number;
    inclusionBlocks: number;
  } | null;
  recommendation: {
    recommendedBps: number;
    observations: number;
    confidence: 'high' | 'medium' | 'low';
    reason: string;
    savedVsDefaultBps: number;
  };
  capacity: { maxImpactBps: number; venue: string; size: string; atLeast: boolean }[];
  fragmentation: { percent: number; venuesInSplit: number; venuesQuoted: number };
  arb: {
    buy: { venue: string };
    sell: { venue: string };
    size: string;
    grossBps: number;
    netBps: number;
    profitable: boolean;
  } | null;
};

const SLIPPAGE_CHOICES = [10, 30, 50, 100];

/**
 * Execution tools.
 *
 * Each tool is one card that leads with its answer. The previous version opened
 * every section with a paragraph explaining its own methodology, which meant
 * five paragraphs stood between the reader and five numbers. The methodology is
 * all still here, one click down.
 */
export function ToolsView() {
  const { chain, inSym, outSym, setInSym, setOutSym } = usePair();
  const [amount, setAmount] = useState('1');
  const [slippageBps, setSlippageBps] = useState(50);
  const [data, setData] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tokenIn = useMemo(() => bySymbol(inSym, chain), [inSym, chain]);
  const tokenOut = useMemo(() => bySymbol(outSym, chain), [outSym, chain]);

  const abortRef = useRef<AbortController | null>(null);
  const run = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/analyze?chain=${chain.key}&in=${inSym}&out=${outSym}&amount=${encodeURIComponent(amount)}&slippage=${slippageBps}`,
        { signal: ctrl.signal, cache: 'no-store' },
      );
      const body = await res.json();
      if (ctrl.signal.aborted) return;
      if (body.error) {
        setError(body.error);
        setData(null);
      } else {
        setData(body as Analysis);
        setError(null);
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(String(e));
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, [chain.key, inSym, outSym, amount, slippageBps]);

  useEffect(() => {
    const t = setTimeout(run, 400);
    return () => clearTimeout(t);
  }, [run]);

  const num = (v: string, decimals: number) =>
    (Number(v) / 10 ** decimals).toLocaleString('en-US', { maximumFractionDigits: 4 });

  return (
    <>
      <PageHead
        title="Execution tools"
        lede="Five things a swap screen could tell you, and none of them do."
      />

      <ChainTabs />

      <Card title="Set up a trade">
        <div className="c-controls">
          <input
            className="c-input"
            value={amount}
            inputMode="decimal"
            onChange={(e) => setAmount(e.target.value)}
            aria-label="Amount"
          />
          <TokenSelect value={inSym} onChange={setInSym} tokens={chain.tokens} exclude={outSym} />
          <span className="c-arrow">→</span>
          <TokenSelect value={outSym} onChange={setOutSym} tokens={chain.tokens} exclude={inSym} />
        </div>
        <div className="c-controls" style={{ marginTop: 12 }}>
          <span className="c-ctl-label">Slippage</span>
          <Segmented
            label="Slippage"
            value={slippageBps}
            onChange={setSlippageBps}
            options={SLIPPAGE_CHOICES.map((s) => ({ value: s, label: `${(s / 100).toFixed(2)}%` }))}
          />
        </div>
        {error && <ErrorNote onRetry={run}>{error}</ErrorNote>}
      </Card>

      {loading && !data && (
        <Card title="Measuring">
          <Loading rows={3} />
        </Card>
      )}

      {data && (
        <>
          {/* 1 — the headline */}
          <Card
            title="What your slippage is worth to an attacker"
            step={1}
            tone="warn"
            meta={<span className="mono">block {data.blockNumber}</span>}
          >
            <Answers>
              <Answer
                label={`At ${data.exposure.slippageBps} bp`}
                value={num(data.exposure.exposure, data.tokenOut.decimals)}
                unit={data.tokenOut.symbol}
                tone="bad"
                size="xl"
                note="most a sandwich can take"
              />
              <Answer
                label={`At ${data.exposure.atRecommended.slippageBps} bp`}
                value={num(data.exposure.atRecommended.exposure, data.tokenOut.decimals)}
                unit={data.tokenOut.symbol}
                tone="good"
                note="same trade, tighter floor"
              />
              <Answer
                label="You'd save"
                value={num(data.exposure.savedByTightening, data.tokenOut.decimals)}
                unit={data.tokenOut.symbol}
                note="by tightening alone"
              />
            </Answers>

            <Reveal summary="How is this exact rather than estimated?">
              <p>
                A sandwicher pushes the pool until you receive exactly your minimum, then sells
                back. Their profit is bounded by the gap between what the pool would have paid and
                what you agreed to accept — so the exposure is simply quoted minus floor. It is
                arithmetic on a number you authorised, not a model of anyone&rsquo;s behaviour.
              </p>
            </Reveal>
          </Card>

          {/* 2 — measured slippage */}
          <Card
            title="The slippage this pair actually needs"
            step={2}
            meta={
              <Chip
                tone={
                  data.recommendation.confidence === 'high'
                    ? 'good'
                    : data.recommendation.confidence === 'medium'
                      ? 'warn'
                      : 'mut'
                }
              >
                {data.recommendation.confidence} confidence
              </Chip>
            }
          >
            {data.drift ? (
              <>
                <Answers>
                  <Answer
                    label="Recommended"
                    value={data.recommendation.recommendedBps}
                    unit="bp"
                    size="xl"
                    tone="good"
                    note={
                      data.recommendation.savedVsDefaultBps > 0
                        ? `${data.recommendation.savedVsDefaultBps} bp tighter than the 50 bp wallets ship`
                        : 'the safe default stands'
                    }
                  />
                  <Answer
                    label="Price moved (p95)"
                    value={data.drift.p95.toFixed(2)}
                    unit="bp"
                    note={`over ${data.drift.inclusionBlocks}-block windows`}
                  />
                  <Answer
                    label="Evidence"
                    value={data.drift.observations}
                    note={`windows over ${data.drift.lookbackBlocks} blocks${data.drift.legs === 2 ? ', both legs' : ''}`}
                  />
                </Answers>

                <Reveal summary="Where does this number come from?">
                  <p>{data.recommendation.reason}.</p>
                  <p>
                    Measured from{' '}
                    <a href={`${chain.explorer}/address/${data.drift.pool}`} target="_blank" rel="noreferrer" className="mono">
                      {addr(data.drift.pool)}
                    </a>
                    . Uniswap V3 Swap events carry the pool price, so a single log query
                    reconstructs the whole series — no archive node, no per-block calls, no price
                    feed.
                  </p>
                  <p>
                    Below fifty observations the recommendation refuses to tighten below the
                    default at all. A tool that exists to reduce risk must not increase it on the
                    pairs it understands least.
                  </p>
                </Reveal>
              </>
            ) : (
              <Empty>
                Not enough recent trades to measure this pair, so the conservative 50 bp default
                stands.
              </Empty>
            )}
          </Card>

          <div className="c-two">
            {/* 3 — capacity */}
            <Card title="How much it can absorb" step={3}>
              <Answer
                label={`≤ ${data.capacity[0]?.maxImpactBps} bp impact`}
                value={
                  <>
                    {data.capacity[0]?.atLeast && <span className="c-t-mut">≥ </span>}
                    {sig(BigInt(data.capacity[0]?.size ?? '0'), tokenIn, 5)}
                  </>
                }
                unit={data.tokenIn.symbol}
                note={data.capacity[0]?.venue}
              />
              <ul className="c-list" style={{ marginTop: 14 }}>
                {data.capacity.slice(1).map((c) => (
                  <li key={c.maxImpactBps}>
                    <span>≤ {c.maxImpactBps} bp</span>
                    <span className="mono">
                      {c.atLeast && '≥ '}
                      {sig(BigInt(c.size), tokenIn, 5)} {data.tokenIn.symbol}
                    </span>
                  </li>
                ))}
              </ul>
              <Reveal summary="Why does this matter?">
                <p>
                  It is the first question a desk asks and no interface answers it. A “≥” means the
                  whole quoted range stayed within budget, so the true figure is higher.
                </p>
              </Reveal>
            </Card>

            {/* 4 — fragmentation */}
            <Card title="Does routing even matter here?" step={4}>
              <Answer
                label="Off the best venue"
                value={data.fragmentation.percent.toFixed(1)}
                unit="%"
                tone={data.fragmentation.percent > 5 ? 'good' : 'mut'}
                note={
                  data.fragmentation.percent < 1
                    ? 'one pool is effectively the whole market'
                    : `spread across ${data.fragmentation.venuesInSplit} of ${data.fragmentation.venuesQuoted} venues`
                }
              />
              <Reveal summary="Why publish an unflattering number?">
                <p>
                  Zero means a router earns nothing on this pair. Saying so is the point — a tool
                  that only ever reports its own usefulness is not measuring anything.
                </p>
              </Reveal>
            </Card>
          </div>

          {/* 5 — two-venue round trip */}
          <Card
            title="Two-venue round trip"
            step={5}
            meta={
              data.arb?.profitable ? <Chip tone="good">open</Chip> : <Chip tone="mut">none</Chip>
            }
          >
            {data.arb ? (
              <Answers>
                <Answer
                  label="Best round trip"
                  value={bps(data.arb.netBps)}
                  tone={data.arb.netBps > 0 ? 'good' : 'mut'}
                  note={`${data.arb.buy.venue} → ${data.arb.sell.venue}, net of gas`}
                />
                <Answer
                  label="At size"
                  value={sig(BigInt(data.arb.size), tokenIn, 4)}
                  unit={data.tokenIn.symbol}
                  note={`${bps(data.arb.grossBps)} before gas`}
                />
              </Answers>
            ) : (
              <Empty>No profitable round trip at any size on this pair.</Empty>
            )}
            <Reveal summary="Why is the size not simply as large as possible?">
              <p>
                Both legs move against you as size grows, so profit is concave — it rises, peaks,
                and falls back through zero. Taking the maximum is how a naive searcher turns a
                real edge into a loss.
              </p>
              <p>
                Expect this to read <em>none</em> almost always. These are contested by searchers
                with far better latency and close within a block.
              </p>
            </Reveal>
          </Card>
        </>
      )}

      {/* 6 — the arbitrage loop finder, independent of the pair above */}
      <CycleRoute />
    </>
  );
}

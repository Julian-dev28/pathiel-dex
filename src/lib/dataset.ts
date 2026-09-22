/**
 * Reading the backtest dataset.
 *
 * `data/backtest.jsonl` is an append-only log of runs, committed to the
 * repository. That is the entire storage layer, and it is a deliberate choice
 * rather than a shortcut:
 *
 *   - It costs nothing and needs no credential, which is the constraint the
 *     whole project runs under.
 *   - Every number the site publishes is in a diff. A claim that changes is a
 *     commit someone can read, which is a stronger guarantee than a database
 *     nobody outside the deployment can query.
 *   - Append-only means a bad run is a line to remove, not a migration.
 *
 * What it is not: queryable at scale, or writable from a request. Both are fine
 * here — the writer is a scheduled job and the reader wants the whole file.
 * A dataset that outgrows this wants a real database, and the shape of the
 * reader below is deliberately the shape a database call would have.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChainKey } from './chain';

export type BacktestSample = {
  txHash: string;
  blockNumber: string;
  pair: string;
  amountIn: string;
  actualOut: string;
  routerOut: string;
  edgeBps: number;
  routerVenue: string;
  routerHops: number;
  differentVenue: boolean;
};

export type BacktestRun = {
  runAt: string;
  /** Absent on runs recorded before Robinhood Chain, which were all Base. */
  chain?: ChainKey;
  fromBlock: string;
  toBlock: string;
  observed: number;
  sampled: number;
  skipped: number;
  summary: {
    samples: number;
    medianEdgeBps: number;
    winRate: number;
    wins: number;
    losses: number;
    ties: number;
    medianWinBps: number;
    medianLossBps: number;
    p25EdgeBps: number;
    p75EdgeBps: number;
    multiHopUsed: number;
  };
  results: BacktestSample[];
};

const DATA_PATH = join(process.cwd(), 'data', 'backtest.jsonl');

/**
 * Cached for the lifetime of the process: the file only changes on redeploy,
 * so re-reading it per request is pure waste.
 */
let cache: { runs: BacktestRun[]; readAt: number } | null = null;

export function loadRuns(): BacktestRun[] {
  if (cache) return cache.runs;
  if (!existsSync(DATA_PATH)) {
    cache = { runs: [], readAt: Date.now() };
    return [];
  }

  const runs: BacktestRun[] = [];
  for (const line of readFileSync(DATA_PATH, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      runs.push(JSON.parse(trimmed) as BacktestRun);
    } catch {
      // A truncated final line is what a killed writer leaves behind. Skip it
      // rather than failing the page: the rest of the file is still good.
    }
  }
  runs.sort((a, b) => a.runAt.localeCompare(b.runAt));
  cache = { runs, readAt: Date.now() };
  return runs;
}

const runsOn = (chain: ChainKey): BacktestRun[] => loadRuns().filter((r) => (r.chain ?? 'base') === chain);

export const allSamples = (chain: ChainKey): BacktestSample[] => runsOn(chain).flatMap((r) => r.results);

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const percentile = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
};

/** Everything the backtest page needs, computed once from one chain's runs. */
export function aggregate(chain: ChainKey) {
  const runs = runsOn(chain);
  const samples = allSamples(chain);
  const edges = samples.map((s) => s.edgeBps);
  const wins = samples.filter((s) => s.edgeBps > 0);
  const losses = samples.filter((s) => s.edgeBps < 0);

  const byPair = new Map<string, number[]>();
  for (const s of samples) {
    const list = byPair.get(s.pair) ?? [];
    list.push(s.edgeBps);
    byPair.set(s.pair, list);
  }

  const byVenue = new Map<string, number>();
  for (const s of samples) byVenue.set(s.routerVenue, (byVenue.get(s.routerVenue) ?? 0) + 1);

  return {
    runs: runs.length,
    firstRunAt: runs[0]?.runAt ?? null,
    lastRunAt: runs[runs.length - 1]?.runAt ?? null,
    observedTotal: runs.reduce((a, r) => a + r.observed, 0),
    samples: samples.length,
    medianEdgeBps: median(edges),
    winRate: samples.length ? wins.length / samples.length : 0,
    wins: wins.length,
    losses: losses.length,
    ties: samples.length - wins.length - losses.length,
    medianWinBps: median(wins.map((s) => s.edgeBps)),
    medianLossBps: median(losses.map((s) => s.edgeBps)),
    p10EdgeBps: percentile(edges, 10),
    p25EdgeBps: percentile(edges, 25),
    p75EdgeBps: percentile(edges, 75),
    p90EdgeBps: percentile(edges, 90),
    multiHopUsed: samples.filter((s) => s.routerHops > 1).length,
    byPair: [...byPair.entries()]
      .map(([pair, xs]) => ({
        pair,
        samples: xs.length,
        medianEdgeBps: median(xs),
        winRate: xs.filter((x) => x > 0).length / xs.length,
      }))
      .sort((a, b) => b.samples - a.samples),
    byVenue: [...byVenue.entries()]
      .map(([venue, count]) => ({ venue, count }))
      .sort((a, b) => b.count - a.count),
    /** Every sample's edge, for the histogram. The distribution is the point:
     *  a median hides whether the wins are a broad shift or a few outliers. */
    edges,
    /** Newest first, for the sample table. */
    recent: [...samples].reverse().slice(0, 60),
    /** Per-run medians, for the trend line. */
    trend: runs.map((r) => ({
      runAt: r.runAt,
      medianEdgeBps: r.summary.medianEdgeBps,
      samples: r.summary.samples,
      winRate: r.summary.winRate,
    })),
  };
}

export type Aggregate = ReturnType<typeof aggregate>;

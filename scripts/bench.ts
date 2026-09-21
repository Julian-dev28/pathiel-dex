/**
 * Measures whether splitting is actually worth it, and writes the answer down.
 *
 * The interesting question about a split router is not "does it split" — every
 * aggregator splits — but "at what size does splitting start to pay, and how
 * much of the gain survives gas". This sweeps a set of pairs across a ladder of
 * notional sizes, records the split's edge over the best single venue both
 * gross and net of the extra hop, and prints a table.
 *
 * Every figure the README quotes comes from here. Run it yourself:
 *
 *   npm run bench
 *
 * The numbers will differ from the ones committed — they are a snapshot of a
 * live market at a block, not a constant — but the shape should hold.
 */

import { writeFileSync } from 'node:fs';
import { CHAINS, bySymbol as lookup } from '../src/lib/chain';
import { client, quoteLadder, ladder, bestRoute } from '../src/lib/quote';
import { hopCostInToken } from '../src/lib/gas';

const PAIRS: [string, string, number[]][] = [
  ['WETH', 'USDC', [0.1, 1, 5, 25, 100]],
  ['USDC', 'WETH', [250, 2_500, 25_000, 100_000]],
  ['WETH', 'cbBTC', [0.1, 1, 10]],
  ['USDC', 'DAI', [1_000, 25_000]],
  ['WETH', 'DAI', [0.01, 0.1]],
  // Long-tail: no direct pool to the quote asset, so every route is two-hop.
  ['DEGEN', 'USDC', [10_000, 500_000]],
  ['BRETT', 'USDC', [10_000, 200_000]],
  ['AERO', 'USDC', [500, 25_000]],
  ['cbETH', 'USDC', [1, 20]],
];

type Row = {
  pair: string;
  size: number;
  venues: number;
  bestVenue: string;
  /** Hops on the winning route: 1 direct, 2 through an intermediate. */
  bestHops: number;
  multiHopCandidates: number;
  splitLegs: number;
  grossBps: number;
  netBps: number;
  chosen: string;
};

// The committed benchmark is Base's; the pairs below are Base tokens.
const chain = CHAINS.base;
const bySymbol = (s: string) => lookup(s, chain);

const head = await client(chain).getBlockNumber();
const blockNumber = head - 5n;
console.log(`benchmarking at block ${blockNumber}\n`);

const rows: Row[] = [];

for (const [inSym, outSym, sizes] of PAIRS) {
  const tokenIn = bySymbol(inSym);
  const tokenOut = bySymbol(outSym);
  const hopCost = await hopCostInToken(tokenOut);

  for (const size of sizes) {
    const amountIn = BigInt(Math.round(size * 10 ** tokenIn.decimals));
    try {
      const curves = await quoteLadder(tokenIn, tokenOut, ladder(amountIn), undefined, blockNumber);
      if (curves.length === 0) continue;
      const best = bestRoute(curves, amountIn, hopCost);
      const bestVenue = best.single.allocations[0]?.venue;
      rows.push({
        pair: `${inSym}/${outSym}`,
        size,
        venues: curves.length,
        bestVenue: bestVenue?.label ?? '—',
        bestHops: bestVenue?.hops.length ?? 0,
        multiHopCandidates: curves.filter((c) => c.venue.hops.length > 1).length,
        splitLegs: best.split.allocations.length,
        grossBps: best.edgeBps,
        netBps: best.netEdgeBps,
        chosen: best.chosen,
      });
      process.stdout.write('.');
    } catch {
      process.stdout.write('x');
    }
  }
}

console.log('\n');

const header =
  '| Pair | Size | Routes | Best single | Hops | Split legs | Gross edge | Net of gas | Picks |';
const divider = '| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |';
const body = rows.map(
  (r) =>
    `| ${r.pair} | ${r.size.toLocaleString('en-US')} | ${r.venues} | ${r.bestVenue} | ` +
    `${r.bestHops} | ${r.splitLegs} | ${r.grossBps >= 0 ? '+' : ''}${r.grossBps.toFixed(1)} bp | ` +
    `${r.netBps >= 0 ? '+' : ''}${r.netBps.toFixed(1)} bp | ${r.chosen} |`,
);

const table = [header, divider, ...body].join('\n');
console.log(table);

const splitWins = rows.filter((r) => r.chosen === 'split');
const median = (xs: number[]) =>
  xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const multiHopWins = rows.filter((r) => r.bestHops > 1);
const summary = {
  blockNumber: blockNumber.toString(),
  generatedAt: new Date().toISOString(),
  casesRun: rows.length,
  splitChosen: splitWins.length,
  multiHopBest: multiHopWins.length,
  medianNetEdgeWhenSplitBps: median(splitWins.map((r) => r.netBps)),
  maxNetEdgeBps: rows.reduce((a, r) => Math.max(a, r.netBps), 0),
  rows,
};

writeFileSync('bench-results.json', JSON.stringify(summary, null, 2));

console.log(
  `\nsplit chosen in ${splitWins.length}/${rows.length} cases; ` +
    `multi-hop was the best route in ${multiHopWins.length}/${rows.length}; ` +
    `median net edge when split ${summary.medianNetEdgeWhenSplitBps.toFixed(1)} bp`,
);
console.log('wrote bench-results.json');

/**
 * Replays real swaps against the router and appends the results to a dataset.
 *
 *   npm run backtest                        # Base, last ~2000 blocks, up to 30 samples
 *   npm run backtest -- 4000 50             # wider window, more samples
 *   npm run backtest -- robinhood 4000 40   # Robinhood Chain
 *
 * Output is appended as JSON Lines to `data/backtest.jsonl`, which is committed
 * to the repository. That is the whole storage layer, and it is deliberate: a
 * scheduled job appends, git versions it, and the app reads it. No database to
 * provision, no credential to hold, and every historical claim the site makes
 * is auditable in the diff that introduced it.
 *
 * The window is bounded by what public RPC will serve — roughly 3,000 blocks of
 * logs and a few thousand blocks of historical state. A run therefore samples
 * recent history; the dataset accumulates depth over time rather than in one go.
 *
 * Robinhood Chain's RPC keeps about 6,000 blocks of state — ten minutes at
 * 100ms blocks — so its window is kept well inside that: the oldest samples
 * must still be quotable when the replay reaches them.
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { encodeFunctionData, decodeFunctionResult, parseAbi, type Address } from 'viem';
import { client, discover } from '../src/lib/quote';
import { CHAINS, isChainKey, MULTICALL3, type ChainKey, type Token } from '../src/lib/chain';
import { univ3FactoryAbi, multicall3Abi } from '../src/lib/abis';
import {
  buildPoolIndex,
  addV3Pools,
  fetchSwaps,
  replay,
  summarise,
  type BacktestResult,
} from '../src/lib/backtest';

const OUT = 'data/backtest.jsonl';
const V3F = parseAbi(univ3FactoryAbi);
const MC3 = parseAbi(multicall3Abi);
const ZERO = '0x0000000000000000000000000000000000000000';

// An optional leading chain key; Base when absent, as before Robinhood Chain.
const args = process.argv.slice(2);
const chainKey: ChainKey = args[0] && isChainKey(args[0]) ? (args.shift() as ChainKey) : 'base';
const chain = CHAINS[chainKey];
const bySymbol = (s: string) => chain.tokens.find((t) => t.symbol === s)!;

const span = BigInt(args[0] ?? (chainKey === 'robinhood' ? 4000 : 2000));
const maxSamples = Number(args[1] ?? 30);

const PAIRS: [Token, Token][] =
  chainKey === 'base'
    ? [
        [bySymbol('WETH'), bySymbol('USDC')],
        [bySymbol('WETH'), bySymbol('cbBTC')],
        [bySymbol('USDC'), bySymbol('DAI')],
        [bySymbol('WETH'), bySymbol('DEGEN')],
        [bySymbol('WETH'), bySymbol('AERO')],
        [bySymbol('WETH'), bySymbol('BRETT')],
        [bySymbol('WETH'), bySymbol('cbETH')],
      ]
    : // The hubs against each other, and every other token against each hub.
      [
        [chain.weth, chain.usd],
        ...chain.tokens
          .filter((t) => !chain.intermediates.includes(t))
          .flatMap((t) => chain.intermediates.map((m): [Token, Token] => [m, t])),
      ];

const c = client(chain);
const head = await c.getBlockNumber();
// Two blocks of headroom: the very tip can still be reorganised, and quoting
// against a block that later disappears produces a result nothing can reproduce.
const toBlock = head - 2n;
const fromBlock = toBlock - span;

console.log(`${chain.name}: scanning blocks ${fromBlock}..${toBlock} (${span} blocks)\n`);

// ── pool index ──────────────────────────────────────────────────────────────
const index = await buildPoolIndex(PAIRS);
console.log(`  ${index.size} V2/Aerodrome/V4 pools from discovery`);

// V3 hops carry a fee tier, not an address. Resolve every deployment's tiers.
const v3Wanted: { a: Token; b: Token; fee: number; factory: Address }[] = [];
for (const [a, b] of PAIRS) {
  for (const dep of chain.v3) {
    for (const fee of dep.feeTiers) {
      v3Wanted.push({ a, b, fee, factory: dep.factory as Address });
    }
  }
}

const poolRes = (await c.readContract({
  address: MULTICALL3,
  abi: MC3,
  functionName: 'aggregate3',
  args: [
    v3Wanted.map((w) => ({
      target: w.factory,
      allowFailure: true,
      callData: encodeFunctionData({
        abi: V3F,
        functionName: 'getPool',
        args: [w.a.address, w.b.address, w.fee],
      }),
    })),
  ],
})) as readonly { success: boolean; returnData: `0x${string}` }[];

const v3Pools: { pool: Address; a: Token; b: Token }[] = [];
v3Wanted.forEach((w, i) => {
  const r = poolRes[i];
  if (!r?.success || r.returnData === '0x') return;
  try {
    const pool = decodeFunctionResult({
      abi: V3F,
      functionName: 'getPool',
      data: r.returnData,
    }) as Address;
    if (pool !== ZERO) v3Pools.push({ pool, a: w.a, b: w.b });
  } catch {
    /* absent */
  }
});
addV3Pools(index, v3Pools);
console.log(`  ${v3Pools.length} V3 pools resolved  ->  ${index.size} pools watched\n`);

// ── observed swaps ──────────────────────────────────────────────────────────
const swaps = await fetchSwaps(index, fromBlock, toBlock);
console.log(`  ${swaps.length} single-swap transactions found`);

// Skip dust: a trade worth a fraction of a cent produces a meaningless
// percentage, and there are a great many of them.
const meaningful = swaps.filter((s) => {
  const units = Number(s.amountIn) / 10 ** s.tokenIn.decimals;
  const sym = s.tokenIn.symbol;
  if (sym === 'WETH') return units >= 0.01;
  if (sym === 'USDC' || sym === 'DAI' || sym === 'USDG') return units >= 25;
  if (sym === 'cbBTC') return units >= 0.0005;
  // Robinhood's stock tokens are priced per share, tens to hundreds of dollars.
  return units >= (chainKey === 'robinhood' ? 0.1 : 1);
});
console.log(`  ${meaningful.length} above the dust threshold`);

// Spread the sample across the window rather than taking the first N, which
// would all land in the same few blocks and share the same market conditions.
const step = Math.max(1, Math.floor(meaningful.length / maxSamples));
const sampled = meaningful.filter((_, i) => i % step === 0).slice(0, maxSamples);
console.log(`  ${sampled.length} sampled for replay\n`);

// ── replay ──────────────────────────────────────────────────────────────────
const results: BacktestResult[] = [];
let skipped = 0;

for (const swap of sampled) {
  const r = await replay(swap);
  if (!r) {
    skipped++;
    process.stdout.write('·');
    continue;
  }
  results.push(r);
  process.stdout.write(r.edgeBps > 0 ? '+' : r.edgeBps < 0 ? '-' : '=');
}

console.log(`\n\n  ${results.length} replayed, ${skipped} skipped (no quote at that height)\n`);

if (results.length === 0) {
  console.log('nothing to record');
  process.exit(0);
}

const summary = summarise(results);

console.log('| Pair | Size in | Actual out | Router out | Edge | Router venue |');
console.log('| --- | ---: | ---: | ---: | ---: | --- |');
for (const r of results.slice(0, 12)) {
  const [inSym] = r.pair.split('/');
  const tIn = bySymbol(inSym);
  const amt = Number(r.amountIn) / 10 ** tIn.decimals;
  console.log(
    `| ${r.pair} | ${amt.toPrecision(4)} | ${r.actualOut} | ${r.routerOut} | ` +
      `${r.edgeBps >= 0 ? '+' : ''}${r.edgeBps} bp | ${r.routerVenue} |`,
  );
}

console.log(`
  samples          ${summary.samples}
  median edge      ${summary.medianEdgeBps >= 0 ? '+' : ''}${summary.medianEdgeBps.toFixed(1)} bp
  win rate         ${(summary.winRate * 100).toFixed(0)}%  (${summary.wins} better, ${summary.losses} worse, ${summary.ties} equal)
  median win       +${summary.medianWinBps.toFixed(1)} bp
  median loss      ${summary.medianLossBps.toFixed(1)} bp
  p25 / p75        ${summary.p25EdgeBps.toFixed(1)} / ${summary.p75EdgeBps.toFixed(1)} bp
  multi-hop used   ${summary.multiHopUsed}/${summary.samples}
`);

// ── persist ─────────────────────────────────────────────────────────────────
mkdirSync(dirname(OUT), { recursive: true });

// One record per run, holding its own samples: the file is an append-only log
// of observations, so a bad run can be identified and dropped by its line
// rather than by trying to unpick individual rows.
const record = {
  runAt: new Date().toISOString(),
  chain: chainKey,
  fromBlock: fromBlock.toString(),
  toBlock: toBlock.toString(),
  observed: swaps.length,
  sampled: sampled.length,
  skipped,
  summary,
  results,
};

appendFileSync(OUT, JSON.stringify(record) + '\n');

const lines = existsSync(OUT) ? readFileSync(OUT, 'utf8').trim().split('\n').length : 1;
console.log(`appended to ${OUT} (${lines} runs recorded)`);

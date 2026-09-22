/**
 * Build a chain's Uniswap V4 pool registry.
 *
 *   npm run scan:v4              # Robinhood Chain
 *   npm run scan:v4 -- xlayer    # X Layer
 *
 * V4 pools cannot be discovered the way V2 and V3 pools are. There is no
 * factory with a getPool(a, b, fee), and fee and tick spacing are free
 * parameters, so guessing keys misses most of the liquidity.
 *
 * Two ways in, chosen by what the chain's endpoint will serve:
 *
 *   - **Initialize logs.** The PoolManager emits one per pool, with both
 *     currencies indexed, so the pools between listed tokens can be read
 *     straight out of the history. This is the complete answer, and it needs
 *     log queries spanning millions of blocks.
 *   - **Recent swaps.** X Layer caps a log query at a hundred blocks, which
 *     puts nine months of history out of reach. A Swap log names its pool by
 *     id and nothing else, but the PositionManager keeps a poolKeys mapping
 *     from id to key, so the pools that actually traded recently can be
 *     recovered from a short window. Narrower by construction: a pool nobody
 *     has touched in the window is not found.
 *
 * Kept either way: pools with no hooks, between two listed tokens (the native
 * asset counts as its wrapper), holding liquidity right now. At most
 * POOLS_PER_PAIR per pair, the deepest first.
 */

import { writeFileSync } from 'node:fs';
import { parseAbi, parseAbiItem, getAddress, type Address } from 'viem';
import { CHAINS, isChainKey, type ChainKey, type V4PoolKey } from '../src/lib/chain';
import { client } from '../src/lib/quote';

const POOLS_PER_PAIR = 3;
/** Blocks of recent swaps to mine for pool ids, where history is out of reach. */
const SWAP_WINDOW = 20_000;
const NATIVE = '0x0000000000000000000000000000000000000000';

const arg = process.argv[2];
if (arg && !isChainKey(arg)) throw new Error(`unknown chain: ${arg}`);
const chainKey: ChainKey = (arg as ChainKey) ?? 'robinhood';
const chain = CHAINS[chainKey];
if (!chain.v4) throw new Error(`${chain.name} has no Uniswap V4 deployment`);
const v4 = chain.v4;
const c = client(chain);

// One file per chain, each named for the chain it holds.
const OUT = new URL(
  chainKey === 'robinhood' ? '../src/lib/v4-pools.ts' : `../src/lib/v4-pools-${chainKey}.ts`,
  import.meta.url,
);

const initialize = parseAbiItem(
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
);
const swap = parseAbiItem(
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
);
const stateView = parseAbi(['function getLiquidity(bytes32 poolId) view returns (uint128)']);
const positionManager = parseAbi([
  'function poolKeys(bytes25 poolId) view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)',
]);

const listed = [NATIVE as Address, ...chain.tokens.map((t) => t.address)];
const asset = (a: string) => (a.toLowerCase() === NATIVE ? chain.weth.address.toLowerCase() : a.toLowerCase());

async function scan() {
  const head = await c.getBlockNumber();
  const found: { id: `0x${string}`; key: V4PoolKey }[] = [];
  let from = 0n;
  let step = 8_000_000n;
  while (from <= head) {
    const to = from + step > head ? head : from + step;
    try {
      const logs = await c.getLogs({
        address: v4.poolManager,
        event: initialize,
        args: { currency0: listed, currency1: listed },
        fromBlock: from,
        toBlock: to,
      });
      for (const l of logs) {
        const a = l.args;
        if (a.hooks !== NATIVE) continue;
        found.push({
          id: a.id!,
          key: {
            currency0: getAddress(a.currency0!),
            currency1: getAddress(a.currency1!),
            fee: a.fee!,
            tickSpacing: a.tickSpacing!,
            hooks: NATIVE,
          },
        });
      }
      from = to + 1n;
    } catch {
      // The endpoint caps the range a log query may cover. Halve and retry.
      step /= 2n;
      if (step < 10_000n) throw new Error(`log query keeps failing at block ${from}`);
    }
  }
  return found;
}

/**
 * Recover recently traded pools from their Swap logs.
 *
 * A Swap log carries the pool id and nothing else, and an id is a hash of the
 * key that cannot be inverted. The PositionManager holds the mapping, keyed by
 * the first 25 bytes of the id — every pool with a position minted through it
 * is in there, which is every pool anyone provides liquidity to.
 */
async function scanRecentSwaps() {
  const head = await c.getBlockNumber();
  const span = BigInt(chain.maxLogSpan);
  const ids = new Set<`0x${string}`>();
  for (let to = head; to > head - BigInt(SWAP_WINDOW); to -= span) {
    const logs = await c
      .getLogs({ address: v4.poolManager, event: swap, fromBlock: to - span + 1n, toBlock: to })
      .catch(() => []);
    for (const l of logs) ids.add(l.args.id!);
  }
  console.log(`  ${ids.size} pools traded in the last ${SWAP_WINDOW} blocks`);

  const found: { id: `0x${string}`; key: V4PoolKey }[] = [];
  for (const id of ids) {
    const key = await c
      .readContract({
        address: v4.positionManager!,
        abi: positionManager,
        functionName: 'poolKeys',
        args: [id.slice(0, 52) as `0x${string}`],
      })
      .catch(() => null);
    // A pool whose liquidity was never minted through the PositionManager
    // answers with zeroes. Nothing to record and nothing to route through.
    if (!key || key[0] === NATIVE && key[1] === NATIVE) continue;
    if (key[4] !== NATIVE) continue;
    found.push({
      id,
      key: {
        currency0: getAddress(key[0]),
        currency1: getAddress(key[1]),
        fee: key[2],
        tickSpacing: key[3],
        hooks: NATIVE,
      },
    });
  }
  return found;
}

const listedSet = new Set(listed.map((a) => a.toLowerCase()));
const discovered = v4.positionManager ? await scanRecentSwaps() : await scan();
const found = discovered.filter(
  (p) =>
    asset(p.key.currency0) !== asset(p.key.currency1) &&
    listedSet.has(p.key.currency0.toLowerCase()) &&
    listedSet.has(p.key.currency1.toLowerCase()),
);
console.log(`${found.length} hookless pools between listed tokens`);

const liquidity = await c.multicall({
  contracts: found.map((p) => ({
    address: v4.stateView,
    abi: stateView,
    functionName: 'getLiquidity' as const,
    args: [p.id] as const,
  })),
  allowFailure: true,
  // A few large aggregate calls rather than dozens of small ones, which this
  // endpoint rejects when they arrive together in one JSON-RPC batch.
  batchSize: 64_000,
});

// Raw liquidity is only comparable between pools of the same pair, which is
// the only comparison made with it.
const byPair = new Map<string, { key: V4PoolKey; L: bigint }[]>();
found.forEach((p, i) => {
  const r = liquidity[i];
  const L = r.status === 'success' ? (r.result as bigint) : 0n;
  if (L === 0n) return;
  const pair = [asset(p.key.currency0), asset(p.key.currency1)].sort().join(':');
  const list = byPair.get(pair) ?? [];
  list.push({ key: p.key, L });
  byPair.set(pair, list);
});

const kept: V4PoolKey[] = [];
for (const list of byPair.values()) {
  list.sort((a, b) => (a.L > b.L ? -1 : 1));
  kept.push(...list.slice(0, POOLS_PER_PAIR).map((x) => x.key));
}
const symbol = (a: string) =>
  a === NATIVE
    ? 'native'
    : chain.tokens.find((t) => t.address.toLowerCase() === a.toLowerCase())!.symbol;
kept.sort((a, b) =>
  `${symbol(a.currency0)}/${symbol(a.currency1)}`.localeCompare(`${symbol(b.currency0)}/${symbol(b.currency1)}`),
);

const lines = kept.map(
  (k) =>
    `  // ${symbol(k.currency0)}/${symbol(k.currency1)} ${(k.fee / 10_000).toFixed(4)}%\n` +
    `  { currency0: '${k.currency0}', currency1: '${k.currency1}', fee: ${k.fee}, tickSpacing: ${k.tickSpacing}, hooks: '${NATIVE}' },`,
);

writeFileSync(
  OUT,
  `// Generated by scripts/scan-v4.ts — do not edit by hand.
import type { V4PoolKey } from './chain';

export const ${chainKey.toUpperCase()}_V4_POOLS: readonly V4PoolKey[] = [
${lines.join('\n')}
];
`,
);
console.log(`${kept.length} pools across ${byPair.size} pairs written to ${OUT.pathname.split('/src/').pop()}`);

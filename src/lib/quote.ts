/**
 * The router core.
 *
 * Everything here answers one question: for a given pair, how much output does
 * each route give at each size, and what is the best way to cut a trade across
 * them. There is no aggregator API in this file. Prices come from pool state
 * and from quoter contracts, read over public RPC.
 *
 * Three ideas carry the design:
 *
 *   A *venue* is a whole route through one protocol family, not a single pool.
 *   WETH→USDC→DAI on Uniswap V3 is one venue with two hops, quoted and executed
 *   atomically, which is what lets the solver treat direct and multi-hop routes
 *   as interchangeable candidates rather than as two separate features.
 *
 *   A *ladder* is every venue quoted at a geometric series of sizes in one
 *   batched call. One ladder feeds three products — the best single venue, the
 *   optimal split, and the depth curve — so the expensive part (the network
 *   round trip) happens once.
 *
 *   *Prune, then ladder.* Candidate discovery is generous: four fee tiers, two
 *   intermediates, three V2 forks. Laddering all of them would be a hundred and
 *   eighty contract calls. So every candidate is first quoted once at full
 *   size, and only the survivors get the full ladder.
 */

import {
  createPublicClient,
  http,
  fallback,
  parseAbi,
  encodeFunctionData,
  decodeFunctionResult,
  concatHex,
  numberToHex,
  type Address,
  type PublicClient,
} from 'viem';
import {
  CHAINS,
  DEFAULT_CHAIN,
  MULTICALL3,
  chainOf,
  rpcUrlsFor,
  type ChainConfig,
  type Token,
  type V4PoolKey,
} from './chain';
import {
  multicall3Abi,
  v2FactoryAbi,
  v2PairAbi,
  aeroFactoryAbi,
  aeroRouterAbi,
  quoterV2Abi,
  v4QuoterAbi,
} from './abis';

const MC3 = parseAbi(multicall3Abi);
const V2F = parseAbi(v2FactoryAbi);
const V2P = parseAbi(v2PairAbi);
const AEROF = parseAbi(aeroFactoryAbi);
const AEROR = parseAbi(aeroRouterAbi);
const QUOTER = parseAbi(quoterV2Abi);
const V4Q = parseAbi(v4QuoterAbi);

const ZERO = '0x0000000000000000000000000000000000000000';

/** How many contract-quoted venues survive pruning and get a full ladder. */
const LADDER_WIDTH = 6;

/**
 * A route the quoter says costs more gas than this is dropped.
 *
 * A pool with liquidity in only a narrow band quotes by walking every empty
 * tick down to the price limit: on Robinhood Chain, 1,000 USDG into the 0.01%
 * NVDA pool quoted dust for 32.5M gas, more than a block holds. Such a route
 * can never execute, so it is not a route.
 */
const MAX_ROUTE_GAS = 3_000_000n;

export type Hop =
  /** `dex` indexes the chain's `v3` table: Uniswap V3 and its forks share a
   *  quoter ABI but not a router ABI, so the deployment travels with the hop. */
  | { family: 'v3'; fee: number; dex: number }
  | { family: 'v2'; pool: Address; feeBps: number }
  | { family: 'aero'; pool: Address; stable: boolean }
  /** `key.currency0`/`currency1` may be native ETH (0x0) where the path says
   *  WETH; execution wraps and unwraps at the ends. */
  | { family: 'v4'; key: V4PoolKey; zeroForOne: boolean };

/**
 * A route through one protocol family. `path` is the token sequence including
 * both ends, so `hops.length === path.length - 1`.
 */
export type Venue = {
  id: string;
  label: string;
  family: 'v3' | 'v2' | 'aero' | 'v4';
  path: Token[];
  hops: Hop[];
  /** Which router executes this route. Unset only for Aerodrome, which has one. */
  router?: Address;
};

/** The chain a route runs on: the chain its tokens live on. */
export const chainOfVenue = (v: Venue): ChainConfig => chainOf(v.path[0]);

export const isMultiHop = (v: Venue): boolean => v.hops.length > 1;

export type Call = { target: Address; allowFailure: boolean; callData: `0x${string}` };

const clients = new Map<number, PublicClient>();

/**
 * Public RPC endpoints rate-limit and occasionally return stale state, so the
 * transport is a fallback chain rather than one URL. `batch` lets viem coalesce
 * concurrent eth_calls into a single JSON-RPC array.
 *
 * A private endpoint, when configured, goes in front; see `rpcUrlsFor`.
 */
export function client(chain: ChainConfig = CHAINS[DEFAULT_CHAIN]): PublicClient {
  let c = clients.get(chain.id);
  if (!c) {
    const urls = rpcUrlsFor(chain);
    c = createPublicClient({
      chain: chain.viem,
      transport: fallback(
        urls.map((url) => http(url, { batch: true, retryCount: 2, timeout: 12_000 })),
      ),
    }) as PublicClient;
    clients.set(chain.id, c);
  }
  return c;
}

/**
 * One aggregate3 round trip, chunked.
 *
 * Chunking is not an optimisation. A V3 quote through a thin pool walks every
 * initialised tick it crosses and can cost millions of gas on its own; enough
 * of those in one aggregate3 exceeds the node's eth_call gas cap, and the
 * endpoint rejects the entire batch rather than the expensive part of it.
 * Discovered on WETH/DAI, where the shallow tiers are the expensive ones.
 *
 * `blockNumber` pins the read to a height. The app never uses it — traders want
 * the current price — but the fork tests do: a prediction made at `latest` and
 * replayed against a fork two blocks later is comparing two different markets.
 */
async function batch(
  chain: ChainConfig,
  calls: Call[],
  blockNumber?: bigint,
): Promise<readonly { success: boolean; returnData: `0x${string}` }[]> {
  if (calls.length === 0) return [];
  const c = client(chain);

  const CHUNK = 12;
  const chunks: Call[][] = [];
  for (let i = 0; i < calls.length; i += CHUNK) chunks.push(calls.slice(i, i + CHUNK));

  const results = await Promise.all(
    chunks.map(async (chunk) => {
      try {
        return (await c.readContract({
          address: MULTICALL3,
          abi: MC3,
          functionName: 'aggregate3',
          args: [chunk],
          ...(blockNumber !== undefined ? { blockNumber } : {}),
        })) as readonly { success: boolean; returnData: `0x${string}` }[];
      } catch {
        // One over-budget chunk must not take the other venues down with it.
        return chunk.map(() => ({ success: false, returnData: '0x' as `0x${string}` }));
      }
    }),
  );

  return results.flat();
}

/** Uniswap V3 packs a multi-hop path as token,fee,token,fee,token. */
export function encodeV3Path(path: Token[], fees: number[]): `0x${string}` {
  const parts: `0x${string}`[] = [path[0].address];
  fees.forEach((fee, i) => {
    parts.push(numberToHex(fee, { size: 3 }));
    parts.push(path[i + 1].address);
  });
  return concatHex(parts);
}

const aeroRoutes = (v: Venue) =>
  v.hops.map((h, i) => ({
    from: v.path[i].address,
    to: v.path[i + 1].address,
    stable: (h as Extract<Hop, { family: 'aero' }>).stable,
    factory: chainOfVenue(v).aerodrome!.factory,
  }));

/**
 * A fee in hundredths of a basis point, as a percentage number: two places for
 * the standard tiers, as many as it takes for V4's free-form fees.
 */
const feeNum = (fee: number): string =>
  fee % 100 === 0 ? (fee / 10_000).toFixed(2) : String(Number((fee / 10_000).toFixed(4)));

/**
 * The currency a V4 pool uses for `t`: native ETH where the pool holds ETH and
 * the path says WETH, otherwise the token itself. Null when the pool does not
 * trade `t` at all.
 */
export function v4Currency(chain: ChainConfig, key: V4PoolKey, t: Token): Address | null {
  const isWeth = t.address.toLowerCase() === chain.weth.address.toLowerCase();
  for (const c of [key.currency0, key.currency1]) {
    if (c.toLowerCase() === t.address.toLowerCase()) return c;
    if (isWeth && c === ZERO) return ZERO;
  }
  return null;
}

/** Every listed V4 pool that trades `a` against `b`, with the currencies it uses for each. */
function v4PoolsFor(chain: ChainConfig, a: Token, b: Token) {
  const out: { key: V4PoolKey; ca: Address; cb: Address }[] = [];
  for (const key of chain.v4?.pools ?? []) {
    const ca = v4Currency(chain, key, a);
    const cb = v4Currency(chain, key, b);
    if (ca !== null && cb !== null && ca !== cb) out.push({ key, ca, cb });
  }
  return out;
}

/**
 * Enumerate every route worth quoting: direct pools, plus two-hop routes
 * through a small set of liquid intermediates.
 *
 * Intermediates are the chain's hubs — WETH and USDC on Base, WETH and USDG on
 * Robinhood Chain — because essentially all liquidity is paired against one of
 * them; a long-tail token with neither has no route worth finding. The candidate set is deliberately wide and pruned later by price,
 * which is cheaper and more honest than guessing in advance which venue is deep.
 *
 * Uniswap V3 needs no discovery calls: its quoter takes a fee tier directly and
 * reverts when the pool is absent, so dead tiers prune themselves at quote time.
 */
export async function discover(
  tokenIn: Token,
  tokenOut: Token,
  blockNumber?: bigint,
): Promise<Venue[]> {
  const chain = chainOf(tokenIn);
  const mids = chain.intermediates.filter(
    (m) =>
      m.address.toLowerCase() !== tokenIn.address.toLowerCase() &&
      m.address.toLowerCase() !== tokenOut.address.toLowerCase(),
  );

  // Every (factory, tokenA, tokenB) pair we need to ask about, deduplicated.
  type Probe = { kind: 'v2'; forkIndex: number; a: Token; b: Token } | { kind: 'aero'; stable: boolean; a: Token; b: Token };
  const probes: Probe[] = [];

  chain.v2.forEach((_, forkIndex) => {
    probes.push({ kind: 'v2', forkIndex, a: tokenIn, b: tokenOut });
    for (const m of mids) {
      probes.push({ kind: 'v2', forkIndex, a: tokenIn, b: m });
      probes.push({ kind: 'v2', forkIndex, a: m, b: tokenOut });
    }
  });
  const aero = chain.aerodrome;
  if (aero) {
    for (const stable of [true, false]) {
      probes.push({ kind: 'aero', stable, a: tokenIn, b: tokenOut });
      for (const m of mids) {
        probes.push({ kind: 'aero', stable, a: tokenIn, b: m });
        probes.push({ kind: 'aero', stable, a: m, b: tokenOut });
      }
    }
  }

  const res = await batch(
    chain,
    probes.map((p) => ({
      target: p.kind === 'v2' ? chain.v2[p.forkIndex].factory : aero!.factory,
      allowFailure: true,
      callData:
        p.kind === 'v2'
          ? encodeFunctionData({ abi: V2F, functionName: 'getPair', args: [p.a.address, p.b.address] })
          : encodeFunctionData({
              abi: AEROF,
              functionName: 'getPool',
              args: [p.a.address, p.b.address, p.stable],
            }),
    })),
    blockNumber,
  );

  // pools[probeKey] = pool address, for the probes that found one.
  const pools = new Map<string, Address>();
  const probeKey = (p: Probe) =>
    p.kind === 'v2'
      ? `v2:${p.forkIndex}:${p.a.symbol}:${p.b.symbol}`
      : `aero:${p.stable}:${p.a.symbol}:${p.b.symbol}`;

  probes.forEach((p, i) => {
    const r = res[i];
    if (!r?.success || r.returnData === '0x') return;
    try {
      const pool = decodeFunctionResult({
        abi: p.kind === 'v2' ? V2F : AEROF,
        functionName: p.kind === 'v2' ? 'getPair' : 'getPool',
        data: r.returnData,
      }) as Address;
      if (pool !== ZERO) pools.set(probeKey(p), pool);
    } catch {
      /* factory returned something unexpected; treat as absent */
    }
  });

  const venues: Venue[] = [];

  // ── V2 forks ──────────────────────────────────────────────────────────
  chain.v2.forEach((fork, forkIndex) => {
    const direct = pools.get(`v2:${forkIndex}:${tokenIn.symbol}:${tokenOut.symbol}`);
    if (direct) {
      venues.push({
        id: `v2:${fork.name}`,
        label: fork.name,
        family: 'v2',
        path: [tokenIn, tokenOut],
        hops: [{ family: 'v2', pool: direct, feeBps: fork.feeBps }],
        router: fork.router,
      });
    }
    for (const m of mids) {
      const legA = pools.get(`v2:${forkIndex}:${tokenIn.symbol}:${m.symbol}`);
      const legB = pools.get(`v2:${forkIndex}:${m.symbol}:${tokenOut.symbol}`);
      if (!legA || !legB) continue;
      venues.push({
        id: `v2:${fork.name}:${m.symbol}`,
        label: `${fork.name} via ${m.symbol}`,
        family: 'v2',
        path: [tokenIn, m, tokenOut],
        hops: [
          { family: 'v2', pool: legA, feeBps: fork.feeBps },
          { family: 'v2', pool: legB, feeBps: fork.feeBps },
        ],
        router: fork.router,
      });
    }
  });

  // ── Aerodrome ─────────────────────────────────────────────────────────
  for (const stable of [true, false]) {
    const direct = pools.get(`aero:${stable}:${tokenIn.symbol}:${tokenOut.symbol}`);
    if (direct) {
      venues.push({
        id: `aero:${stable ? 'stable' : 'volatile'}`,
        label: `Aerodrome ${stable ? 'sAMM' : 'vAMM'}`,
        family: 'aero',
        path: [tokenIn, tokenOut],
        hops: [{ family: 'aero', pool: direct, stable }],
      });
    }
  }
  for (const m of mids) {
    for (const s1 of [true, false]) {
      for (const s2 of [true, false]) {
        const legA = pools.get(`aero:${s1}:${tokenIn.symbol}:${m.symbol}`);
        const legB = pools.get(`aero:${s2}:${m.symbol}:${tokenOut.symbol}`);
        if (!legA || !legB) continue;
        venues.push({
          id: `aero:${s1 ? 's' : 'v'}${s2 ? 's' : 'v'}:${m.symbol}`,
          // The curve types belong in the label: a stable-then-volatile route
          // and a volatile-then-volatile route through the same intermediate
          // are different markets that can quote hundreds of basis points
          // apart, and showing both as "Aerodrome via USDC" reads as a bug.
          label: `Aerodrome ${s1 ? 's' : 'v'}/${s2 ? 's' : 'v'} via ${m.symbol}`,
          family: 'aero',
          path: [tokenIn, m, tokenOut],
          hops: [
            { family: 'aero', pool: legA, stable: s1 },
            { family: 'aero', pool: legB, stable: s2 },
          ],
        });
      }
    }
  }

  // ── Concentrated liquidity (Uniswap V3 and forks) ─────────────────────
  //
  // No discovery calls: these quoters take a fee tier directly and revert when
  // the pool is absent, so dead tiers prune themselves at quote time.
  chain.v3.forEach((dep, dex) => {
    for (const fee of dep.feeTiers) {
      venues.push({
        id: `v3:${dex}:${fee}`,
        label: `${dep.name} ${(fee / 10_000).toFixed(2)}%`,
        family: 'v3',
        path: [tokenIn, tokenOut],
        hops: [{ family: 'v3', fee, dex }],
        router: dep.router,
      });
    }
    // Multi-hop is restricted to the tiers that hold real liquidity on the
    // chain. All tiers squared would be sixteen candidates per intermediate per
    // deployment, most of them empty pools, and pruning each costs a call.
    for (const m of mids) {
      for (const f1 of dep.multiHopTiers) {
        for (const f2 of dep.multiHopTiers) {
          venues.push({
            id: `v3:${dex}:${f1}-${f2}:${m.symbol}`,
            label: `${dep.name} ${(f1 / 10_000).toFixed(2)}/${(f2 / 10_000).toFixed(2)}% via ${m.symbol}`,
            family: 'v3',
            path: [tokenIn, m, tokenOut],
            hops: [
              { family: 'v3', fee: f1, dex },
              { family: 'v3', fee: f2, dex },
            ],
            router: dep.router,
          });
        }
      }
    }
  });

  // ── Uniswap V4 ────────────────────────────────────────────────────────
  //
  // Candidates come from the committed pool registry, not from calls: V4 has
  // no factory to ask. As with V3, a pool that has drained since the registry
  // was built fails its quote and prunes itself.
  const v4 = chain.v4;
  if (v4) {
    const v4Venue = (path: Token[], hops: Extract<Hop, { family: 'v4' }>[]): Venue => ({
      id: `v4:${hops.map((h) => `${h.key.currency0}-${h.key.currency1}-${h.key.fee}-${h.key.tickSpacing}`).join(':')}`,
      label:
        hops.length === 1
          ? `${v4.name} ${feeNum(hops[0].key.fee)}%`
          : `${v4.name} ${hops.map((h) => feeNum(h.key.fee)).join('/')}% via ${path[1].symbol}`,
      family: 'v4',
      path,
      hops,
      router: v4.universalRouter,
    });

    for (const p of v4PoolsFor(chain, tokenIn, tokenOut)) {
      venues.push(
        v4Venue([tokenIn, tokenOut], [
          { family: 'v4', key: p.key, zeroForOne: p.ca.toLowerCase() === p.key.currency0.toLowerCase() },
        ]),
      );
    }
    for (const m of mids) {
      for (const a of v4PoolsFor(chain, tokenIn, m)) {
        for (const b of v4PoolsFor(chain, m, tokenOut)) {
          // One path hands the intermediate from the first pool to the second
          // inside the PoolManager, so both must use the same currency for it.
          // An ETH pool followed by a WETH pool would need a wrap mid-route.
          if (a.cb.toLowerCase() !== b.ca.toLowerCase()) continue;
          venues.push(
            v4Venue([tokenIn, m, tokenOut], [
              { family: 'v4', key: a.key, zeroForOne: a.ca.toLowerCase() === a.key.currency0.toLowerCase() },
              { family: 'v4', key: b.key, zeroForOne: b.ca.toLowerCase() === b.key.currency0.toLowerCase() },
            ]),
          );
        }
      }
    }
  }

  return venues;
}

/** Reserve snapshot for one constant-product pool, oriented to the trade. */
export type V2State = { reserveIn: bigint; reserveOut: bigint; feeBps: number };

/**
 * Constant product, done by hand rather than by calling the router's
 * getAmountsOut. Two reasons: it costs no RPC — so once reserves are known the
 * whole ladder is arithmetic, and a two-hop route is just the function applied
 * twice — and the fee numerator differs per fork. BaseSwap takes 25bp where
 * Uniswap takes 30, which a shared router helper silently gets wrong.
 *
 *   out = (in * (10000 - fee) * reserveOut) / (reserveIn * 10000 + in * (10000 - fee))
 *
 * All bigint. A float here is a rounding error denominated in money.
 */
export function v2AmountOut(amountIn: bigint, s: V2State): bigint {
  if (amountIn <= 0n || s.reserveIn <= 0n || s.reserveOut <= 0n) return 0n;
  const inAfterFee = amountIn * BigInt(10_000 - s.feeBps);
  return (inAfterFee * s.reserveOut) / (s.reserveIn * 10_000n + inAfterFee);
}

/** Chain the constant-product formula across a multi-hop path. */
export function v2ChainOut(amountIn: bigint, states: V2State[]): bigint {
  let amount = amountIn;
  for (const s of states) {
    amount = v2AmountOut(amount, s);
    if (amount === 0n) return 0n;
  }
  return amount;
}

export type Rung = { amountIn: bigint; amountOut: bigint };
export type VenueCurve = {
  venue: Venue;
  rungs: Rung[];
  /** Gas this route costs, used for net-of-cost comparison. */
  gasEstimate: bigint;
};

/**
 * Geometric size ladder ending at the requested amount.
 *
 * Geometric rather than linear because price impact is roughly linear in size
 * for small trades and blows up at the top — linear spacing spends most of its
 * samples in the flat region where nothing interesting happens.
 */
export function ladder(amountIn: bigint, rungs = 12): bigint[] {
  const out: bigint[] = [];
  for (let i = 0; i < rungs; i++) {
    const v = amountIn / (1n << BigInt(rungs - 1 - i));
    if (v > 0n && (out.length === 0 || v > out[out.length - 1])) out.push(v);
  }
  return out;
}

/**
 * A ladder that spans well above the trade as well as below it.
 *
 * The plain `ladder` stops at the requested amount, which is all a quote needs.
 * Capacity — "how much can this pair absorb" — is a question about sizes the
 * user did *not* ask for, and a ladder that stops at their size can only ever
 * answer "at least what you typed". This reaches 32x above and 256x below.
 */
export function analysisLadder(amountIn: bigint, above = 32n, rungs = 13): bigint[] {
  const top = amountIn * above;
  const out: bigint[] = [];
  for (let i = 0; i < rungs; i++) {
    const v = top / (1n << BigInt(rungs - 1 - i));
    if (v > 0n && (out.length === 0 || v > out[out.length - 1])) out.push(v);
  }
  return out;
}

/** The currency each point of a V4 route's path is settled in, ETH or token. */
export function v4PathCurrencies(v: Venue): Address[] {
  const hops = v.hops as Extract<Hop, { family: 'v4' }>[];
  const chain = chainOfVenue(v);
  const out: Address[] = [v4Currency(chain, hops[0].key, v.path[0])!];
  hops.forEach((h, i) => out.push(v4Currency(chain, h.key, v.path[i + 1])!));
  return out;
}

/** V4 multi-hop path: every currency after the first, with the pool that reaches it. */
export function v4PathKeys(v: Venue) {
  const hops = v.hops as Extract<Hop, { family: 'v4' }>[];
  const currencies = v4PathCurrencies(v);
  return hops.map((h, i) => ({
    intermediateCurrency: currencies[i + 1],
    fee: h.key.fee,
    tickSpacing: h.key.tickSpacing,
    hooks: h.key.hooks,
    hookData: '0x' as `0x${string}`,
  }));
}

/** Build the contract call that quotes one venue at one size. */
function quoteCall(v: Venue, size: bigint): Call | null {
  const chain = chainOfVenue(v);

  if (v.family === 'v4') {
    const hops = v.hops as Extract<Hop, { family: 'v4' }>[];
    const quoter = chain.v4!.quoter;
    // The V4 quoter takes a uint128. A size past that is not a trade anyone
    // can make, and encoding it would throw rather than return a dead quote.
    if (size >= 1n << 128n) return null;
    if (hops.length === 1) {
      return {
        target: quoter,
        allowFailure: true,
        callData: encodeFunctionData({
          abi: V4Q,
          functionName: 'quoteExactInputSingle',
          args: [{ poolKey: hops[0].key, zeroForOne: hops[0].zeroForOne, exactAmount: size, hookData: '0x' }],
        }),
      };
    }
    return {
      target: quoter,
      allowFailure: true,
      callData: encodeFunctionData({
        abi: V4Q,
        functionName: 'quoteExactInput',
        args: [{ exactCurrency: v4PathCurrencies(v)[0], path: v4PathKeys(v), exactAmount: size }],
      }),
    };
  }

  if (v.family === 'v3') {
    const v3hops = v.hops as Extract<Hop, { family: 'v3' }>[];
    const fees = v3hops.map((h) => h.fee);
    const quoter = chain.v3[v3hops[0].dex].quoter;
    if (v.hops.length === 1) {
      return {
        target: quoter,
        allowFailure: true,
        callData: encodeFunctionData({
          abi: QUOTER,
          functionName: 'quoteExactInputSingle',
          args: [
            {
              tokenIn: v.path[0].address,
              tokenOut: v.path[1].address,
              amountIn: size,
              fee: fees[0],
              sqrtPriceLimitX96: 0n,
            },
          ],
        }),
      };
    }
    return {
      target: quoter,
      allowFailure: true,
      callData: encodeFunctionData({
        abi: QUOTER,
        functionName: 'quoteExactInput',
        args: [encodeV3Path(v.path, fees), size],
      }),
    };
  }

  if (v.family === 'aero') {
    // The router's own getAmountsOut handles both the stable and the volatile
    // curve, and chains hops for us. Reimplementing a Solidly invariant
    // off-chain to save one call is how you ship a number that is subtly wrong.
    return {
      target: chain.aerodrome!.router,
      allowFailure: true,
      callData: encodeFunctionData({
        abi: AEROR,
        functionName: 'getAmountsOut',
        args: [size, aeroRoutes(v)],
      }),
    };
  }

  return null; // v2 is priced from reserves, never per-size
}

/** Decode whatever `quoteCall` asked for. Returns 0n when the route is dead. */
function decodeQuote(v: Venue, data: `0x${string}`): { amountOut: bigint; gas?: bigint } {
  try {
    if (v.family === 'v4') {
      const [amountOut, gas] = decodeFunctionResult({
        abi: V4Q,
        functionName: v.hops.length === 1 ? 'quoteExactInputSingle' : 'quoteExactInput',
        data,
      }) as unknown as [bigint, bigint];
      return { amountOut, gas };
    }
    if (v.family === 'v3') {
      if (v.hops.length === 1) {
        const d = decodeFunctionResult({
          abi: QUOTER,
          functionName: 'quoteExactInputSingle',
          data,
        }) as unknown as [bigint, bigint, number, bigint];
        return { amountOut: d[0], gas: d[3] };
      }
      const d = decodeFunctionResult({
        abi: QUOTER,
        functionName: 'quoteExactInput',
        data,
      }) as unknown as [bigint, readonly bigint[], readonly number[], bigint];
      return { amountOut: d[0], gas: d[3] };
    }
    const amounts = decodeFunctionResult({
      abi: AEROR,
      functionName: 'getAmountsOut',
      data,
    }) as readonly bigint[];
    return { amountOut: amounts[amounts.length - 1] ?? 0n };
  } catch {
    return { amountOut: 0n };
  }
}

/** Fetch reserves for every distinct V2 pool, oriented per venue. */
async function v2States(
  venues: Venue[],
  blockNumber?: bigint,
): Promise<Map<string, V2State[]>> {
  const v2 = venues.filter((v) => v.family === 'v2');
  const poolSet = new Map<Address, Token[]>();
  for (const v of v2) {
    v.hops.forEach((h, i) => {
      poolSet.set((h as Extract<Hop, { family: 'v2' }>).pool, [v.path[i], v.path[i + 1]]);
    });
  }
  const poolList = [...poolSet.keys()];

  if (poolList.length === 0) return new Map();
  const res = await batch(
    chainOfVenue(v2[0]),
    poolList.flatMap((pool) => [
      { target: pool, allowFailure: true, callData: encodeFunctionData({ abi: V2P, functionName: 'getReserves' }) },
      { target: pool, allowFailure: true, callData: encodeFunctionData({ abi: V2P, functionName: 'token0' }) },
    ]),
    blockNumber,
  );

  // Reserve orientation comes from token0(), never from argument order: the
  // pair contract fixes the sort, and assuming it inverts the price.
  const oriented = new Map<Address, { r0: bigint; r1: bigint; token0: string }>();
  poolList.forEach((pool, i) => {
    const rr = res[i * 2];
    const t0 = res[i * 2 + 1];
    if (!rr?.success || !t0?.success) return;
    try {
      const [r0, r1] = decodeFunctionResult({
        abi: V2P,
        functionName: 'getReserves',
        data: rr.returnData,
      }) as unknown as [bigint, bigint, number];
      const token0 = (
        decodeFunctionResult({ abi: V2P, functionName: 'token0', data: t0.returnData }) as Address
      ).toLowerCase();
      oriented.set(pool, { r0, r1, token0 });
    } catch {
      /* not a pair contract */
    }
  });

  const out = new Map<string, V2State[]>();
  for (const v of v2) {
    const states: V2State[] = [];
    let ok = true;
    v.hops.forEach((h, i) => {
      const hop = h as Extract<Hop, { family: 'v2' }>;
      const o = oriented.get(hop.pool);
      if (!o) {
        ok = false;
        return;
      }
      const inIsToken0 = v.path[i].address.toLowerCase() === o.token0;
      states.push({
        reserveIn: inIsToken0 ? o.r0 : o.r1,
        reserveOut: inIsToken0 ? o.r1 : o.r0,
        feeBps: hop.feeBps,
      });
    });
    if (ok && states.length === v.hops.length) out.set(v.id, states);
  }
  return out;
}

/** Gas for a route: measured per family, scaled by hop count. */
function gasFor(v: Venue, quoted?: bigint): bigint {
  if (quoted && quoted > 0n) return quoted;
  const perHop =
    v.family === 'aero' ? 181_000n : v.family === 'v2' ? 102_000n : v.family === 'v4' ? 120_000n : 130_000n;
  // A second hop reuses the transaction's warm state, so it costs less than the
  // first. Measured in contracts/test/GasProfile.t.sol.
  return perHop + BigInt(v.hops.length - 1) * 70_000n;
}

/**
 * Quote every venue at every rung.
 *
 * V2 routes need only their pools' reserves — one read each, then the entire
 * curve, multi-hop included, is arithmetic. Aerodrome and Uniswap V3 need a
 * contract call per rung, because a Solidly stable curve and a
 * concentrated-liquidity tick walk cannot be reproduced off-chain without
 * reimplementing the pool, and a reimplementation that drifts by one tick is
 * worse than useless.
 */
export async function quoteLadder(
  tokenIn: Token,
  tokenOut: Token,
  sizes: bigint[],
  venues?: Venue[],
  blockNumber?: bigint,
): Promise<VenueCurve[]> {
  const vs = venues ?? (await discover(tokenIn, tokenOut, blockNumber));
  if (vs.length === 0) return [];

  const contractVenues = vs.filter((v) => v.family !== 'v2');
  const fullSize = sizes[sizes.length - 1];

  // ── prune ───────────────────────────────────────────────────────────────
  // One call per candidate at full size. Cheap next to a full ladder, and it
  // is the only way to know which of sixteen V3 candidates actually has a pool
  // behind it without paying twelve calls each to find out.
  const probeCalls: { venue: Venue; call: Call }[] = [];
  for (const v of contractVenues) {
    const call = quoteCall(v, fullSize);
    if (call) probeCalls.push({ venue: v, call });
  }

  // Reserves and the prune probe are independent, so they share a round trip
  // rather than taking one each. With discovery and the ladder that is three
  // sequential network stages for a quote, not four — worth about a second on
  // a long-tail pair, where the candidate set is widest.
  const chain = chainOf(tokenIn);
  const [states, probeRes] = await Promise.all([
    v2States(vs, blockNumber),
    batch(
      chain,
      probeCalls.map((p) => p.call),
      blockNumber,
    ),
  ]);

  type Probed = { venue: Venue; amountOut: bigint; gas?: bigint };
  const probed: Probed[] = [];
  probeCalls.forEach((p, i) => {
    const r = probeRes[i];
    if (!r?.success || r.returnData === '0x') return;
    const { amountOut, gas } = decodeQuote(p.venue, r.returnData);
    if (amountOut <= 0n) return;
    if (gas !== undefined && gas > MAX_ROUTE_GAS) return;
    probed.push({ venue: p.venue, amountOut, gas });
  });
  probed.sort((a, b) => (a.amountOut > b.amountOut ? -1 : 1));

  // Deduplicate routes that are the same shape at the same price — Aerodrome's
  // stable/volatile enumeration produces several identical-looking multi-hop
  // candidates when only one of the two pools actually exists.
  const seen = new Set<string>();
  const survivors = probed
    .filter((p) => {
      const key = `${p.venue.label}:${p.amountOut}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, LADDER_WIDTH);

  // ── ladder ──────────────────────────────────────────────────────────────
  const rungCalls: { venueId: string; size: bigint; call: Call }[] = [];
  for (const s of survivors) {
    for (const size of sizes) {
      if (size === fullSize) continue; // already have it from the probe
      const call = quoteCall(s.venue, size);
      if (call) rungCalls.push({ venueId: s.venue.id, size, call });
    }
  }
  const rungRes = await batch(
    chain,
    rungCalls.map((r) => r.call),
    blockNumber,
  );

  const rungsByVenue = new Map<string, Rung[]>();
  const gasByVenue = new Map<string, bigint>();
  for (const s of survivors) {
    rungsByVenue.set(s.venue.id, [{ amountIn: fullSize, amountOut: s.amountOut }]);
    if (s.gas) gasByVenue.set(s.venue.id, s.gas);
  }
  rungCalls.forEach((rc, i) => {
    const r = rungRes[i];
    if (!r?.success || r.returnData === '0x') return;
    const venue = survivors.find((s) => s.venue.id === rc.venueId)!.venue;
    const { amountOut } = decodeQuote(venue, r.returnData);
    if (amountOut <= 0n) return;
    rungsByVenue.get(rc.venueId)!.push({ amountIn: rc.size, amountOut });
  });

  const curves: VenueCurve[] = [];

  for (const v of vs) {
    if (v.family === 'v2') {
      const st = states.get(v.id);
      if (!st) continue;
      const rungs = sizes.map((amountIn) => ({ amountIn, amountOut: v2ChainOut(amountIn, st) }));
      if (rungs.every((r) => r.amountOut === 0n)) continue;
      curves.push({ venue: v, rungs, gasEstimate: gasFor(v) });
    } else {
      const rungs = rungsByVenue.get(v.id);
      if (!rungs || rungs.length === 0) continue;
      rungs.sort((a, b) => (a.amountIn < b.amountIn ? -1 : 1));
      curves.push({ venue: v, rungs, gasEstimate: gasFor(v, gasByVenue.get(v.id)) });
    }
  }

  return curves;
}

/**
 * Output of a venue at an arbitrary size, interpolated from its sampled curve.
 *
 * Piecewise-linear on a concave, monotone function underestimates between
 * samples, which is the safe direction: the splitter will never believe a venue
 * is deeper than it is. Above the top rung we extrapolate at the marginal rate
 * of the last segment, again an underestimate once impact is accounted for.
 */
export function interpolate(curve: VenueCurve, amountIn: bigint): bigint {
  const r = curve.rungs;
  if (r.length === 0 || amountIn <= 0n) return 0n;
  if (amountIn <= r[0].amountIn) {
    return (r[0].amountOut * amountIn) / r[0].amountIn;
  }
  for (let i = 1; i < r.length; i++) {
    if (amountIn <= r[i].amountIn) {
      const dIn = r[i].amountIn - r[i - 1].amountIn;
      const dOut = r[i].amountOut - r[i - 1].amountOut;
      if (dIn === 0n) return r[i].amountOut;
      return r[i - 1].amountOut + (dOut * (amountIn - r[i - 1].amountIn)) / dIn;
    }
  }
  const last = r[r.length - 1];
  const prev = r.length > 1 ? r[r.length - 2] : { amountIn: 0n, amountOut: 0n };
  const dIn = last.amountIn - prev.amountIn;
  const dOut = last.amountOut - prev.amountOut;
  if (dIn <= 0n) return last.amountOut;
  return last.amountOut + (dOut * (amountIn - last.amountIn)) / dIn;
}

export type Allocation = { venue: Venue; amountIn: bigint; amountOut: bigint; share: number };
export type Route = {
  allocations: Allocation[];
  amountIn: bigint;
  amountOut: bigint;
  gasEstimate: bigint;
};

/**
 * Split a trade across venues by greedy marginal allocation.
 *
 * Each pool's output curve is concave in size — the second unit always buys
 * less than the first — so handing the next slice to whichever venue offers the
 * best marginal rate converges on the optimum, the same argument that makes
 * water-filling optimal. Slices are what makes it approximate; 32 of them puts
 * the residual well inside a basis point on every pair measured so far.
 */
export function splitRoute(curves: VenueCurve[], amountIn: bigint, slices = 32): Route {
  if (curves.length === 0 || amountIn <= 0n) {
    return { allocations: [], amountIn, amountOut: 0n, gasEstimate: 0n };
  }

  const alloc = new Map<string, bigint>(curves.map((c) => [c.venue.id, 0n]));
  const slice = amountIn / BigInt(slices);
  let remaining = amountIn;

  for (let i = 0; i < slices && remaining > 0n; i++) {
    const step = i === slices - 1 ? remaining : slice;
    if (step <= 0n) break;

    let bestId: string | null = null;
    let bestGain = 0n;
    for (const c of curves) {
      const cur = alloc.get(c.venue.id)!;
      const gain = interpolate(c, cur + step) - interpolate(c, cur);
      if (gain > bestGain) {
        bestGain = gain;
        bestId = c.venue.id;
      }
    }
    if (!bestId) break;
    alloc.set(bestId, alloc.get(bestId)! + step);
    remaining -= step;
  }

  const allocations: Allocation[] = [];
  let total = 0n;
  let gas = 0n;
  for (const c of curves) {
    const a = alloc.get(c.venue.id)!;
    if (a <= 0n) continue;
    const out = interpolate(c, a);
    total += out;
    gas += c.gasEstimate;
    allocations.push({
      venue: c.venue,
      amountIn: a,
      amountOut: out,
      share: Number((a * 10_000n) / amountIn) / 100,
    });
  }
  allocations.sort((x, y) => (x.amountIn > y.amountIn ? -1 : 1));

  return { allocations, amountIn, amountOut: total, gasEstimate: gas };
}

/** Minimum net advantage, in basis points, before a split is recommended. */
export const MIN_SPLIT_EDGE_BPS = 1n;

export type BestRoute = {
  single: Route;
  split: Route;
  chosen: 'single' | 'split';
  /** Split advantage over the best single venue, in basis points, before gas. */
  edgeBps: number;
  /** The same advantage after subtracting the extra gas. */
  netEdgeBps: number;
};

/**
 * Compare the best single venue against the split, and price the difference.
 *
 * A split that wins by 3bp on a trade whose extra pool hop costs 6bp of gas is
 * a loss, and quoting it as a win is the most common way an aggregator flatters
 * itself. `gasCostInOutputToken` is what makes the comparison honest; the caller
 * supplies it because only the caller knows the gas price and the output
 * token's price in ETH.
 */
export function bestRoute(
  curves: VenueCurve[],
  amountIn: bigint,
  gasCostInOutputToken: bigint = 0n,
): BestRoute {
  let single: Route = { allocations: [], amountIn, amountOut: 0n, gasEstimate: 0n };
  for (const c of curves) {
    const out = interpolate(c, amountIn);
    if (out > single.amountOut) {
      single = {
        allocations: [{ venue: c.venue, amountIn, amountOut: out, share: 100 }],
        amountIn,
        amountOut: out,
        gasEstimate: c.gasEstimate,
      };
    }
  }

  const split = splitRoute(curves, amountIn);

  const edgeBps =
    single.amountOut > 0n
      ? Number(((split.amountOut - single.amountOut) * 10_000n) / single.amountOut)
      : 0;

  const extraHops = BigInt(Math.max(0, split.allocations.length - 1));
  const netSplit = split.amountOut - extraHops * gasCostInOutputToken;
  const netEdgeBps =
    single.amountOut > 0n ? Number(((netSplit - single.amountOut) * 10_000n) / single.amountOut) : 0;

  // A split has to be worth doing, not merely arithmetically ahead. Beating the
  // single venue by a fraction of a basis point buys the user nothing and costs
  // them an extra pool's worth of execution risk, so the recommendation needs a
  // full basis point of daylight before it changes.
  const threshold = single.amountOut + (single.amountOut * MIN_SPLIT_EDGE_BPS) / 10_000n;

  return { single, split, chosen: netSplit > threshold ? 'split' : 'single', edgeBps, netEdgeBps };
}

/**
 * GET /api/venues?chain=robinhood&in=WETH&out=USDG
 *
 * The pool inventory behind a pair: every distinct pool the router would
 * consider, including the ones sitting in the middle of a two-hop route, and
 * how much of each token that pool actually holds.
 *
 * Inventory is read as ERC-20 balances of the pool contract rather than as
 * `getReserves`, deliberately. Reserves are a V2 concept; a V3 pool has no such
 * function, and a Solidly stable pool's reserves are not comparable to a
 * constant-product pool's. Token balances are the one measure that means the
 * same thing at every venue: this is the stock a trade can consume.
 *
 * Uniswap V4 pools are the exception and are left out: they hold no balance of
 * their own. Every V4 pool's tokens sit together in one PoolManager contract,
 * so a balance read there is the whole chain's V4 inventory, not the pool's.
 */

import { NextResponse } from 'next/server';
import { encodeFunctionData, decodeFunctionResult, parseAbi, type Address } from 'viem';
import { bySymbol, chainByKey, MULTICALL3, type ChainConfig, type Token } from '@/lib/chain';
import { client, discover, type Venue, type Hop } from '@/lib/quote';
import { erc20Abi, univ3FactoryAbi, multicall3Abi } from '@/lib/abis';
import { jsonSafe } from '@/lib/format';
import { venueCache } from '@/lib/serve';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

const ERC20 = parseAbi(erc20Abi);
const V3F = parseAbi(univ3FactoryAbi);
const MC3 = parseAbi(multicall3Abi);
const ZERO = '0x0000000000000000000000000000000000000000';

type Aggregate = readonly { success: boolean; returnData: `0x${string}` }[];

async function aggregate(
  chain: ChainConfig,
  calls: { target: Address; allowFailure: boolean; callData: `0x${string}` }[],
): Promise<Aggregate> {
  if (calls.length === 0) return [];
  const out: Aggregate[] = [];
  for (let i = 0; i < calls.length; i += 20) {
    out.push(
      (await client(chain).readContract({
        address: MULTICALL3,
        abi: MC3,
        functionName: 'aggregate3',
        args: [calls.slice(i, i + 20)],
      })) as Aggregate,
    );
  }
  return out.flat();
}

/** One pool, as it appears in some route. */
type PoolRow = {
  family: Venue['family'];
  label: string;
  curve: string;
  tokenA: Token;
  tokenB: Token;
  pool: Address;
  inventoryA: bigint;
  inventoryB: bigint;
  usedByMultiHop: boolean;
};

export async function GET(req: Request) {
  const url = new URL(req.url);

  try {
    const chain = chainByKey(url.searchParams.get('chain'));
    const inSym = url.searchParams.get('in') ?? chain.weth.symbol;
    const outSym = url.searchParams.get('out') ?? chain.usd.symbol;
    const tokenIn = bySymbol(inSym, chain);
    const tokenOut = bySymbol(outSym, chain);
    if (tokenIn.address === tokenOut.address) {
      return NextResponse.json({ error: 'tokenIn and tokenOut are the same' }, { status: 400 });
    }

    // Pool inventory moves slowly next to price, so this caches for far longer
    // than a quote does: the page is a directory, not a ticker.
    const { value } = await venueCache.get(`${chain.id}:${tokenIn.symbol}:${tokenOut.symbol}`, async () => {
      const venues = await discover(tokenIn, tokenOut);

      // Flatten every venue into its hops. A hop is a pool; the same pool can
      // appear in several routes, so it is keyed and deduplicated.
      type Pending = {
        family: Venue['family'];
        label: string;
        curve: string;
        a: Token;
        b: Token;
        pool?: Address;
        fee?: number;
        factory?: Address;
        multi: boolean;
      };
      const pending: Pending[] = [];

      for (const v of venues) {
        v.hops.forEach((h: Hop, i) => {
          const a = v.path[i];
          const b = v.path[i + 1];
          if (h.family === 'v4') return;
          if (h.family === 'v3') {
            const dep = chain.v3[h.dex];
            pending.push({
              family: 'v3',
              label: `${dep.name} ${(h.fee / 10_000).toFixed(2)}%`,
              curve: 'concentrated',
              a,
              b,
              fee: h.fee,
              factory: dep.factory,
              multi: v.hops.length > 1,
            });
          } else if (h.family === 'v2') {
            pending.push({
              family: 'v2',
              label: v.label.split(' via ')[0],
              curve: 'constant product',
              a,
              b,
              pool: h.pool,
              multi: v.hops.length > 1,
            });
          } else {
            pending.push({
              family: 'aero',
              label: `Aerodrome ${h.stable ? 'sAMM' : 'vAMM'}`,
              curve: h.stable ? 'stable' : 'volatile',
              a,
              b,
              pool: h.pool,
              multi: v.hops.length > 1,
            });
          }
        });
      }

      // V3 hops carry a fee tier, not an address — quoting never needs one.
      // Displaying a pool does, so resolve them from the factory.
      const needsAddress = pending.filter((p) => !p.pool);
      const poolRes = await aggregate(
        chain,
        needsAddress.map((p) => ({
          target: p.factory!,
          allowFailure: true,
          callData: encodeFunctionData({
            abi: V3F,
            functionName: 'getPool',
            args: [p.a.address, p.b.address, p.fee!],
          }),
        })),
      );
      needsAddress.forEach((p, i) => {
        const r = poolRes[i];
        if (!r?.success || r.returnData === '0x') return;
        try {
          const addr = decodeFunctionResult({
            abi: V3F,
            functionName: 'getPool',
            data: r.returnData,
          }) as Address;
          if (addr !== ZERO) p.pool = addr;
        } catch {
          /* absent */
        }
      });

      const unique = new Map<string, Pending>();
      for (const p of pending) {
        if (!p.pool) continue;
        const existing = unique.get(p.pool.toLowerCase());
        if (existing) {
          // A pool reached by both a direct and a multi-hop route is not
          // "multi-hop only"; the flag means "this pool is only reachable mid-route".
          existing.multi = existing.multi && p.multi;
          continue;
        }
        unique.set(p.pool.toLowerCase(), { ...p });
      }
      const rows = [...unique.values()];

      const balRes = await aggregate(
        chain,
        rows.flatMap((r) =>
          [r.a.address, r.b.address].map((t) => ({
            target: t as Address,
            allowFailure: true,
            callData: encodeFunctionData({ abi: ERC20, functionName: 'balanceOf', args: [r.pool!] }),
          })),
        ),
      );

      const decode = (i: number): bigint => {
        const res = balRes[i];
        if (!res?.success || res.returnData === '0x') return 0n;
        try {
          return decodeFunctionResult({
            abi: ERC20,
            functionName: 'balanceOf',
            data: res.returnData,
          }) as bigint;
        } catch {
          return 0n;
        }
      };

      const out: PoolRow[] = rows
        .map((r, i) => ({
          family: r.family,
          label: r.label,
          curve: r.curve,
          tokenA: r.a,
          tokenB: r.b,
          pool: r.pool!,
          inventoryA: decode(i * 2),
          inventoryB: decode(i * 2 + 1),
          usedByMultiHop: r.multi,
        }))
        .filter((r) => r.inventoryA > 0n || r.inventoryB > 0n);

      return jsonSafe({
        tokenIn,
        tokenOut,
        chain: chain.key,
        routesConsidered: venues.length,
        multiHopRoutes: venues.filter((v) => v.hops.length > 1).length,
        pools: out,
      });
    });

    return NextResponse.json(value as object, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'venue lookup failed';
    // An unknown chain or token is the caller's mistake. Every other route
    // here answers that with a 400; this one used to call it a server fault.
    const bad = message.startsWith('unknown chain') || message.startsWith('unknown token');
    return NextResponse.json({ error: message }, { status: bad ? 400 : 500 });
  }
}

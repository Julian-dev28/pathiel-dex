'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Token } from '@/lib/chain';
import { usePair } from './ChainProvider';
import { sig, addr } from '@/lib/format';
import { TokenSelect } from './TokenSelect';
import { ChainTabs } from './ChainTabs';
import { Card, Answer, Answers, Reveal, Chip, Empty, ErrorNote, Loading, PageHead } from './ui';

type PoolRow = {
  family: 'v2' | 'v3' | 'aero';
  label: string;
  curve: string;
  tokenA: Token;
  tokenB: Token;
  pool: `0x${string}`;
  inventoryA: bigint;
  inventoryB: bigint;
  usedByMultiHop: boolean;
};

type Payload = { routesConsidered: number; multiHopRoutes: number; pools: PoolRow[] };

/**
 * Venues.
 *
 * Answers "where could this trade go" with a count first and the inventory
 * table second. The table is the evidence, not the headline.
 */
export function VenueTable() {
  const { chain, inSym, outSym, setInSym, setOutSym } = usePair();
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetch(`/api/venues?chain=${chain.key}&in=${inSym}&out=${outSym}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        if (body.error) return setError(body.error);
        setData({
          routesConsidered: body.routesConsidered,
          multiHopRoutes: body.multiHopRoutes,
          pools: (body.pools as (Omit<PoolRow, 'inventoryA' | 'inventoryB'> & {
            inventoryA: string;
            inventoryB: string;
          })[]).map((p) => ({
            ...p,
            inventoryA: BigInt(p.inventoryA),
            inventoryB: BigInt(p.inventoryB),
          })),
        });
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [chain.key, inSym, outSym]);

  const pools = useMemo(
    () => (data ? [...data.pools].sort((a, b) => a.label.localeCompare(b.label)) : []),
    [data],
  );
  const midRoute = pools.filter((p) => p.usedByMultiHop).length;

  return (
    <>
      <PageHead
        title="Venues"
        lede="Every pool this pair could route through, found by asking each factory rather than from a list."
      />

      <ChainTabs />

      <Card title="Pair">
        <div className="c-controls">
          <TokenSelect value={inSym} onChange={setInSym} tokens={chain.tokens} exclude={outSym} />
          <span className="c-arrow">/</span>
          <TokenSelect value={outSym} onChange={setOutSym} tokens={chain.tokens} exclude={inSym} />
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
      </Card>

      {!data && !error ? (
        <Card title="Scanning factories">
          <Loading rows={3} />
        </Card>
      ) : data ? (
        <>
          <Card title="What the router can reach" step={1}>
            <Answers>
              <Answer
                label="Routes considered"
                value={data.routesConsidered}
                size="xl"
                note={`${data.multiHopRoutes} pass through an intermediate token`}
              />
              <Answer label="Distinct pools" value={pools.length} note={`${midRoute} only reachable mid-route`} />
            </Answers>
          </Card>

          <Card title="Pool inventory" step={2} meta={`${pools.length} pools`}>
            {pools.length === 0 ? (
              <Empty>
                No pools found for {inSym}/{outSym}.
              </Empty>
            ) : (
              <div className="c-scroll">
                <table className="c-table">
                  <thead>
                    <tr>
                      <th>Venue</th>
                      <th>Pair</th>
                      <th className="num">Holds</th>
                      <th>Pool</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pools.map((p) => (
                      <tr key={p.pool}>
                        <td>
                          {p.label}
                          {p.usedByMultiHop && (
                            <>
                              {' '}
                              <Chip tone="mut">mid-route</Chip>
                            </>
                          )}
                          <div className="c-sub">{p.curve}</div>
                        </td>
                        <td className="mono">
                          {p.tokenA.symbol}/{p.tokenB.symbol}
                        </td>
                        <td className="num mono">
                          {sig(p.inventoryA, p.tokenA, 5)} {p.tokenA.symbol}
                          <div className="c-sub">
                            {sig(p.inventoryB, p.tokenB, 5)} {p.tokenB.symbol}
                          </div>
                        </td>
                        <td className="mono">
                          <a href={`${chain.explorer}/address/${p.pool}`} target="_blank" rel="noreferrer">
                            {addr(p.pool)}
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <Reveal summary="Why balances rather than reserves?">
              <p>
                A V3 pool has no <code>getReserves</code>, and a stable pool&rsquo;s reserves are not
                comparable to a constant-product pool&rsquo;s. Token balances are the one figure that
                means the same thing in every row.
              </p>
              <p>
                For a concentrated pool, only the fraction of that balance sitting in range is
                available to the next trade — which is exactly why the router quotes rather than
                ranking by size.
              </p>
            </Reveal>
          </Card>
        </>
      ) : null}
    </>
  );
}

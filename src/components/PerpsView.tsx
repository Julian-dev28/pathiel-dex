'use client';

import { useEffect, useState } from 'react';
import type { PerpRow } from '@/lib/perps';
import { bps, pct } from '@/lib/format';
import { useChain } from './ChainProvider';
import { Card, Answer, Answers, Reveal, Chip, Empty, ErrorNote, Loading, PageHead } from './ui';

type Payload = { chain: string; quotedAt: number; stockMarkets: number; rows: PerpRow[] };

const usd = (v: number) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const millions = (v: number) => `$${(v / 1e6).toFixed(1)}m`;

/**
 * Perps.
 *
 * The same company priced twice: by a pool on the selected chain, and by an
 * oracle on a perp venue. The basis between them is the only figure here that
 * needs both, which is why the two prices sit in adjacent columns — and why the
 * column headers, not a footnote, say where each one comes from.
 */
export function PerpsView() {
  const { chain } = useChain();
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetch(`/api/perps?chain=${chain.key}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        if (body.error) return setError(body.error);
        setData(body as Payload);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [chain.key]);

  const priced = data ? data.rows.filter((r) => r.spotUsd !== null).length : 0;

  return (
    <>
      <PageHead
        title="Perps"
        lede={`Every asset below is listed twice — as a pool on ${chain.name} and as a perpetual on Hyperliquid. The gap between the two is the basis.`}
      />

      {error && (
        <Card title="Perps">
          <ErrorNote>{error}</ErrorNote>
        </Card>
      )}

      {!data && !error ? (
        <Card title="Reading both sides">
          <Loading rows={4} />
        </Card>
      ) : data ? (
        <Card
          title="Perp against pool"
          step={1}
          meta={<span className="mono">spot quoted {new Date(data.quotedAt).toLocaleTimeString()}</span>}
        >
          <Answers>
            <Answer
              label="Markets shown"
              value={data.rows.length}
              size="xl"
              note={`${data.stockMarkets} stock perps trade on xyz; the rest of that book has no pool here`}
            />
            <Answer
              label={`Priced on ${chain.name}`}
              value={priced}
              note="the others are listed on another chain, or on none"
            />
          </Answers>

          {data.rows.length === 0 ? (
            <Empty>No perp market here matches an asset this router lists.</Empty>
          ) : (
            <div className="c-scroll">
              <table className="c-table">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th className="num">Perp mark</th>
                    <th className="num">Spot on {chain.name}</th>
                    <th className="num">Basis</th>
                    <th className="num">Funding / yr</th>
                    <th className="num">Open interest</th>
                    <th className="num">Max leverage</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={`${r.dex}:${r.symbol}`}>
                      <td className="mono">
                        {r.symbol}{' '}
                        <Chip tone={r.dex ? 'accent' : 'mut'}>{r.dex || 'core'}</Chip>
                      </td>
                      <td className="num mono">{usd(r.markUsd)}</td>
                      <td className="num mono">{r.spotUsd === null ? '—' : usd(r.spotUsd)}</td>
                      <td className={`num mono ${r.basisBps === null ? 'mut' : r.basisBps >= 0 ? 'up' : 'dn'}`}>
                        {r.basisBps === null ? '—' : bps(r.basisBps)}
                      </td>
                      <td className={`num mono ${r.fundingAnnual >= 0 ? 'up' : 'dn'}`}>
                        {pct(r.fundingAnnual * 100)}
                      </td>
                      <td className="num mono">{millions(r.openInterestUsd)}</td>
                      <td className="num mono">{r.maxLeverage}×</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <Reveal summary="Are these two prices the same kind of fact?">
            <p>
              <strong>No, and the difference matters more than the basis does.</strong> The spot
              column is read from pool state over public RPC: the pool <em>is</em> the price, and
              anyone can re-read the same contracts and get the same number. The perp mark is an
              oracle published by the deployer of the HIP-3 dex the market lives on — marked{' '}
              <Chip tone="accent">xyz</Chip> above — who also sets that market&rsquo;s leverage,
              margin and funding parameters. That is a third party&rsquo;s number about an
              off-chain security, not a chain&rsquo;s. Markets marked <Chip tone="mut">core</Chip>{' '}
              are Hyperliquid&rsquo;s own universe rather than a builder&rsquo;s.
            </p>
            <p>
              <strong>Funding is quoted per hour</strong> by the API and annualised exactly once
              here (×24×365) for the column above. A basis that looks enormous beside a spot price
              is usually a funding rate someone annualised twice.
            </p>
            <p>
              <strong>An em dash is an absence, not a zero.</strong> An asset with no listing on{' '}
              {chain.name} has no spot price here and therefore no basis — switching the chain in
              the masthead re-quotes the column against a different set of pools. Spot is quoted by
              selling $1,000 of {chain.usd.symbol} into the asset, so it carries that trade&rsquo;s
              price impact rather than being a mid.
            </p>
            <p>
              Nothing on this page signs or sends anything; every read here is public and
              unauthenticated on both sides.
            </p>
          </Reveal>
        </Card>
      ) : null}
    </>
  );
}

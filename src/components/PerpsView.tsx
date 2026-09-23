'use client';

import { useEffect, useState } from 'react';
import type { PerpRow } from '@/lib/perps';
import { bps, pct } from '@/lib/format';
import { useChain } from './ChainProvider';
import { PerpTicket } from './PerpTicket';
import { Card, Answer, Answers, Reveal, Chip, Empty, ErrorNote, Loading, PageHead } from './ui';

type Payload = { chain: string; quotedAt: number; stockMarkets: number; rows: PerpRow[] };

const usd = (v: number) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const millions = (v: number) => `$${(v / 1e6).toFixed(1)}m`;
/** A market is a symbol on a dex: the same ticker on two dexes is two markets. */
const marketKey = (r: PerpRow) => `${r.dex}:${r.symbol}`;

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
  // The ticket follows a market, not a row: kept as a key so it survives the
  // re-quote that a chain switch triggers underneath it.
  const [picked, setPicked] = useState<string | null>(null);

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

  const priced = data ? data.rows.filter((r) => r.spotBuyUsd !== null).length : 0;
  const pickedRow = data?.rows.find((r) => marketKey(r) === picked) ?? null;

  return (
    <>
      <PageHead
        title="Perps"
        lede={`Every asset below is listed twice — as a pool on ${chain.name} and as a perpetual on Hyperliquid. The gap between the two is what buying outright costs against what the perp marks.`}
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
                    <th className="num">Buy on {chain.name}</th>
                    <th className="num">Perp vs buy</th>
                    <th className="num">Funding / yr</th>
                    <th className="num">Open interest</th>
                    <th className="num">Max leverage</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={marketKey(r)} onClick={() => setPicked(marketKey(r))}>
                      <td className="mono">
                        <button
                          className="c-ghost mono"
                          type="button"
                          aria-pressed={marketKey(r) === picked}
                          aria-label={`Open a ticket on ${r.symbol} on ${r.dex || 'core'}`}
                        >
                          {r.symbol}
                        </button>{' '}
                        <Chip tone={r.dex ? 'accent' : 'mut'}>{r.dex || 'core'}</Chip>
                        {marketKey(r) === picked && <Chip tone="good">ticket</Chip>}
                      </td>
                      <td className="num mono">{usd(r.markUsd)}</td>
                      <td className="num mono">{r.spotBuyUsd === null ? '—' : usd(r.spotBuyUsd)}</td>
                      <td className={`num mono ${r.vsSpotBuyBps === null ? 'mut' : r.vsSpotBuyBps >= 0 ? 'up' : 'dn'}`}>
                        {r.vsSpotBuyBps === null ? '—' : bps(r.vsSpotBuyBps)}
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
              <strong>No, and the difference matters more than the gap does.</strong> The buy
              column is what this router&rsquo;s pools would actually return for the trade named
              below — an executable price over public RPC, fee and price impact included, which
              anyone can re-quote against the same contracts. It is not a mid, so the gap beside it
              is not a funding basis: at a 0.30% fee tier the cost of trading alone is thirty basis
              points, more than the premium being measured. The perp mark is an
              oracle published by the deployer of the HIP-3 dex the market lives on — marked{' '}
              <Chip tone="accent">xyz</Chip> above — who also sets that market&rsquo;s leverage,
              margin and funding parameters. That is a third party&rsquo;s number about an
              off-chain security, not a chain&rsquo;s. Markets marked <Chip tone="mut">core</Chip>{' '}
              are Hyperliquid&rsquo;s own universe rather than a builder&rsquo;s.
            </p>
            <p>
              <strong>Funding is quoted per hour</strong> by the API and annualised exactly once
              here (×24×365) for the column above. A number that looks enormous beside a spot price
              is usually a funding rate someone annualised twice.
            </p>
            <p>
              <strong>An em dash is an absence, not a zero.</strong> An asset with no listing on{' '}
              {chain.name} has no buy price here and nothing to compare the mark against —
              switching the chain in the masthead re-quotes the column against a different set of
              pools. The price is quoted by selling $1,000 of {chain.usd.symbol} into the asset, so
              a larger trade would walk further up the book and read worse.
            </p>
            <p>
              Every read in this table is public and unauthenticated on both sides. The ticket
              underneath it is the only thing on this page that signs anything, and it signs
              nothing until the summary has been reviewed.
            </p>
          </Reveal>
        </Card>
      ) : null}

      {data && <PerpTicket row={pickedRow} />}
    </>
  );
}

'use client';

import { useEffect, useState } from 'react';
import type { PerpRow } from '@/lib/perps';
import { bps, pct } from '@/lib/format';
import { CHAINS, type ChainKey } from '@/lib/chain';
import { OpenOrders } from './OpenOrders';
import { PerpTicket } from './PerpTicket';
import { Card, Answer, Answers, Reveal, Chip, Empty, ErrorNote, Loading, PageHead } from './ui';

type Payload = {
  quotedAt: number;
  /** Which chain gave each asset its buy price. Absent when nothing quoted. */
  spotChain: Record<string, ChainKey>;
  stockMarkets: number;
  rows: PerpRow[];
};

const usd = (v: number) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const millions = (v: number) => `$${(v / 1e6).toFixed(1)}m`;
/** A market is a symbol on a dex: the same ticker on two dexes is two markets. */
const marketKey = (r: PerpRow) => `${r.dex}:${r.symbol}`;

/**
 * Perps.
 *
 * The same company priced twice: by an oracle on a perp venue, and by the
 * cheapest pool this router can reach for it. The buy side names no chain,
 * because a buyer does not pick one — the router does, at the moment of the
 * trade, and quoting one chain here would compare the mark against a price
 * nobody would have been given. The chain that won is shown beside the price
 * as a fact about the quote, not a control.
 */
export function PerpsView() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The ticket follows a market, not a row: the same ticker on two dexes is two
  // markets, and a re-quote must not move the ticket to the other one.
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetch('/api/perps', { cache: 'no-store' })
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
  }, []);

  const priced = data ? data.rows.filter((r) => r.spotBuyUsd !== null).length : 0;
  // Listed here, but the quote did not answer. Counted apart from the absent
  // ones: the two look identical on screen and mean opposite things.
  const unavailable = data ? data.rows.filter((r) => r.spotStatus === 'unavailable').length : 0;
  const pickedRow = data?.rows.find((r) => marketKey(r) === picked) ?? null;

  return (
    <>
      <PageHead
        title="Perps"
        lede="Stock perps on Hyperliquid, beside the cheapest this router can buy the same asset outright anywhere it routes. Where both sides exist, the gap between them is the third column."
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
              note={`${data.stockMarkets} stock perps trade on xyz; the rest of that book is not listed for spot by this router on any chain`}
            />
            <Answer
              label="With a buy price"
              value={priced}
              note={
                unavailable > 0
                  ? `${unavailable} could not be quoted just now; the rest this router lists no pool for anywhere`
                  : 'the rest this router lists no pool for anywhere'
              }
              tone={unavailable > 0 ? 'warn' : undefined}
            />
          </Answers>

          {data.rows.length === 0 ? (
            <Empty>No perp market matches an asset this router lists.</Empty>
          ) : (
            <div className="c-scroll">
              <table className="c-table">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th className="num">Perp mark</th>
                    <th className="num">Cheapest buy</th>
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
                      <td className="num mono">
                        {r.spotBuyUsd !== null ? (
                          <>
                            {usd(r.spotBuyUsd)}{' '}
                            {data.spotChain[r.symbol] && (
                              <Chip tone="mut">{CHAINS[data.spotChain[r.symbol]].name}</Chip>
                            )}
                          </>
                        ) : r.spotStatus === 'unavailable' ? (
                          // Listed somewhere; no chain's quote came back. Saying
                          // "not listed" would be a claim the router cannot make.
                          <span title="listed, but no quote came back">…</span>
                        ) : (
                          '—'
                        )}
                      </td>
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
              <strong>An em dash is an absence, a dotted line is a failure.</strong> An em dash
              means this router lists no pool for the asset on any chain. An ellipsis means it lists
              one and no chain&rsquo;s quote came back — a cold start, a rate limit — which clears
              on a reload. Neither has a buy price to compare the mark against.
            </p>
            <p>
              <strong>The chip beside a price is the chain that won it</strong>, not a chain you
              chose: every listing is priced and the cheapest is shown, because that is the one the
              router would send the money to. The price is quoted by selling $1,000 of that
              chain&rsquo;s dollar into the asset, so a larger trade would walk further up the book
              and read worse.
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
      {/* Account-wide rather than per-market: a resting order is not something
          you go looking for under the ticker you happened to place it on. */}
      <OpenOrders />
    </>
  );
}

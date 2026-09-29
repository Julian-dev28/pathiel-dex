'use client';

import { useEffect, useState } from 'react';
import type { PerpRow } from '@/lib/perps';
import { OpenOrders } from './OpenOrders';
import { PerpTicket } from './PerpTicket';
import { Card, ErrorNote, Loading } from './ui';

const marketKey = (r: PerpRow) => `${r.dex}:${r.symbol}`;
const usd = (v: number) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/**
 * Perps inside the trade window: pick a market, then the same ticket the perps
 * page uses. The comparison table stays on the perps page; here the market is
 * one control, like the pair on the swap ticket.
 */
export function PerpsTrade() {
  const [rows, setRows] = useState<PerpRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/perps', { cache: 'no-store' })
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        if (body.error) return setError(body.error);
        setRows(body.rows as PerpRow[]);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <Card title="Perps">
        <ErrorNote>{error}</ErrorNote>
      </Card>
    );
  }
  if (!rows) {
    return (
      <Card title="Perps">
        <Loading rows={3} />
      </Card>
    );
  }

  const fallback = rows.find((r) => r.symbol === 'NVDA') ?? rows[0] ?? null;
  const row = rows.find((r) => marketKey(r) === picked) ?? fallback;

  return (
    <>
      <Card title="Market">
        <label className="c-route-pick" style={{ marginTop: 0 }}>
          <span>Market</span>
          <select
            className="c-route-select"
            value={row ? marketKey(row) : ''}
            onChange={(e) => setPicked(e.target.value)}
          >
            {rows.map((r) => (
              <option key={marketKey(r)} value={marketKey(r)}>
                {r.symbol} ({r.dex || 'core'}) — {usd(r.markUsd)} · up to {r.maxLeverage}×
              </option>
            ))}
          </select>
        </label>
      </Card>
      <PerpTicket row={row} />
      <OpenOrders />
    </>
  );
}

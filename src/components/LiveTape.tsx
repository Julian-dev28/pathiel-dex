'use client';

import { useEffect, useRef, useState } from 'react';
import { chainOf, type Token } from '@/lib/chain';
import { sig } from '@/lib/format';
import { Card, Chip, Empty } from './ui';

type Tick = {
  blockNumber: string;
  amountOut: string;
  venue: string | null;
  path: string[];
  hops: number;
  chosen: 'single' | 'split';
  netEdgeBps: number;
  at: number;
};

type Status = 'connecting' | 'live' | 'stalled' | 'closed';

/**
 * The price tape: quotes pushed from `/api/stream` as blocks land.
 *
 * This is deliberately *not* the number the trade form signs against. The form
 * owns its own quote with an explicit expiry, because a price that changes
 * under the user between reading and clicking is how people get a fill they did
 * not agree to. The tape is for watching the market move; the form is for
 * trading. Conflating the two would make the interface feel more live and be
 * less safe.
 *
 * The server only pushes when the quote actually changed, so a quiet tape means
 * a quiet market rather than a broken connection — which is why the status
 * flips to "stalled" on a timer rather than on the absence of messages alone.
 */
export function LiveTape({
  inSym,
  outSym,
  amount,
  tokenOut,
}: {
  inSym: string;
  outSym: string;
  amount: string;
  tokenOut: Token;
}) {
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [status, setStatus] = useState<Status>('connecting');
  const lastEventAt = useRef(Date.now());

  useEffect(() => {
    setTicks([]);
    setStatus('connecting');
    lastEventAt.current = Date.now();

    const url = `/api/stream?chain=${chainOf(tokenOut).key}&in=${encodeURIComponent(inSym)}&out=${encodeURIComponent(
      outSym,
    )}&amount=${encodeURIComponent(amount)}`;
    const es = new EventSource(url);

    es.addEventListener('open', () => setStatus('live'));

    es.addEventListener('quote', (e) => {
      lastEventAt.current = Date.now();
      setStatus('live');
      try {
        const data = JSON.parse((e as MessageEvent).data);
        // Newest first, bounded — an unbounded tape is a memory leak on a page
        // someone leaves open.
        setTicks((prev) => [{ ...data, at: Date.now() }, ...prev].slice(0, 8));
      } catch {
        /* malformed frame; drop it rather than break the tape */
      }
    });

    es.addEventListener('bye', () => {
      setStatus('closed');
      es.close();
    });

    // EventSource reconnects on its own; this only reflects the current state.
    es.onerror = () => setStatus((s) => (s === 'closed' ? s : 'stalled'));

    const stallCheck = setInterval(() => {
      setStatus((s) => {
        if (s === 'closed') return s;
        return Date.now() - lastEventAt.current > 45_000 ? 'stalled' : s;
      });
    }, 5_000);

    return () => {
      clearInterval(stallCheck);
      es.close();
    };
  }, [tokenOut.chainId, inSym, outSym, amount]);

  const label: Record<Status, string> = {
    connecting: 'connecting',
    live: 'streaming',
    stalled: 'quiet',
    closed: 'ended',
  };

  return (
    <Card
      title="Live price"
      meta={
        <Chip tone={status === 'live' ? 'good' : status === 'closed' ? 'mut' : 'warn'}>
          {label[status]}
        </Chip>
      }
    >
      {ticks.length === 0 ? (
        <Empty>Waiting for a block that moves this price.</Empty>
      ) : (
        <div>
          {ticks.map((t, i) => {
            const prev = ticks[i + 1];
            const delta = prev ? BigInt(t.amountOut) - BigInt(prev.amountOut) : 0n;
            return (
              <div className="c-tick" key={`${t.blockNumber}-${t.at}`}>
                <span className={`c-tick-dir ${delta > 0n ? 'up' : delta < 0n ? 'dn' : 'mut'}`}>
                  {prev ? (delta > 0n ? '▲' : delta < 0n ? '▼' : '·') : '·'}
                </span>
                <span className="mono">
                  {sig(BigInt(t.amountOut), tokenOut, 7)} {tokenOut.symbol}
                </span>
                <span className="mono mut">{t.blockNumber}</span>
              </div>
            );
          })}
        </div>
      )}
      <p className="c-empty" style={{ marginTop: 10 }}>
        Only pushed when the price actually changes. This is for watching — the trade form keeps
        its own quote with an expiry, so what you sign never changes under you.
      </p>
    </Card>
  );
}

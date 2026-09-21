'use client';

import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { sig } from '@/lib/format';
import {
  DEMO_MODE,
  demoHoldings,
  demoFills,
  demoPortfolioUsd,
  agoLabel,
  usd,
} from '@/lib/demo';
import { Card, Chip, Empty } from './ui';

/**
 * Portfolio and fill history.
 *
 * Renders only in a demo build (`NEXT_PUBLIC_DEMO_MODE=1`) and only while no
 * wallet is connected. Both conditions matter: the first keeps sample data out
 * of a normal deployment, and the second means a real account is never shown a
 * balance that is not its own — the moment a wallet connects, this panel is gone
 * and the app is back to reading the chain.
 *
 * The `sample` chip in each header is not decoration. These are invented figures
 * on a page that swaps real money, and the project already states what it is
 * elsewhere (see `Disclaimer`); a populated portfolio with nothing marking it as
 * illustrative would be the one dishonest surface in the interface.
 */
export function AccountPanel() {
  const { isConnected } = useAccount();

  // Ages tick forward from mount rather than from a wall-clock read at render:
  // the server and the first client pass both draw zero, so hydration matches,
  // and the list starts moving a second later.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setElapsed((e) => e + 1), 1_000);
    return () => clearInterval(id);
  }, []);

  if (!DEMO_MODE || isConnected) return null;

  const holdings = demoHoldings();
  const fills = demoFills();
  const total = demoPortfolioUsd(holdings);

  return (
    <>
      <Card title="Balances" meta={<Chip tone="mut">sample</Chip>}>
        <div className="c-total">
          <span className="c-total-value mono">{usd(total)}</span>
          <span className="c-total-label">across {holdings.length} positions</span>
        </div>
        <div className="c-holdings">
          {holdings.map((h) => (
            <div className="c-holding" key={h.token.symbol}>
              <span className="c-holding-sym">{h.token.symbol}</span>
              <span className="mono">{sig(h.amount, h.token, 6)}</span>
              <span className="mono mut">{usd(h.usd)}</span>
            </div>
          ))}
        </div>
        <p className="c-empty" style={{ marginTop: 10 }}>
          Illustrative holdings, shown because no wallet is connected. Connect one and this panel
          is replaced by balances read from the chain.
        </p>
      </Card>

      <Card title="Recent trades" meta={<Chip tone="mut">sample</Chip>}>
        {fills.length === 0 ? (
          <Empty>No fills yet.</Empty>
        ) : (
          <div>
            {fills.map((f) => (
              <div className="c-fill" key={f.txHash}>
                <span className="c-fill-pair">
                  {f.inSym} <span className="mut">→</span> {f.outSym}
                </span>
                <span className="mono">
                  {f.amountIn} <span className="mut">for</span> {f.amountOut}
                </span>
                <span className="c-fill-edge mono">+{f.edgeBps.toFixed(1)} bp</span>
                <span className="mono mut">{agoLabel(f.agoSeconds + elapsed)}</span>
              </div>
            ))}
          </div>
        )}
        <p className="c-empty" style={{ marginTop: 10 }}>
          Illustrative fills. Edge is measured against the best single-venue route; the range here
          matches what the solver actually produced in{' '}
          <a href="/backtest">the published backtest</a>.
        </p>
      </Card>
    </>
  );
}

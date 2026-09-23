'use client';

import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { canonical } from '@/lib/assets';
import { CHAINS, type ChainKey } from '@/lib/chain';
import { Card, Chip, Empty } from './ui';

/**
 * The same trade, priced on the other two chains.
 *
 * A quote is only the best answer available on the chain the user happens to be
 * standing on. This asks the question they cannot ask by hand: with the money
 * where it is now, is one of the other chains better *after* paying to get
 * there? The crossing takes its cut before the pool sees the money, so a chain
 * that quotes better can still lose — which is exactly why both halves are
 * priced together rather than shown as two numbers to subtract.
 *
 * Shown only when buying an asset with the chain's dollar, and only when the
 * asset is listed in more than one place. Selling an asset for dollars is not
 * the same question: the asset would have to be bridged first, and that is a
 * different trade with a different quote.
 */
type Plan = {
  chain: ChainKey;
  unitsOut: number;
  effectivePriceUsd: number;
  venue: string;
  etaSeconds: number;
  bridge: { costBps: number; etaSeconds: number } | null;
  unavailable?: string;
};

export function CrossChainCard({
  chain,
  inSym,
  outSym,
  amount,
}: {
  chain: ChainKey;
  inSym: string;
  outSym: string;
  amount: string;
}) {
  const { address } = useAccount();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [edgeBps, setEdgeBps] = useState(0);
  const [loading, setLoading] = useState(false);

  const asset = canonical(outSym);
  const buyingWithDollar = inSym === CHAINS[chain].usd.symbol;
  const usd = Number(amount);
  const askable = buyingWithDollar && Number.isFinite(usd) && usd > 0;

  useEffect(() => {
    if (!askable) {
      setPlans(null);
      return;
    }
    const ctrl = new AbortController();
    // The bridge is quoted live on the other side of this, so it waits for the
    // typing to stop rather than pricing every keystroke.
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const q = new URLSearchParams({ asset, from: chain, usd: String(usd) });
        if (address) q.set('wallet', address);
        const res = await fetch(`/api/plan?${q}`, { signal: ctrl.signal });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { plans: Plan[]; edgeBps: number };
        setPlans(data.plans);
        setEdgeBps(data.edgeBps);
      } catch {
        // A comparison that cannot be drawn is not an error worth shouting
        // about: the quote above it is still good.
        if (!ctrl.signal.aborted) setPlans(null);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 600);
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [asset, chain, usd, address, askable]);

  if (!askable) return null;
  const priced = plans?.filter((p) => !p.unavailable) ?? [];
  if (!loading && priced.length < 2) return null;

  const best = priced[0];
  const elsewhere = best && best.chain !== chain;

  return (
    <Card
      title="Where to buy"
      meta={priced.length > 1 ? `${priced.length} chains priced` : undefined}
    >
      {loading && !plans ? (
        <Empty>Pricing {asset} on every chain that lists it…</Empty>
      ) : (
        <>
          <div className="c-scroll">
            <table className="c-table">
              <thead>
                <tr>
                  <th>Chain</th>
                  <th className="num">{asset} received</th>
                  <th className="num">All-in price</th>
                  <th className="num">Crossing</th>
                  <th>Venue</th>
                </tr>
              </thead>
              <tbody>
                {plans?.map((p) => (
                  <tr key={p.chain}>
                    <td>
                      {CHAINS[p.chain].name}
                      {p.chain === chain ? <span className="c-empty"> · here</span> : null}
                    </td>
                    <td className={`num mono ${p === best ? 'up' : ''}`}>
                      {p.unavailable ? '—' : p.unitsOut.toPrecision(6)}
                    </td>
                    <td className="num mono">
                      {p.unavailable ? '—' : `$${p.effectivePriceUsd.toFixed(2)}`}
                    </td>
                    <td className="num mono">
                      {p.unavailable ? '—' : p.bridge ? `${p.bridge.costBps.toFixed(0)}bp · ${p.bridge.etaSeconds}s` : 'none'}
                    </td>
                    <td className="mono">{p.unavailable ?? p.venue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {elsewhere ? (
            <p style={{ marginTop: 12 }}>
              <Chip tone="good">{edgeBps.toFixed(0)}bp better</Chip>{' '}
              on {CHAINS[best.chain].name}, after paying {best.bridge?.costBps.toFixed(0) ?? 0}bp to
              cross. Switch the chain in the masthead to trade it there; the crossing itself is a
              bridge deposit you sign, and nothing here sends it for you.
            </p>
          ) : (
            <p className="c-empty" style={{ marginTop: 12 }}>
              This chain is already the best of the {priced.length} priced, before counting the cost
              of crossing to the others.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

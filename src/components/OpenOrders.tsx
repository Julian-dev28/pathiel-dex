'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAccount, useSignTypedData } from 'wagmi';
import { openOrders, type OpenOrder } from '@/lib/perp-orders';
import { explainExchangeError, prepareCancel, submitOrder } from '@/lib/perp-browser';
import { useTradingAccount } from './AccountProvider';
import { Card, Chip, Empty, ErrorNote, Loading } from './ui';

/**
 * Orders still sitting in the book, and a way to take them back.
 *
 * A limit order here is `Gtc` — it rests until it fills or it is cancelled — and
 * this app would place one and then offer no way to cancel it, which left the
 * customer's only recourse in somebody else's interface for an order this app
 * had signed.
 *
 * Signed the same way the order was: by the trading account when it is unlocked,
 * by the wallet otherwise. A cancel the exchange will accept has to come from
 * whoever owns the order, so the two paths cannot differ.
 */
const usd = (v: number) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

export function OpenOrders() {
  const { address: wallet } = useAccount();
  const { account: signer } = useTradingAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const address = signer?.address ?? wallet;

  const [orders, setOrders] = useState<OpenOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<number | null>(null);

  const read = useCallback(() => {
    if (!address) {
      setOrders(null);
      return;
    }
    openOrders(address)
      .then((o) => {
        setOrders(o);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'could not read your open orders'));
  }, [address]);

  useEffect(read, [read]);

  const cancel = async (order: OpenOrder) => {
    setCancelling(order.oid);
    setError(null);
    try {
      const prepared = prepareCancel(order);
      const signature = signer
        ? await signer.signTypedData(
            prepared.typedData as unknown as Parameters<typeof signer.signTypedData>[0],
          )
        : await signTypedDataAsync(
            prepared.typedData as unknown as Parameters<typeof signTypedDataAsync>[0],
          );
      await submitOrder(prepared.finalize(signature));
      // Re-read rather than removing it here: the exchange decides whether it is
      // gone, and an order that filled in the meantime was never cancelled.
      read();
    } catch (e) {
      setError(
        e instanceof Error ? explainExchangeError(e.message.split('\n')[0]) : 'the cancel failed',
      );
    } finally {
      setCancelling(null);
    }
  };

  if (!address) return null;

  return (
    <Card
      title="Resting orders"
      meta={
        orders === null ? undefined : (
          <Chip tone={orders.length > 0 ? 'accent' : 'mut'}>
            {orders.length} in the book
          </Chip>
        )
      }
    >
      {error && <ErrorNote onRetry={read}>{error}</ErrorNote>}
      {orders === null && !error && <Loading rows={2} />}

      {orders !== null && orders.length === 0 && (
        <Empty>
          Nothing resting. A market order fills or fails immediately and never appears here; a limit
          order sits in the book until it fills or you cancel it below.
        </Empty>
      )}

      {orders !== null && orders.length > 0 && (
        <div className="c-scroll">
          <table className="c-table">
            <thead>
              <tr>
                <th>Market</th>
                <th>Side</th>
                <th className="num">Left</th>
                <th className="num">Limit</th>
                <th className="num">Placed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={`${o.dex}:${o.oid}`}>
                  <td className="mono">
                    {o.symbol} <Chip tone={o.dex ? 'accent' : 'mut'}>{o.dex || 'core'}</Chip>
                    {o.reduceOnly && <Chip tone="mut">reduce only</Chip>}
                  </td>
                  <td className={o.side === 'buy' ? 'up' : 'dn'}>{o.side}</td>
                  <td className="num mono">
                    {o.sizeLeft}
                    {o.origSize !== o.sizeLeft && <span className="mut"> of {o.origSize}</span>}
                  </td>
                  <td className="num mono">{usd(o.limitUsd)}</td>
                  <td className="num mono">
                    {o.placedAt > 0 ? new Date(o.placedAt).toLocaleTimeString() : '—'}
                  </td>
                  <td className="num">
                    <button
                      className="c-ghost"
                      type="button"
                      disabled={cancelling !== null}
                      onClick={() => void cancel(o)}
                    >
                      {cancelling === o.oid ? 'Cancelling…' : 'Cancel'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

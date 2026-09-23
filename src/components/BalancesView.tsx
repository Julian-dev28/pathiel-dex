'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { CHAIN_LIST, CHAINS } from '@/lib/chain';
import { sig, addr } from '@/lib/format';
import type { AccountBalances, PerpAccount } from '@/lib/balances';
import { Card, Answer, Answers, Chip, Empty, ErrorNote, Loading, PageHead, Reveal } from './ui';

/**
 * The account, in one place.
 *
 * Nothing here is invented and nothing here is priced. Two kinds of number
 * share the page and they are not the same kind of fact, so each card says
 * which it is: a spot balance is chain state, read from the token contract;
 * the perp margin is Hyperliquid's ledger entry for this address on a venue
 * somebody else operates. Adding them into one portfolio total would quietly
 * assert that they are interchangeable, so there is no total.
 *
 * With no wallet connected the page says so and stops. An account view is the
 * last place in this product where a sample number would be acceptable.
 */

const usd = (v: number): string =>
  v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

/** Gas balances only, which never need more than a few decimals. */
const gas = (amount: string): string =>
  Number(amount).toLocaleString('en-US', { maximumFractionDigits: 6 });

const dexName = (dex: string): string => (dex ? `${dex} — equities` : 'core — crypto');

export function BalancesView() {
  const { address, isConnected } = useAccount();
  const [data, setData] = useState<AccountBalances | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  useEffect(() => {
    if (!address) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/balances?address=${address}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `balances: ${res.status}`);
        return body as AccountBalances;
      })
      .then((a) => !cancelled && (setData(a), setError(null)))
      .catch((e) => !cancelled && (setError(e.message), setData(null)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [address, attempt]);

  if (!isConnected || !address) {
    return (
      <>
        <PageHead title="Account" lede="Everything one address holds: spot balances on all three chains, and its Hyperliquid perp margin." />
        <Card title="No wallet connected">
          <Empty>
            Connect a wallet from the masthead and this page reads its balances from each chain.
            Nothing is signed and nothing is sent — it is three <code className="mono">eth_call</code>s
            and one public API request.
          </Empty>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Account"
        lede={`Everything ${addr(address)} holds: spot balances on all three chains, and its Hyperliquid perp margin.`}
      />

      {loading && !data && <Loading rows={4} />}
      {error && <ErrorNote onRetry={retry}>{error}</ErrorNote>}
      {data && <Account data={data} />}
    </>
  );
}

function Account({ data }: { data: AccountBalances }) {
  const { assets, native } = data.spot;
  const chainsHeld = new Set(assets.flatMap((a) => a.holdings.map((h) => h.chain))).size;
  // A chain whose RPC failed holds an unknown amount, not nothing. Counting it
  // among the chains read would make "on 2 of 3" mean two different things,
  // which is the exact claim the errors card below exists to prevent.
  const chainsRead = CHAIN_LIST.filter(
    (c) => !data.errors.some((e) => e.source === c.key),
  ).length;
  const marginUsd = data.perps.accounts.reduce((n, a) => n + a.accountValueUsd, 0);
  const openPositions = data.perps.accounts.reduce((n, a) => n + a.positions.length, 0);

  return (
    <>
      <Card title="Across everything" step={1}>
        <Answers>
          <Answer
            label="Assets held"
            value={assets.length}
            size="xl"
            note={
              chainsRead === CHAIN_LIST.length
                ? `on ${chainsHeld} of ${CHAIN_LIST.length} chains`
                : `on ${chainsHeld} of the ${chainsRead} chains that answered`
            }
          />
          <Answer
            label="Perp margin"
            value={usd(marginUsd)}
            unit="USDC"
            tone="mut"
            note={`${openPositions} open position${openPositions === 1 ? '' : 's'} on Hyperliquid`}
          />
        </Answers>
        <Reveal summary="Why is there no portfolio total?">
          <p>
            Two different kinds of number share this page. A spot balance is chain state: the token
            contract says this address owns that much, and anyone can check it. The perp margin is
            Hyperliquid&rsquo;s ledger entry for an account on a venue a third party operates, already
            denominated in USDC by them.
          </p>
          <p>
            Adding them would also need a price for every token on every chain — a quote per listing,
            per chain, on every page load — and a portfolio value quoted from thin pools is a number
            you could not sell at. Balances are stated as balances instead.
          </p>
        </Reveal>
      </Card>

      {data.errors.length > 0 && (
        <Card title="Sources that did not answer" tone="warn">
          <ul className="c-list">
            {data.errors.map((e) => (
              <li key={e.source}>
                <span className="mono">{e.source}</span>
                <span className="mono">{e.message}</span>
              </li>
            ))}
          </ul>
          <p className="c-empty" style={{ marginTop: 10 }}>
            Named rather than skipped: a chain whose RPC failed reads exactly like an address
            holding nothing on it.
          </p>
        </Card>
      )}

      <Card
        title="Spot balances"
        step={2}
        meta={<Chip tone="good">read from chain state</Chip>}
      >
        {assets.length === 0 ? (
          <Empty>No balance of any listed token, on any of the three chains.</Empty>
        ) : (
          <div className="c-scroll">
            <table className="c-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Chain</th>
                  <th>Listed as</th>
                  <th className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {assets.flatMap((a) =>
                  a.holdings.map((h, i) => (
                    <tr key={`${h.chain}-${h.token.address}`}>
                      {i === 0 && <td rowSpan={a.holdings.length}>{a.asset}</td>}
                      <td className="mut">{CHAINS[h.chain].name}</td>
                      <td className="mono">{h.token.symbol}</td>
                      <td className="num mono">{sig(BigInt(h.raw), h.token, 6)}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}

        <ul className="c-list">
          {native.map((n) => (
            <li key={n.chain}>
              <span className="mut">{CHAINS[n.chain].name} gas</span>
              <span className="mono">
                {gas(n.amount)} {n.symbol}
              </span>
            </li>
          ))}
        </ul>
        <p className="c-empty" style={{ marginTop: 10 }}>
          One asset, one row: NVDA on Robinhood Chain, NVDAc on Base and wNVDAx on X Layer are the
          same company in three wrappers. Tokens with a zero balance are left out.
        </p>
      </Card>

      <Card
        title="Perp margin"
        step={3}
        meta={<Chip tone="warn">Hyperliquid</Chip>}
      >
        {data.perps.accounts.map((a, i) => (
          <PerpDex key={a.dex || 'core'} account={a} divider={i > 0} />
        ))}
        <p className="c-empty" style={{ marginTop: 10 }}>
          Margin is denominated in USDC by Hyperliquid. The equities trade in the{' '}
          <code className="mono">xyz</code> HIP-3 dex, a separate namespace from the core
          universe — an account can be funded on one and empty on the other.
        </p>
      </Card>
    </>
  );
}

function PerpDex({ account, divider }: { account: PerpAccount; divider: boolean }) {
  return (
    <div className={divider ? 'c-secondary' : undefined}>
      <Answers>
        <Answer label={`Account value · ${dexName(account.dex)}`} value={usd(account.accountValueUsd)} size="sm" />
        <Answer label="Margin used" value={usd(account.marginUsedUsd)} size="sm" tone="mut" />
        <Answer label="Withdrawable" value={usd(account.withdrawableUsd)} size="sm" tone="mut" />
      </Answers>

      {account.positions.length === 0 ? (
        <Empty>No open positions on {dexName(account.dex)}.</Empty>
      ) : (
        <div className="c-scroll">
          <table className="c-table">
            <thead>
              <tr>
                <th>Market</th>
                <th>Side</th>
                <th className="num">Size</th>
                <th className="num">Entry</th>
                <th className="num">Value</th>
                <th className="num">Unrealised</th>
                <th className="num">Lev</th>
              </tr>
            </thead>
            <tbody>
              {account.positions.map((p) => (
                <tr key={p.symbol}>
                  <td className="mono">{p.symbol}</td>
                  <td className={p.size > 0 ? 'up' : 'dn'}>{p.size > 0 ? 'long' : 'short'}</td>
                  <td className="num mono">{Math.abs(p.size)}</td>
                  <td className="num mono">{usd(p.entryUsd)}</td>
                  <td className="num mono">{usd(p.valueUsd)}</td>
                  <td className={`num mono ${p.unrealizedPnlUsd >= 0 ? 'up' : 'dn'}`}>
                    {usd(p.unrealizedPnlUsd)}
                  </td>
                  <td className="num mono">{p.leverage}×</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

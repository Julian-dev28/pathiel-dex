'use client';

import { useEffect, useState } from 'react';
import { useAccount, useConfig, useSendTransaction, useSignMessage } from 'wagmi';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { CHAINS, CHAIN_LIST, type ChainConfig } from '@/lib/chain';
import { addr, sig, toBase } from '@/lib/format';
import type { AccountBalances } from '@/lib/balances';
import { ACCOUNT_DISCLOSURES, accountMessage } from '@/lib/account/derive';
import { LEGAL_VERSION } from '@/lib/legal';
import { acceptTerms, acceptedVersion } from '@/lib/terms';
import { GAS_FLOOR, fundGas, fundToken, type AccountStatus } from '@/lib/account/funding';
import { usdOf } from '@/lib/account/plan';
import { useTradingAccount } from './AccountProvider';
import {
  accountStatuses,
  chainToUnfreeze,
  depositSource,
  fundingNote,
  isFrozen,
  unifiedDollars,
  unifiedPositions,
  fundingState,
  landedNote,
  nativeText,
  withdrawalSteps,
  type WithdrawalStep,
} from './trading-account';
import { Card, Answer, Answers, Chip, Empty, ErrorNote, Loading, PageHead, Reveal, Suggest } from './ui';

/**
 * Sign in, fund, withdraw.
 *
 * The whole product rests on one signature, and the thing that signature
 * produces is an account the customer is about to put money into. So the
 * disclosures are not below the fold and not behind a `<Reveal>`: they sit in
 * the same card as the button that derives the account, before there is
 * anything to fund.
 *
 * Two asymmetries are deliberate and visible in the code below. Funding is
 * sent by the owner's wallet — ordinary transfers, one wallet popup each,
 * because that money is still theirs to move. Withdrawing is signed by the
 * derived key with no popup at all, because that is the point of the account.
 * And a withdrawal is several transactions, so the panel tracks which of them
 * landed rather than reporting one verdict for the batch.
 */

/** A withdrawal in flight, and what has left the account so far. */
type Run = {
  chain: ChainConfig;
  steps: WithdrawalStep[];
  done: number;
  busy: boolean;
  error: string | null;
};

const why = (e: unknown): string =>
  e instanceof Error ? e.message.split('\n')[0] : 'the transaction was not sent';

export function TradingAccount() {
  const { address: owner, isConnected } = useAccount();
  const { account, address: derived, unlock, lock } = useTradingAccount();
  const { signMessageAsync } = useSignMessage();
  const { sendTransactionAsync } = useSendTransaction();
  const config = useConfig();

  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);

  const [held, setHeld] = useState<AccountBalances | null>(null);
  const [heldError, setHeldError] = useState<string | null>(null);
  /** What the owner's own wallet holds. Read to answer where a deposit leaves
   *  from, which is not a question the customer should be asked. */
  const [wallet, setWallet] = useState<AccountBalances | null>(null);
  const [reload, setReload] = useState(0);
  const refresh = () => setReload((n) => n + 1);

  const [amount, setAmount] = useState('');
  const [funding, setFunding] = useState(false);
  const [fundError, setFundError] = useState<string | null>(null);
  const [fundHash, setFundHash] = useState<Hex | null>(null);

  const [run, setRun] = useState<Run | null>(null);

  useEffect(() => {
    if (!derived) {
      setHeld(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/balances?address=${derived}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `balances: ${res.status}`);
        return body as AccountBalances;
      })
      .then((b) => !cancelled && (setHeld(b), setHeldError(null)))
      .catch((e) => !cancelled && setHeldError(why(e)));
    return () => {
      cancelled = true;
    };
  }, [derived, reload]);

  // The owner's side of the same read. Failing is not worth reporting: it only
  // costs the deposit card its "you hold X here" note.
  useEffect(() => {
    if (!owner) return;
    let cancelled = false;
    fetch(`/api/balances?address=${owner}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((b) => !cancelled && b && !b.error && setWallet(b as AccountBalances))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [owner, reload]);

  /**
   * Whether this person has accepted the current terms.
   *
   * Read once on mount rather than during render: the value lives in browser
   * storage, and reading it while rendering makes the server and the client
   * disagree about what to draw.
   */
  const [accepted, setAccepted] = useState<string | null>(null);
  useEffect(() => setAccepted(acceptedVersion()), []);
  const termsCurrent = accepted === LEGAL_VERSION;

  if (!isConnected || !owner) {
    return (
      <>
        <PageHead
          title="Trading account"
          lede="One signature from your wallet derives a trading account you fund once and then trade from without another popup."
        />
        <Card title="No wallet connected">
          <Empty>
            Connect a wallet from the masthead. It signs one message, which derives your trading
            account; the funds stay in addresses you control the whole way through.
          </Empty>
        </Card>
      </>
    );
  }

  const onSignIn = async () => {
    setSigning(true);
    setSignError(null);
    try {
      unlock(await signMessageAsync({ message: accountMessage(owner) }));
    } catch (e) {
      setSignError(why(e));
    } finally {
      setSigning(false);
    }
  };

  // The owner's wallet can only be asked for a chain this app configured it
  // with. Withdrawals are unaffected — those are signed here and sent to the
  // chain's own RPC — so the two directions do not have the same reach.
  const reachable = (c: ChainConfig) => config.chains.some((x) => x.id === c.id);

  const fromOwner = async (tx: { to: `0x${string}`; data?: Hex; value?: bigint }, id: number) => {
    setFunding(true);
    setFundError(null);
    setFundHash(null);
    try {
      setFundHash(await sendTransactionAsync({ ...tx, chainId: id }));
      refresh();
    } catch (e) {
      setFundError(why(e));
    } finally {
      setFunding(false);
    }
  };

  /**
   * Empty one chain back to the owner, signed by the derived account.
   *
   * Sequential and awaited per transaction on purpose: the transfers are
   * ordered so the token sends happen while there is still gas to pay for
   * them, and firing them together would let the native sweep land first.
   */
  const onWithdraw = async (cfg: ChainConfig, status: AccountStatus) => {
    if (!account || !owner) return;
    const transport = http(cfg.rpcUrls[0]);
    const pub = createPublicClient({ chain: cfg.viem, transport });
    const wallet = createWalletClient({ account, chain: cfg.viem, transport });
    setRun({ chain: cfg, steps: [], done: 0, busy: true, error: null });
    try {
      const gasPrice = await pub.getGasPrice().catch(() => cfg.fallbackGasWei);
      const steps = withdrawalSteps(cfg, owner, status, gasPrice);
      setRun({ chain: cfg, steps, done: 0, busy: true, error: null });
      for (const step of steps) {
        const hash = await wallet.sendTransaction({
          to: step.transfer.to,
          data: step.transfer.data,
          value: step.transfer.value,
        });
        await pub.waitForTransactionReceipt({ hash });
        setRun((r) => (r ? { ...r, done: r.done + 1 } : r));
      }
      setRun((r) => (r ? { ...r, busy: false } : r));
    } catch (e) {
      setRun((r) => (r ? { ...r, busy: false, error: why(e) } : r));
    }
    refresh();
  };

  if (!derived) {
    return (
      <>
        <PageHead
          title="Trading account"
          lede="One signature from your wallet derives a trading account you fund once and then trade from without another popup."
        />
        <Card title="Sign in to your trading account" step={1}>
          <p className="c-empty">
            Your wallet signs one message. Nothing moves and nothing is sent — the signature itself
            is what produces the account, so the same wallet recreates the same address on any
            device, in any browser, in three years.
          </p>
          <Disclosures />
          <label className="c-ack">
            <input
              type="checkbox"
              checked={termsCurrent}
              onChange={(e) => {
                // Recorded against the version, so raising it asks again
                // rather than leaving someone bound to a document they never
                // saw.
                const version = e.target.checked ? acceptTerms() : null;
                setAccepted(version);
              }}
            />
            <span>
              I have read the <a href="/risk">risk disclosure</a> and accept the{' '}
              <a href="/terms">terms of service</a> and{' '}
              <a href="/privacy">privacy policy</a> (version {LEGAL_VERSION}). I understand this is
              beta software, that the signature below permanently controls the account, and that
              nobody can recover it for me.
            </span>
          </label>
          <button
            className="c-go"
            type="button"
            onClick={onSignIn}
            disabled={signing || !termsCurrent}
          >
            {!termsCurrent
              ? 'Accept the terms to continue'
              : signing
                ? 'Confirm in your wallet…'
                : 'Sign the message and derive my account'}
          </button>
          {signError && <ErrorNote>{signError}</ErrorNote>}
          <Reveal summary="What exactly am I signing?">
            <pre className="mono c-scroll">{accountMessage(owner)}</pre>
            <p>
              The signature is hashed to produce a private key, which is held in this tab&rsquo;s
              memory and written to nothing — no storage, no cookie, no server. Reloading the page
              asks for it again.
            </p>
          </Reveal>
        </Card>
      </>
    );
  }

  const statuses = held
    ? accountStatuses(
        held.spot.native,
        held.spot.assets.flatMap((a) => a.holdings),
      )
    : null;

  // The account as the customer holds it: one dollar balance and a list of
  // positions. The per-chain split is a fact about the plumbing and lives below.
  const dollars = held ? unifiedDollars(held.spot.assets.flatMap((a) => a.holdings)) : null;
  const positions = held ? unifiedPositions(held.spot.assets) : [];
  const frozen = statuses !== null && isFrozen(statuses);
  // Where the dollars are: unfreezing a chain holding nothing changes nothing.
  const unfreeze = statuses ? CHAINS[chainToUnfreeze(statuses)] : null;

  // Where a deposit leaves from is read, not asked: the wallet holds dollars
  // somewhere, and once they are in the trading account the router moves them
  // to whichever chain the trade wants.
  const source = depositSource(
    wallet?.spot.assets.flatMap((a) => a.holdings) ?? [],
    config.chains.map((c) => c.id).flatMap((id) => {
      const match = CHAIN_LIST.find((c) => c.id === id);
      return match ? [match.key] : [];
    }),
  );
  const amountIn = source ? toBase(amount, source.token) : 0n;
  const short = source !== null && amountIn > source.balance;
  // A deposit of dollars into an account that cannot sign anything leaves the
  // customer holding money they cannot trade, so the first deposit to a chain
  // carries gas with it. After that the router buys its own.
  const gasWith =
    source && statuses?.find((st) => st.chain === source.chain.key)?.canTrade === false
      ? GAS_FLOOR[source.chain.key]
      : 0n;

  const fundLabel = (): string => {
    if (!source) return 'No configured chain to send from';
    if (funding) return 'Confirm in your wallet…';
    if (amountIn <= 0n) return 'Enter an amount to deposit';
    if (short) return `Your wallet holds ${sig(source.balance, source.token, 2)} ${source.token.symbol}`;
    return gasWith > 0n
      ? `Deposit ${amount} ${source.token.symbol} and a little ${source.chain.viem.nativeCurrency.symbol}`
      : `Deposit ${amount} ${source.token.symbol} from ${source.chain.name}`;
  };

  /**
   * The deposit: dollars, and gas if the account has none there yet.
   *
   * Two transactions and so two wallet prompts, sent in that order — the gas
   * first would leave someone who declines the second with gas and nothing to
   * trade, which is the less useful half.
   */
  const onDeposit = async () => {
    if (!source) return;
    await fromOwner(fundToken(source.chain, source.token, derived, amountIn), source.chain.id);
    if (gasWith > 0n) {
      await fromOwner(fundGas(source.chain, derived, gasWith), source.chain.id);
    }
    refresh();
  };

  return (
    <>
      <PageHead
        title="Trading account"
        lede={`${addr(derived)} — derived from your signature, funded by you, emptied back to you whenever you ask.`}
      />

      <Card title="Your trading account" step={1} meta={<Chip tone="good">unlocked in this tab</Chip>}>
        <Answers>
          <Answer
            label="Send funds to"
            value={<span className="mono">{addr(derived)}</span>}
            size="lg"
            note="The same address on Robinhood Chain, Base and X Layer, and your Hyperliquid account."
          />
        </Answers>
        <p className="mono c-empty">{derived}</p>
        <Disclosures />
        <div className="c-guarantee">
          <span>
            Signing out forgets the key held in this tab and nothing else. The account keeps every
            token in it, and signing the same message again brings you back to the same address.
          </span>
          <button className="c-ghost" type="button" onClick={lock}>
            Sign out
          </button>
        </div>
      </Card>

      <Card
        title="What the account holds"
        step={2}
        meta={
          dollars === null ? undefined : (
            <Chip tone={dollars > 0n ? 'good' : 'mut'}>${usdOf(dollars).toFixed(2)} to trade with</Chip>
          )
        }
      >
        {heldError && <ErrorNote onRetry={refresh}>{heldError}</ErrorNote>}
        {!statuses && !heldError && <Loading rows={3} />}

        {dollars !== null && (
          <Answers>
            <Answer
              label="Dollars"
              value={`$${usdOf(dollars).toFixed(2)}`}
              size="xl"
              tone={dollars > 0n ? 'good' : 'mut'}
              note="One balance. The router spends it from whichever chain the trade needs, crossing and buying its own gas on the way."
            />
            <Answer
              label="Positions"
              value={positions.length}
              note={
                positions.length === 0
                  ? 'nothing held yet'
                  : positions
                      .slice(0, 4)
                      .map((p) => `${p.total.toPrecision(4)} ${p.asset}`)
                      .join(', ')
              }
            />
          </Answers>
        )}

        {positions.length > 0 && (
          <ul className="c-list">
            {positions.map((p) => (
              <li key={p.asset}>
                <span>
                  {p.asset}{' '}
                  {p.chains.length > 1 && <Chip tone="mut">{p.chains.length} chains</Chip>}
                </span>
                <span className="mono">{p.total.toPrecision(6)}</span>
              </li>
            ))}
          </ul>
        )}

        {frozen && (
          <Suggest
            tone="warn"
            action={
              unfreeze && reachable(unfreeze)
                ? `Send ${nativeText(GAS_FLOOR[unfreeze.key], unfreeze.viem.nativeCurrency.symbol)} on ${unfreeze.name}`
                : undefined
            }
            onAction={
              unfreeze && reachable(unfreeze)
                ? () => void fromOwner(fundGas(unfreeze, derived, GAS_FLOOR[unfreeze.key]), unfreeze.id)
                : undefined
            }
          >
            <strong>This account cannot sign anything yet.</strong> It holds dollars but no native
            currency on any chain, and every transaction — including the one that would buy itself
            gas — has to be paid for somewhere. Send it a little once, and from then on the router
            buys its own gas on the other chains out of these dollars.
          </Suggest>
        )}

        <Reveal summary="Chain by chain, and sending it all back">
          <p>
            One account, three chains. What is below is the plumbing: which chain each balance
            happens to sit on, whether that chain can pay for its own transactions, and a way to
            empty each one back to your wallet. Nothing here has to be managed to trade — the router
            reads it and decides.
          </p>
          {statuses &&
            statuses.map((status, i) => {
              const cfg = CHAINS[status.chain];
              const native = cfg.viem.nativeCurrency.symbol;
              const state = fundingState(status);
              return (
                <div key={status.chain} className={i > 0 ? 'c-secondary' : undefined}>
                  <Answers>
                    <Answer
                      label={`${cfg.name} — gas`}
                      value={nativeText(status.nativeBalance, native)}
                      size="sm"
                      tone={state === 'ready' ? 'good' : state === 'empty' ? 'mut' : 'warn'}
                      note={fundingNote(status, native)}
                    />
                  </Answers>

                  {status.tokens.length > 0 && (
                    <ul className="c-list">
                      {status.tokens.map((t) => (
                        <li key={t.token.address}>
                          <span className="mut">{t.token.symbol}</span>
                          <span className="mono">{sig(t.balance, t.token, 6)}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {(status.tokens.length > 0 || status.nativeBalance > 0n) && (
                    <button
                      className="c-ghost"
                      type="button"
                      onClick={() => onWithdraw(cfg, status)}
                      disabled={run?.busy}
                    >
                      Send everything on {cfg.name} back to {addr(owner)}
                    </button>
                  )}

                  {run?.chain.key === status.chain && run.steps.length > 0 && (
                    <div className={`c-tx${run.error || run.busy ? '' : ' ok'}`}>
                      <span>
                        {run.busy
                          ? `Sending ${Math.min(run.done + 1, run.steps.length)} of ${run.steps.length}…`
                          : run.error
                            ? 'The withdrawal stopped partway'
                            : '✓ Sent everything back'}
                      </span>
                      <span className="mono">{landedNote(run.steps, run.done)}</span>
                    </div>
                  )}
                  {run?.chain.key === status.chain && run.error && <ErrorNote>{run.error}</ErrorNote>}
                </div>
              );
            })}
        </Reveal>

        {held && held.errors.length > 0 && (
          <p className="c-empty" style={{ marginTop: 10 }}>
            {held.errors.map((e) => e.source).join(', ')} did not answer. A chain that did not
            answer reads exactly like one holding nothing, so treat this total as a floor rather
            than a balance.
          </p>
        )}
      </Card>

      <Card title="Deposit dollars" step={3} meta={<Chip tone="mut">from {addr(owner)}</Chip>}>
        <p className="c-empty">
          An ordinary transfer from your wallet to the address above. Nothing here takes custody of
          it: it lands in an account only your signature can derive. You do not pick a chain — it
          leaves from wherever your wallet holds dollars, and from there the router moves them to
          whichever chain a trade turns out to want, buying the gas it needs on the way.
        </p>

        {source && (
          <Answers>
            <Answer
              label="Leaving from"
              value={source.chain.name}
              size="sm"
              note={`Your wallet holds ${sig(source.balance, source.token, 2)} ${source.token.symbol} there${source.balance === 0n ? ' — the most of any chain this page can send from' : ''}.`}
              tone={source.balance > 0n ? 'good' : 'mut'}
            />
          </Answers>
        )}

        <div className="c-slot-label" style={{ marginTop: 14 }}>
          Amount
        </div>
        <div className="c-field">
          <input
            className="c-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            aria-label="Dollars to deposit into the trading account"
          />
          <span className="mono">{source?.token.symbol ?? 'USD'}</span>
        </div>

        <button
          className="c-go"
          type="button"
          onClick={() => void onDeposit()}
          disabled={!source || funding || amountIn <= 0n || short}
        >
          {fundLabel()}
        </button>

        {gasWith > 0n && source && (
          <p className="c-empty" style={{ marginTop: 10 }}>
            Two prompts, not one: the dollars, then{' '}
            {nativeText(gasWith, source.chain.viem.nativeCurrency.symbol)} so the account can pay for
            its first transaction. It only happens once — after that the router buys its own gas on
            every chain out of the dollars you deposited.
          </p>
        )}

        {fundError && <ErrorNote>{fundError}</ErrorNote>}
        {fundHash && source && (
          <div className="c-tx ok">
            <span>✓ Sent</span>
            <a
              className="mono"
              href={`${source.chain.explorer}/tx/${fundHash}`}
              target="_blank"
              rel="noreferrer"
            >
              {addr(fundHash)}
            </a>
          </div>
        )}
        <Reveal summary="What if my dollars are on a chain this page cannot send from?">
          <p>
            Send them to the address above from your wallet directly — it is the same address on
            every chain here. Withdrawing works from all of them regardless: that is signed by the
            account itself rather than by your wallet, so it does not depend on what this page can
            ask your wallet for.
          </p>
        </Reveal>
      </Card>

    </>
  );
}

/** The three things somebody must have read before they fund this. */
const Disclosures = () => (
  <ul className="c-list">
    {ACCOUNT_DISCLOSURES.map((d) => (
      <li key={d}>
        <span>{d}</span>
      </li>
    ))}
  </ul>
);

'use client';

import { useEffect, useState } from 'react';
import {
  useAccount,
  useChainId,
  useConfig,
  useSendTransaction,
  useSignMessage,
  useSwitchChain,
} from 'wagmi';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { CHAINS, type ChainConfig } from '@/lib/chain';
import { addr, sig, toBase } from '@/lib/format';
import type { AccountBalances } from '@/lib/balances';
import { ACCOUNT_DISCLOSURES, accountMessage } from '@/lib/account/derive';
import { fundGas, fundToken, type AccountStatus } from '@/lib/account/funding';
import { useChain } from './ChainProvider';
import { useTradingAccount } from './AccountProvider';
import {
  accountStatuses,
  fundingNote,
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
  const { chain } = useChain();
  const walletChainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const config = useConfig();

  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);

  const [held, setHeld] = useState<AccountBalances | null>(null);
  const [heldError, setHeldError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const refresh = () => setReload((n) => n + 1);

  const [symbol, setSymbol] = useState('');
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
          <button className="c-go" type="button" onClick={onSignIn} disabled={signing}>
            {signing ? 'Confirm in your wallet…' : 'Sign the message and derive my account'}
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

  const token = chain.tokens.find((t) => t.symbol === symbol) ?? chain.usd;
  const amountIn = toBase(amount, token);
  const wrongChain = walletChainId !== chain.id;
  const canFund = reachable(chain);

  const fundLabel = (): string => {
    if (!canFund) return `This page cannot ask your wallet for ${chain.name}`;
    if (wrongChain) return `Switch your wallet to ${chain.name}`;
    if (funding) return 'Confirm in your wallet…';
    if (amountIn <= 0n) return 'Enter an amount to send';
    return `Send ${amount} ${token.symbol} to ${addr(derived)}`;
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

      <Card title="What the account holds" step={2}>
        {heldError && <ErrorNote onRetry={refresh}>{heldError}</ErrorNote>}
        {!statuses && !heldError && <Loading rows={3} />}
        {statuses &&
          statuses.map((status, i) => {
            const cfg = CHAINS[status.chain];
            const native = cfg.viem.nativeCurrency.symbol;
            const state = fundingState(status);
            const stranded = state === 'needs-gas';
            return (
              <div key={status.chain} className={i > 0 ? 'c-secondary' : undefined}>
                <Answers>
                  <Answer
                    label={`${cfg.name} — gas`}
                    value={nativeText(status.nativeBalance, native)}
                    size="sm"
                    tone={state === 'ready' ? 'good' : state === 'empty' ? 'mut' : 'bad'}
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

                {stranded && (
                  <Suggest
                    tone="warn"
                    action={
                      !reachable(cfg)
                        ? undefined
                        : walletChainId !== cfg.id
                          ? `Switch to ${cfg.name}`
                          : `Send ${nativeText(status.shortfall, native)}`
                    }
                    onAction={
                      !reachable(cfg)
                        ? undefined
                        : walletChainId !== cfg.id
                          ? () => switchChain({ chainId: cfg.id })
                          : () => fromOwner(fundGas(cfg, derived, status.shortfall), cfg.id)
                    }
                  >
                    <strong>This account cannot move anything on {cfg.name}.</strong> Every
                    transfer and every trade costs {native}, and it holds{' '}
                    {nativeText(status.nativeBalance, native)}. Until that is topped up, a trade
                    here would be rejected by the chain rather than by this page.
                  </Suggest>
                )}

                {(status.tokens.length > 0 || status.nativeBalance > 0n) && (
                  <button
                    className="c-ghost"
                    type="button"
                    onClick={() => onWithdraw(cfg, status)}
                    disabled={run?.busy}
                  >
                    Send everything back to {addr(owner)}
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

        {held && held.errors.length > 0 && (
          <p className="c-empty" style={{ marginTop: 10 }}>
            {held.errors.map((e) => e.source).join(', ')} did not answer. A chain that did not
            answer reads exactly like one holding nothing, so treat those rows as unknown rather
            than empty.
          </p>
        )}
      </Card>

      <Card
        title={`Move money in — ${chain.name}`}
        step={3}
        meta={<Chip tone="mut">from {addr(owner)}</Chip>}
      >
        <p className="c-empty">
          An ordinary transfer from your wallet to the address above, on the chain selected in the
          masthead. Nothing here takes custody of it: it lands in an account only your signature
          can derive.
        </p>

        <div className="c-slot-label">Token</div>
        <div className="c-controls">
          <select
            className="c-input"
            value={token.symbol}
            onChange={(e) => setSymbol(e.target.value)}
            aria-label={`Token to send to the trading account on ${chain.name}`}
          >
            {chain.tokens.map((t) => (
              <option key={t.address} value={t.symbol}>
                {t.symbol} — {t.name}
              </option>
            ))}
          </select>
        </div>

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
            aria-label={`Amount of ${token.symbol} to send`}
          />
          <span className="mono">{token.symbol}</span>
        </div>

        <button
          className="c-go"
          type="button"
          onClick={() =>
            wrongChain
              ? switchChain({ chainId: chain.id })
              : fromOwner(fundToken(chain, token, derived, amountIn), chain.id)
          }
          disabled={!canFund || funding || (!wrongChain && amountIn <= 0n)}
        >
          {fundLabel()}
        </button>

        {!canFund && (
          <p className="c-empty" style={{ marginTop: 10 }}>
            Send to the address above from your wallet directly instead. Withdrawing from{' '}
            {chain.name} still works here — that is signed by the account itself, not by your
            wallet.
          </p>
        )}
        {fundError && <ErrorNote>{fundError}</ErrorNote>}
        {fundHash && (
          <div className="c-tx ok">
            <span>✓ Sent</span>
            <a className="mono" href={`${chain.explorer}/tx/${fundHash}`} target="_blank" rel="noreferrer">
              {addr(fundHash)}
            </a>
          </div>
        )}
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

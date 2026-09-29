'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useAccount,
  usePublicClient,
  useSendTransaction,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useChainId,
} from 'wagmi';
import { useQuery } from '@tanstack/react-query';
import { formatUnits } from 'viem';
import { CHAINS, CHAIN_LIST, type ChainKey, type Token } from '@/lib/chain';
import { canonical } from '@/lib/assets';
import { client } from '@/lib/quote';
import { fetchQuote, type QuoteResponse, type ApiVenue } from '@/lib/api';
import { toBase, fromBase, sig, bps, addr } from '@/lib/format';
import { buildSwap, approvalTx, approvalLabel, pendingApprovals, minOut, ERC20 } from '@/lib/execute';
import { TokenSelect } from './TokenSelect';
import { RoutePath } from './RoutePath';
import { useTradingAccount } from './AccountProvider';
import { swapFromAccount, TradeError, type SentStep } from '@/lib/account/trade';
import { AccountPanel } from './AccountPanel';
import {
  Card,
  Answer,
  Answers,
  Reveal,
  Chip,
  Suggest,
  Empty,
  ErrorNote,
  Loading,
  Segmented,
} from './ui';

const SLIPPAGE_CHOICES = [10, 30, 50, 100];
const HIGH_IMPACT_BPS = -300;
const SEVERE_IMPACT_BPS = -1_000;

function impactBps(v: ApiVenue | undefined): number | null {
  if (!v || v.rungs.length < 2) return null;
  const first = v.rungs[0];
  const last = v.rungs[v.rungs.length - 1];
  if (first.amountIn === 0n || last.amountIn === 0n) return null;
  const pxSmall = Number(first.amountOut) / Number(first.amountIn);
  const pxFull = Number(last.amountOut) / Number(last.amountIn);
  if (!Number.isFinite(pxSmall) || pxSmall === 0) return null;
  return ((pxFull - pxSmall) / pxSmall) * 10_000;
}

/**
 * An asset as the ticket offers it: one entry however many chains list it.
 *
 * Each chain's own dollar folds into `USD`, because "sell ETH for dollars" is
 * the question and which issuer's dollar a chain happens to use is the
 * router's business. Other tokens fold by `canonical`, so NVDA, NVDAc and
 * wNVDAx are one choice.
 */
type SwapAsset = { key: string; display: Token; byChain: Partial<Record<ChainKey, Token>> };

function swapAssets(): SwapAsset[] {
  const byKey = new Map<string, SwapAsset>();
  for (const chain of CHAIN_LIST) {
    for (const token of chain.tokens) {
      const key = token.address === chain.usd.address ? 'USD' : canonical(token.symbol);
      const entry = byKey.get(key) ?? {
        key,
        display: { ...token, symbol: key, name: key === 'USD' ? 'US dollar' : token.name },
        byChain: {},
      };
      // First listing on a chain wins: the chain tables list the main token
      // for an asset (WETH before xETH) ahead of its alternatives.
      entry.byChain[chain.key] ??= token;
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()];
}

const ASSETS = swapAssets();
const ASSET = new Map(ASSETS.map((a) => [a.key, a]));
const DISPLAY_TOKENS = ASSETS.map((a) => a.display);

/** One way to fill the trade: a chain, then a venue on it. */
type RouteOption = {
  chain: ChainKey;
  quote: QuoteResponse;
  venue: ApiVenue;
  /** What it pays at full size, in the output token's base units. */
  out: bigint;
  /** The same, as a number, so chains with different decimals compare. */
  outNum: number;
};

/** What `/api/analyze` returns, as far as the ticket reads it. */
type Analysis = {
  recommendation: {
    recommendedBps: number;
    confidence: 'high' | 'medium' | 'low';
    savedVsDefaultBps: number;
    driftP95Bps: number;
  };
  capacity: { maxImpactBps: number; venue: string; size: string; atLeast: boolean }[];
  fragmentation: { percent: number; venuesInSplit: number; venuesQuoted: number };
  arb: { buy: { venue: string }; sell: { venue: string }; netBps: number } | null;
};

/**
 * The swap ticket.
 *
 * No chain picker. The pair is quoted on every chain that lists both sides and
 * the route is chosen the way a venue is: by what arrives. A route is a chain
 * and then a venue on it, and both are shown — and can be overridden — in one
 * list. Where the signer holds the pay token only on some chains, only those
 * chains compete, since a route that cannot be paid for is not a route.
 */
export function Terminal() {
  const [inKey, setInKey] = useState('ETH');
  const [outKey, setOutKey] = useState('USD');
  const [amount, setAmount] = useState('1');
  const [slippageBps, setSlippageBps] = useState(50);
  const [acknowledgedImpact, setAcknowledgedImpact] = useState(false);

  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const advice = analysis?.recommendation ?? null;

  const [quotes, setQuotes] = useState<Partial<Record<ChainKey, QuoteResponse>>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const assetIn = ASSET.get(inKey)!;
  const assetOut = ASSET.get(outKey)!;
  const candidates = useMemo(
    () => CHAIN_LIST.filter((c) => assetIn.byChain[c.key] && assetOut.byChain[c.key]),
    [assetIn, assetOut],
  );

  const { address, isConnected } = useAccount();
  // When the trading account is unlocked it is the signer: it holds the funds,
  // it signs without a popup, and it is on every chain at once — so the
  // wrong-chain check below does not apply to it.
  const { account } = useTradingAccount();
  const signer = account?.address ?? address;
  const [accountRun, setAccountRun] = useState<{ sending: boolean; sent: SentStep[]; error: string | null }>(
    { sending: false, sent: [], error: null },
  );
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();

  const abortRef = useRef<AbortController | null>(null);
  const runQuote = useCallback(async () => {
    abortRef.current?.abort();
    if (!(Number(amount) > 0) || inKey === outKey || candidates.length === 0) {
      setQuotes({});
      setError(candidates.length === 0 && inKey !== outKey ? 'No chain lists both of these.' : null);
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    const settled = await Promise.allSettled(
      candidates.map((c) =>
        fetchQuote(c.key, assetIn.byChain[c.key]!.symbol, assetOut.byChain[c.key]!.symbol, amount, ctrl.signal),
      ),
    );
    if (ctrl.signal.aborted) return;
    const next: Partial<Record<ChainKey, QuoteResponse>> = {};
    let firstError: string | null = null;
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') next[candidates[i].key] = r.value;
      else firstError ??= r.reason instanceof Error ? r.reason.message : 'quote failed';
    });
    setQuotes(next);
    setError(Object.keys(next).length === 0 ? firstError : null);
    setLoading(false);
  }, [candidates, assetIn, assetOut, inKey, outKey, amount]);

  useEffect(() => {
    const t = setTimeout(runQuote, 350);
    return () => clearTimeout(t);
  }, [runQuote]);

  useEffect(() => {
    const t = setInterval(runQuote, 12_000);
    return () => clearInterval(t);
  }, [runQuote]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  // What the signer holds of the pay token on each chain. Decides which chains
  // may compete: the best price on a chain holding none of it is not on offer.
  const { data: balances, refetch: refetchBalances } = useQuery({
    queryKey: ['swap-balances', signer, inKey],
    queryFn: async () => {
      const entries = await Promise.all(
        CHAIN_LIST.filter((c) => assetIn.byChain[c.key]).map(async (c) => {
          const token = assetIn.byChain[c.key]!;
          const held = (await client(c).readContract({
            address: token.address,
            abi: ERC20,
            functionName: 'balanceOf',
            args: [signer!],
          })) as bigint;
          return [c.key, held] as const;
        }),
      );
      return Object.fromEntries(entries) as Partial<Record<ChainKey, bigint>>;
    },
    enabled: !!signer,
    refetchInterval: 15_000,
  });

  const options = useMemo(() => {
    const all: RouteOption[] = [];
    for (const c of candidates) {
      const q = quotes[c.key];
      if (!q) continue;
      const bestId = q.route.single.allocations[0]?.venue.id;
      for (const v of q.venues) {
        const out = v.venue.id === bestId ? q.route.single.amountOut : v.amountOutAtFull;
        if (out <= 0n) continue;
        all.push({
          chain: c.key,
          quote: q,
          venue: v,
          out,
          outNum: Number(formatUnits(out, q.tokenOut.decimals)),
        });
      }
    }
    return all.sort((a, b) => b.outNum - a.outNum);
  }, [candidates, quotes]);

  // Chains where the signer can actually pay. None funded means show the best
  // anywhere and let the button say what is missing.
  const funded = useMemo(() => {
    if (!balances) return null;
    const ok = candidates
      .filter((c) => {
        const held = balances[c.key];
        const token = assetIn.byChain[c.key];
        return held !== undefined && !!token && held > 0n && held >= toBase(amount, token);
      })
      .map((c) => c.key);
    return ok.length > 0 ? new Set(ok) : null;
  }, [balances, candidates, assetIn, amount]);

  const eligible = funded ? options.filter((o) => funded.has(o.chain)) : options;
  const best = eligible[0] ?? null;

  // The route the user picked. Null means "the best one", which follows the
  // quotes as they refresh; a pick sticks until the pair changes.
  const [pickedId, setPickedId] = useState<string | null>(null);
  const optionId = (o: RouteOption) => `${o.chain}:${o.venue.venue.id}`;
  const picked = options.find((o) => optionId(o) === pickedId) ?? null;
  const selected = picked ?? best;

  useEffect(() => setAcknowledgedImpact(false), [inKey, outKey, amount, pickedId]);
  useEffect(() => setPickedId(null), [inKey, outKey]);

  const execChain = CHAINS[selected?.chain ?? candidates[0]?.key ?? 'robinhood'];
  const tokenIn = assetIn.byChain[execChain.key] ?? assetIn.display;
  const tokenOut = assetOut.byChain[execChain.key] ?? assetOut.display;
  const amountIn = useMemo(() => toBase(amount, tokenIn), [amount, tokenIn]);
  const quote = selected?.quote ?? null;
  const route = quote?.route;
  const execApiVenue = selected?.venue;
  const execVenue = execApiVenue?.venue ?? null;
  const expectedOut = selected?.out ?? 0n;
  const wrongChain = !account && isConnected && chainId !== execChain.id;

  // Slippage advice and the details arrive late and never block the form.
  // Nothing here changes the tolerance on the user's behalf — it offers, they
  // apply.
  useEffect(() => {
    let cancelled = false;
    setAnalysis(null);
    if (!(Number(amount) > 0) || inKey === outKey || !quote) return;
    const t = setTimeout(() => {
      fetch(
        `/api/analyze?chain=${execChain.key}&in=${tokenIn.symbol}&out=${tokenOut.symbol}&amount=${encodeURIComponent(amount)}&slippage=50`,
        { cache: 'no-store' },
      )
        .then((r) => r.json())
        .then((b) => {
          if (!cancelled && !b.error && b.recommendation) setAnalysis(b as Analysis);
        })
        .catch(() => {
          /* advice is optional; the form does not depend on it */
        });
    }, 900);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // Keyed on the route's chain and pair, not the quote object, so a refresh
    // every twelve seconds does not re-run the analysis.
  }, [execChain.key, tokenIn.symbol, tokenOut.symbol, amount, inKey, outKey, !!quote]);

  const publicClient = usePublicClient({ chainId: execChain.id });
  const balance = balances?.[execChain.key];

  // Most venues need one approval; Uniswap V4 needs two (the token to Permit2,
  // then Permit2 to the router). The button walks them in order, one per click.
  const { data: approvals, refetch: refetchAllowance } = useQuery({
    queryKey: ['approvals', execChain.id, signer, execVenue?.id, amountIn.toString()],
    queryFn: () => pendingApprovals(publicClient!, signer!, execVenue!, amountIn),
    // The account path sends its own approvals inside the trade, so they are
    // read here only to know whether the wallet path needs a first click.
    enabled: !account && !!signer && !!execVenue && !!publicClient && amountIn > 0n,
  });
  const nextApproval = approvals?.[0];
  const needsApproval = !!nextApproval;
  const insufficient = balance !== undefined && amountIn > balance;

  const { sendTransaction, data: txHash, isPending, error: txError, reset } = useSendTransaction();
  const { isLoading: mining, isSuccess: mined } = useWaitForTransactionReceipt({ hash: txHash });

  useEffect(() => {
    if (mined) {
      refetchAllowance();
      refetchBalances();
      runQuote();
    }
  }, [mined, refetchAllowance, refetchBalances, runQuote]);

  const impact = impactBps(execApiVenue);
  const highImpact = impact !== null && impact < HIGH_IMPACT_BPS;
  const severeImpact = impact !== null && impact < SEVERE_IMPACT_BPS;
  const secondsLeft = quote ? Math.max(0, Math.ceil((quote.expiresAt - now) / 1000)) : 0;
  const expired = !!quote && secondsLeft === 0;

  const floor = quote ? minOut(expectedOut, slippageBps) : 0n;
  const exposure = quote ? expectedOut - floor : 0n;

  const onApprove = () => {
    if (!nextApproval) return;
    reset();
    sendTransaction({ ...approvalTx(nextApproval, amountIn), chainId: execChain.id });
  };

  const onSwap = () => {
    if (!execVenue || !signer || !quote || expired) return;
    reset();
    if (!account) {
      sendTransaction({ ...buildSwap(execVenue, amountIn, floor, signer), chainId: execChain.id });
      return;
    }
    // One click for the whole trade: the account sends its own approvals and
    // waits for each, so there is no second button and no wallet popup.
    setAccountRun({ sending: true, sent: [], error: null });
    swapFromAccount(account, execChain.key, execVenue, amountIn, floor)
      .then((sent) => {
        setAccountRun({ sending: false, sent, error: null });
        refetchAllowance();
        refetchBalances();
        runQuote();
      })
      .catch((e: unknown) => {
        // What landed matters more than the message: a trade that stopped
        // after its approval has changed the account's state.
        const sent = e instanceof TradeError ? e.sent : [];
        setAccountRun({
          sending: false,
          sent,
          error: e instanceof Error ? e.message.split('\n')[0] : 'the trade failed',
        });
      });
  };

  const blocked =
    !quote ||
    expired ||
    amountIn <= 0n ||
    (highImpact && !acknowledgedImpact) ||
    accountRun.sending;

  /** One line that is always true about what the button will do next. */
  const buttonLabel = (): string => {
    if (!isConnected) return 'Connect a wallet';
    if (account) {
      if (accountRun.sending) {
        return accountRun.sent.length > 0 ? 'Swapping…' : 'Approving and swapping…';
      }
      if (insufficient) return `Not enough ${inKey} in your account on ${execChain.name}`;
      if (expired) return 'Refreshing price…';
      return `Trade ${amount || '0'} ${inKey} from your account`;
    }
    if (wrongChain) return `Switch wallet to ${execChain.name}`;
    if (insufficient) return `Not enough ${inKey} on ${execChain.name}`;
    if (needsApproval) return isPending || mining ? 'Approving…' : approvalLabel(nextApproval);
    if (isPending) return 'Confirm in your wallet…';
    if (mining) return 'Swapping…';
    if (expired) return 'Refreshing price…';
    if (highImpact && !acknowledgedImpact) return 'Confirm the price impact above';
    return `Swap ${inKey} for ${outKey}`;
  };

  const onAction = () => {
    // The route decides the chain; the wallet is asked to follow it here, at
    // the moment it matters, rather than the page asking up front.
    if (wrongChain) return switchChain({ chainId: execChain.id });
    if (needsApproval && !account) return onApprove();
    onSwap();
  };

  const flip = () => {
    setInKey(outKey);
    setOutKey(inKey);
  };

  const topOut = options[0]?.outNum ?? 0;
  const vsBest = (o: RouteOption) => (topOut > 0 ? ((o.outNum - topOut) / topOut) * 10_000 : 0);

  return (
    <>
      <Card
        title="Swap"
        tone={highImpact ? (severeImpact ? 'bad' : 'warn') : 'default'}
        meta={
          quote ? <span className="mono">block {quote.blockNumber.toString()}</span> : undefined
        }
      >
        <div className="c-slot-label">You pay</div>
        <div className="c-field">
          <input
            className="c-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.0"
            aria-label={`Amount of ${inKey} to sell`}
          />
          <TokenSelect value={inKey} onChange={setInKey} tokens={DISPLAY_TOKENS} exclude={outKey} />
        </div>

        <div className="c-field-foot">
          {isConnected && balance !== undefined ? (
            <>
              <span>
                Balance {sig(balance, tokenIn)} {inKey} on {execChain.name}
              </span>
              <button
                className="c-ghost"
                type="button"
                onClick={() => setAmount(fromBase(balance, tokenIn))}
              >
                Use max
              </button>
            </>
          ) : (
            <span>Connect a wallet to see your balance</span>
          )}
        </div>

        <div className="c-flip-row">
          <button
            className="c-flip"
            type="button"
            aria-label="Flip pay and receive tokens"
            onClick={flip}
          >
            ⇅
          </button>
        </div>

        <div className="c-slot-label">You receive</div>
        <div className="c-field">
          <output
            className={`c-amount${quote ? '' : ' c-t-mut'}`}
            aria-label={`${outKey} received`}
          >
            {quote ? sig(expectedOut, tokenOut) : '0.0'}
          </output>
          <TokenSelect value={outKey} onChange={setOutKey} tokens={DISPLAY_TOKENS} exclude={inKey} />
        </div>

        {!selected ? (
          <div style={{ marginTop: 12 }}>
            {loading ? (
              <Loading rows={2} />
            ) : error ? (
              <ErrorNote onRetry={runQuote}>{error}</ErrorNote>
            ) : (
              <Empty>Enter an amount above.</Empty>
            )}
          </div>
        ) : (
          <>
            <label className="c-route-pick">
              <span>Route</span>
              <select
                className="c-route-select"
                value={optionId(selected)}
                onChange={(e) =>
                  setPickedId(best && e.target.value === optionId(best) ? null : e.target.value)
                }
              >
                {candidates
                  .filter((c) => options.some((o) => o.chain === c.key))
                  .map((c) => (
                    <optgroup
                      key={c.key}
                      label={funded && !funded.has(c.key) ? `${c.name} — not enough ${inKey} here` : c.name}
                    >
                      {options
                        .filter((o) => o.chain === c.key)
                        .map((o) => (
                          <option key={optionId(o)} value={optionId(o)}>
                            {o.venue.venue.label} — {sig(o.out, o.quote.tokenOut)}{' '}
                            {o.quote.tokenOut.symbol}
                            {best && optionId(o) === optionId(best)
                              ? ' (best)'
                              : Math.round(vsBest(o)) === 0
                                ? ''
                                : ` (${bps(vsBest(o))})`}
                          </option>
                        ))}
                    </optgroup>
                  ))}
              </select>
            </label>

            {execVenue && (
              <div className="c-field-foot">
                <span>
                  {execChain.name} → {execVenue.label} · <RoutePath venue={execVenue} />
                </span>
              </div>
            )}

            <div className="c-guarantee">
              <span>
                Guaranteed minimum{' '}
                <strong className="mono">
                  {sig(floor, tokenOut)} {tokenOut.symbol}
                </strong>
              </span>
              <Chip tone={expired ? 'bad' : 'mut'}>
                {expired ? 'price expired' : `good for ${secondsLeft}s`}
              </Chip>
            </div>
          </>
        )}

        <div className="c-slot-label" style={{ marginTop: 16 }}>
          Maximum slippage
          {quote && (
            <span className="mut">
              {' '}
              · {sig(exposure, tokenOut)} {tokenOut.symbol} at risk
            </span>
          )}
        </div>
        <Segmented
          label="Maximum slippage"
          value={slippageBps}
          onChange={setSlippageBps}
          options={SLIPPAGE_CHOICES.map((s) => ({ value: s, label: `${(s / 100).toFixed(2)}%` }))}
        />

        {advice && advice.recommendedBps !== slippageBps && (
          <Suggest
            action={`Use ${(advice.recommendedBps / 100).toFixed(2)}%`}
            onAction={() => setSlippageBps(advice.recommendedBps)}
          >
            {advice.confidence === 'low' ? (
              <>
                Too few recent trades here to measure. {(advice.recommendedBps / 100).toFixed(2)}%
                is the safe default.
              </>
            ) : (
              <>
                This pair moved <strong>{advice.driftP95Bps.toFixed(1)} bp</strong> or less in 95%
                of recent blocks. <strong>{(advice.recommendedBps / 100).toFixed(2)}%</strong>{' '}
                covers it.
              </>
            )}
          </Suggest>
        )}

        {highImpact && (
          <label className={`c-ack${severeImpact ? ' severe' : ''}`}>
            <input
              type="checkbox"
              checked={acknowledgedImpact}
              onChange={(e) => setAcknowledgedImpact(e.target.checked)}
            />
            <span>
              <strong>This trade moves the price {((impact ?? 0) / 100).toFixed(2)}%.</strong>{' '}
              {severeImpact
                ? 'Most of its value is lost to impact. Check the size.'
                : 'Continue only if that is intended.'}
            </span>
          </label>
        )}

        {/* ── the action ──────────────────────────────────────────────── */}
        <button
          className="c-go"
          onClick={onAction}
          disabled={
            !isConnected ||
            (!wrongChain &&
              (insufficient ||
                (needsApproval && !account
                  ? isPending || mining
                  : blocked || isPending || mining || accountRun.sending)))
          }
          type="button"
        >
          {buttonLabel()}
        </button>

        {txError && <ErrorNote>{txError.message.split('\n')[0]}</ErrorNote>}

        {accountRun.error && (
          <ErrorNote>
            {accountRun.error}
            {accountRun.sent.length > 0
              ? ` — ${accountRun.sent.map((s) => s.description).join(', ')} already landed.`
              : ' Nothing was sent.'}
          </ErrorNote>
        )}

        {txHash && (
          <div className={`c-tx${mined ? ' ok' : ''}`}>
            <span>{mined ? '✓ Confirmed' : 'Pending…'}</span>
            <a href={`${execChain.explorer}/tx/${txHash}`} target="_blank" rel="noreferrer">
              {addr(txHash)} on {execChain.explorerName}
            </a>
          </div>
        )}

        {quote && route && (
          <Reveal summary="Details">
            {analysis && (
              <Answers>
                <Answer
                  label={`Absorbs at ≤ ${analysis.capacity[0]?.maxImpactBps ?? 0} bp impact`}
                  value={
                    <>
                      {analysis.capacity[0]?.atLeast && <span className="c-t-mut">≥ </span>}
                      {sig(BigInt(analysis.capacity[0]?.size ?? '0'), tokenIn, 5)}
                    </>
                  }
                  unit={inKey}
                  note={`${analysis.capacity[0]?.venue ?? ''} on ${execChain.name}`}
                />
                <Answer
                  label="Off the best venue"
                  value={analysis.fragmentation.percent.toFixed(1)}
                  unit="%"
                  note={`spread across ${analysis.fragmentation.venuesInSplit} of ${analysis.fragmentation.venuesQuoted} venues`}
                />
                <Answer
                  label="Two-venue round trip"
                  value={analysis.arb ? bps(analysis.arb.netBps) : 'none'}
                  note={
                    analysis.arb
                      ? `${analysis.arb.buy.venue} → ${analysis.arb.sell.venue}, net of gas`
                      : 'no profitable loop at any size'
                  }
                />
              </Answers>
            )}

            {route.chosen === 'split' && (
              <>
                <p>
                  A split would do better by <strong>{bps(route.netEdgeBps)}</strong>. It is shown
                  for reference: executing it needs a router contract that is not deployed.
                </p>
                <div className="c-alloc">
                  {route.split.allocations.map((a, i) => (
                    <div
                      key={a.venue.id}
                      className={`c-alloc-seg vc-${i % 5}`}
                      style={{ width: `${a.share}%` }}
                      title={`${a.venue.label} ${a.share.toFixed(1)}%`}
                    />
                  ))}
                </div>
                <ul className="c-list">
                  {route.split.allocations.map((a, i) => (
                    <li key={a.venue.id}>
                      <span className={`swatch vc-${i % 5}`} />
                      <span>{a.venue.label}</span>
                      <span className="mono">{a.share.toFixed(0)}%</span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <div className="c-scroll" style={{ marginTop: 16 }}>
              <table className="c-table">
                <thead>
                  <tr>
                    <th>Route</th>
                    <th className="num">Receives</th>
                    <th className="num">vs best</th>
                  </tr>
                </thead>
                <tbody>
                  {options.map((o) => {
                    const delta = vsBest(o);
                    return (
                      <tr key={optionId(o)}>
                        <td>
                          {CHAINS[o.chain].name} → {o.venue.venue.label}
                          <div>
                            <RoutePath venue={o.venue.venue} />
                          </div>
                        </td>
                        <td className="num mono">
                          {sig(o.out, o.quote.tokenOut)} {o.quote.tokenOut.symbol}
                        </td>
                        <td className={`num mono ${Math.round(delta) < 0 ? 'dn' : 'mut'}`}>
                          {Math.round(delta) === 0 ? 'best' : bps(delta)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Reveal>
        )}
      </Card>

      <AccountPanel />

      <p className="c-foot-note">
        Unaudited. Trades execute through Uniswap&rsquo;s, PancakeSwap&rsquo;s and
        Aerodrome&rsquo;s own audited routers — this app never holds your funds.
      </p>
    </>
  );
}

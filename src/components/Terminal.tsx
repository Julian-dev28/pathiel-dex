'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useSendTransaction,
  useWaitForTransactionReceipt,
  useChainId,
} from 'wagmi';
import { useQuery } from '@tanstack/react-query';
import { bySymbol } from '@/lib/chain';
import { fetchQuote, type QuoteResponse, type ApiVenue } from '@/lib/api';
import { toBase, fromBase, sig, bps, addr } from '@/lib/format';
import { buildSwap, approvalTx, approvalLabel, pendingApprovals, minOut, ERC20 } from '@/lib/execute';
import { usePair } from './ChainProvider';
import { TokenSelect } from './TokenSelect';
import { RoutePath } from './RoutePath';
import { LiveTape } from './LiveTape';
import { AccountPanel } from './AccountPanel';
import {
  Card,
  Reveal,
  Chip,
  Suggest,
  Empty,
  ErrorNote,
  Loading,
  Segmented,
  useFocusMode,
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
 * The trade page.
 *
 * Restructured around one question at a time. This used to be two dense columns
 * plus three tables, all visible at once, with the button somewhere in the
 * middle and fine print competing with it for attention. It is now a short
 * numbered sequence — what you pay, what you get, the one risk worth acting on,
 * then the button — with everything else collapsed underneath.
 *
 * The rule the layout enforces: **nothing sits between the number and the
 * button.** Every explanation that used to live inline is now a closed panel,
 * so the reasoning is still there for anyone who wants it and in nobody's way
 * if they do not.
 */
export function Terminal() {
  const { chain, inSym, outSym, setInSym, setOutSym, flip } = usePair();
  const [amount, setAmount] = useState('1');
  const [slippageBps, setSlippageBps] = useState(50);
  const [acknowledgedImpact, setAcknowledgedImpact] = useState(false);
  const [focus, toggleFocus] = useFocusMode();

  const [advice, setAdvice] = useState<{
    recommendedBps: number;
    confidence: 'high' | 'medium' | 'low';
    savedVsDefaultBps: number;
    driftP95Bps: number;
  } | null>(null);

  const [rawQuote, setQuote] = useState<QuoteResponse | null>(null);
  // A quote from the chain the user just switched away from must never reach
  // the swap button: its routers and tokens are on the other chain.
  const quote = rawQuote && rawQuote.tokenIn.chainId === chain.id ? rawQuote : null;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const tokenIn = useMemo(() => bySymbol(inSym, chain), [inSym, chain]);
  const tokenOut = useMemo(() => bySymbol(outSym, chain), [outSym, chain]);
  const amountIn = useMemo(() => toBase(amount, tokenIn), [amount, tokenIn]);

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const wrongChain = isConnected && chainId !== chain.id;

  const abortRef = useRef<AbortController | null>(null);
  const runQuote = useCallback(async () => {
    abortRef.current?.abort();
    if (amountIn <= 0n || inSym === outSym) {
      setQuote(null);
      setError(null);
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    try {
      const q = await fetchQuote(chain.key, inSym, outSym, amount, ctrl.signal);
      if (!ctrl.signal.aborted) {
        setQuote(q);
        setError(null);
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError(e instanceof Error ? e.message : 'quote failed');
      setQuote(null);
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, [chain.key, inSym, outSym, amount, amountIn]);

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

  // The route the user picked, by venue id. Null means "the best one", which
  // follows the quote as it refreshes; a pick sticks until the pair changes.
  const [pickedId, setPickedId] = useState<string | null>(null);

  useEffect(() => setAcknowledgedImpact(false), [inSym, outSym, amount, pickedId]);
  useEffect(() => setPickedId(null), [chain.key, inSym, outSym]);

  // Slippage advice arrives late and never blocks the form. Nothing here
  // changes the tolerance on the user's behalf — it offers, they apply.
  useEffect(() => {
    let cancelled = false;
    setAdvice(null);
    if (amountIn <= 0n || inSym === outSym) return;
    const t = setTimeout(() => {
      fetch(
        `/api/analyze?chain=${chain.key}&in=${inSym}&out=${outSym}&amount=${encodeURIComponent(amount)}&slippage=50`,
        { cache: 'no-store' },
      )
        .then((r) => r.json())
        .then((b) => {
          if (!cancelled && !b.error && b.recommendation) setAdvice(b.recommendation);
        })
        .catch(() => {
          /* advice is optional; the form does not depend on it */
        });
    }, 900);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [chain.key, inSym, outSym, amount, amountIn]);

  const route = quote?.route;
  const bestVenue = route?.single.allocations[0]?.venue ?? null;

  // The best route, plus every quoted Uniswap route as an alternative, best
  // output first. A pick that the latest quote no longer contains falls back
  // to the best route rather than executing something stale.
  const routeOptions = useMemo(
    () =>
      (quote?.venues ?? [])
        .filter((v) => v.venue.id === bestVenue?.id || v.venue.label.startsWith('Uniswap'))
        .sort((a, b) => (a.amountOutAtFull > b.amountOutAtFull ? -1 : 1)),
    [quote, bestVenue],
  );
  const picked = routeOptions.find((v) => v.venue.id === pickedId);
  const execVenue = picked?.venue ?? bestVenue;
  const execApiVenue = quote?.venues.find((v) => v.venue.id === execVenue?.id);
  // What the executed route pays at full size: the best route's own figure,
  // or the picked route's point on its quoted ladder.
  const expectedOut = picked ? picked.amountOutAtFull : (route?.single.amountOut ?? 0n);
  const publicClient = usePublicClient({ chainId: chain.id });

  const { data: balance } = useReadContract({
    address: tokenIn.address,
    abi: ERC20,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: chain.id,
    query: { enabled: !!address, refetchInterval: 15_000 },
  });

  // Most venues need one approval; Uniswap V4 needs two (the token to Permit2,
  // then Permit2 to the router). The button walks them in order, one per click.
  const { data: approvals, refetch: refetchAllowance } = useQuery({
    queryKey: ['approvals', chain.id, address, execVenue?.id, amountIn.toString()],
    queryFn: () => pendingApprovals(publicClient!, address!, execVenue!, amountIn),
    enabled: !!address && !!execVenue && !!publicClient && amountIn > 0n,
  });
  const nextApproval = approvals?.[0];
  const needsApproval = !!nextApproval;
  const insufficient = balance !== undefined && amountIn > (balance as bigint);

  const { sendTransaction, data: txHash, isPending, error: txError, reset } = useSendTransaction();
  const { isLoading: mining, isSuccess: mined } = useWaitForTransactionReceipt({ hash: txHash });

  useEffect(() => {
    if (mined) {
      refetchAllowance();
      runQuote();
    }
  }, [mined, refetchAllowance, runQuote]);

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
    sendTransaction({ ...approvalTx(nextApproval, amountIn), chainId: chain.id });
  };

  const onSwap = () => {
    if (!execVenue || !address || !quote || expired) return;
    reset();
    sendTransaction({ ...buildSwap(execVenue, amountIn, floor, address), chainId: chain.id });
  };

  const blocked =
    !quote || expired || amountIn <= 0n || (highImpact && !acknowledgedImpact) || wrongChain;

  /** One line that is always true about what the button will do next. */
  const buttonLabel = (): string => {
    if (!isConnected) return 'Connect a wallet';
    if (wrongChain) return `Switch to ${chain.name}`;
    if (insufficient) return `Not enough ${tokenIn.symbol}`;
    if (needsApproval) return isPending || mining ? 'Approving…' : approvalLabel(nextApproval);
    if (isPending) return 'Confirm in your wallet…';
    if (mining) return 'Swapping…';
    if (expired) return 'Refreshing price…';
    if (highImpact && !acknowledgedImpact) return 'Confirm the price impact above';
    return `Swap ${tokenIn.symbol} for ${tokenOut.symbol}`;
  };

  return (
    <>
      <div className="c-tradehead">
        <h1 className="c-pagetitle">Trade</h1>
        <button className="c-ghost" type="button" onClick={toggleFocus} aria-pressed={focus}>
          {focus ? 'Show details' : 'Hide details'}
        </button>
      </div>

      {/* ── 1 · the pair ─────────────────────────────────────────────── */}
      {/* The standard two-slot layout: what leaves the wallet on top, what
          arrives underneath, the flip between them. */}
      <Card
        title="Swap"
        step={1}
        meta={quote ? <span className="mono">block {quote.blockNumber.toString()}</span> : undefined}
      >
        <div className="c-slot-label">You pay</div>
        <div className="c-field">
          <input
            className="c-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.0"
            aria-label={`Amount of ${tokenIn.symbol} to sell`}
          />
          <TokenSelect value={inSym} onChange={setInSym} tokens={chain.tokens} exclude={outSym} />
        </div>

        <div className="c-field-foot">
          {isConnected && balance !== undefined ? (
            <>
              <span>
                Balance {sig(balance as bigint, tokenIn)} {tokenIn.symbol}
              </span>
              <button
                className="c-ghost"
                type="button"
                onClick={() => setAmount(fromBase(balance as bigint, tokenIn))}
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
          <output className={`c-amount${quote ? '' : ' c-t-mut'}`} aria-label={`${tokenOut.symbol} received`}>
            {quote ? sig(expectedOut, tokenOut) : '0.0'}
          </output>
          <TokenSelect value={outSym} onChange={setOutSym} tokens={chain.tokens} exclude={inSym} />
        </div>

        {!quote ? (
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
            {execVenue && (
              <div className="c-field-foot">
                <span>
                  via {execVenue.label} · <RoutePath venue={execVenue} />
                </span>
              </div>
            )}

            {routeOptions.length > 1 && (
              <label className="c-route-pick">
                <span>Route</span>
                <select
                  className="c-route-select"
                  value={execVenue?.id ?? ''}
                  onChange={(e) => setPickedId(e.target.value === bestVenue?.id ? null : e.target.value)}
                >
                  {routeOptions.map((v) => {
                    const best = route!.single.amountOut;
                    const delta = best > 0n ? Number(((v.amountOutAtFull - best) * 10_000n) / best) : 0;
                    return (
                      <option key={v.venue.id} value={v.venue.id}>
                        {v.venue.label} — {sig(v.amountOutAtFull, tokenOut)} {tokenOut.symbol}
                        {v.venue.id === bestVenue?.id ? ' (best)' : delta === 0 ? '' : ` (${bps(delta)})`}
                      </option>
                    );
                  })}
                </select>
              </label>
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
      </Card>

      {/* ── 2 · the one risk worth acting on ────────────────────────── */}
      <Card
        title="Slippage"
        step={2}
        tone={highImpact ? (severeImpact ? 'bad' : 'warn') : 'default'}
        meta={
          quote ? (
            <span>
              {sig(exposure, tokenOut)} {tokenOut.symbol} at risk
            </span>
          ) : undefined
        }
      >
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
                Too few recent trades here to measure.{' '}
                {(advice.recommendedBps / 100).toFixed(2)}% is the safe default.
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

        <Reveal summary="What does slippage actually cost me?">
          <p>
            Your tolerance is not a safety margin — it is a standing offer. Someone can push the
            pool until you receive exactly your minimum and keep the difference, so the gap between
            the quote and your floor is the most they can take. Right now that gap is{' '}
            <strong className="mono">
              {sig(exposure, tokenOut)} {tokenOut.symbol}
            </strong>
            .
          </p>
          <p>
            The floor itself is enforced on-chain by {execVenue?.label ?? 'the venue'}, not by this
            page. If the price moves past it, the trade reverts rather than filling badly.
          </p>
        </Reveal>
      </Card>

      {/* ── the action ──────────────────────────────────────────────── */}
      <button
        className="c-go"
        onClick={needsApproval ? onApprove : onSwap}
        disabled={
          !isConnected ||
          insufficient ||
          (needsApproval ? isPending || mining : blocked || isPending || mining)
        }
        type="button"
      >
        {buttonLabel()}
      </button>

      {txError && <ErrorNote>{txError.message.split('\n')[0]}</ErrorNote>}

      {txHash && (
        <div className={`c-tx${mined ? ' ok' : ''}`}>
          <span>{mined ? '✓ Confirmed' : 'Pending…'}</span>
          <a href={`${chain.explorer}/tx/${txHash}`} target="_blank" rel="noreferrer">
            {addr(txHash)} on {chain.explorerName}
          </a>
        </div>
      )}

      {/* ── everything else, below the fold and closed ──────────────── */}
      {!focus && quote && route && (
        <div className="c-secondary">
          <Card
            title="Could a split do better?"
            meta={
              route.chosen === 'split' ? (
                <Chip tone="good">yes, {bps(route.netEdgeBps)}</Chip>
              ) : (
                <Chip tone="mut">no</Chip>
              )
            }
          >
            {route.chosen === 'split' ? (
              <>
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
            ) : (
              <Empty>One venue is the best answer at this size.</Empty>
            )}

            <Reveal summary="Why isn't the split executed?">
              <p>
                Splitting atomically needs a router contract that holds the intermediate balance
                mid-trade. That contract is written and fork-tested in{' '}
                <code>contracts/SplitRouter.sol</code> but deliberately not deployed — shipping
                unaudited code that takes custody to capture a few basis points is a bad trade.
              </p>
            </Reveal>
          </Card>

          <Card title="Every route" meta={`${quote.venues.length} quoted`}>
            <div className="c-scroll">
              <table className="c-table">
                <thead>
                  <tr>
                    <th>Route</th>
                    <th className="num">Receives</th>
                    <th className="num">vs best</th>
                  </tr>
                </thead>
                <tbody>
                  {[...quote.venues]
                    .sort((a, b) => (a.amountOutAtFull > b.amountOutAtFull ? -1 : 1))
                    .map((v) => {
                      const best = quote.route.single.amountOut;
                      const delta =
                        best > 0n ? Number(((v.amountOutAtFull - best) * 10_000n) / best) : 0;
                      return (
                        <tr key={v.venue.id}>
                          <td>
                            {v.venue.label}
                            <div>
                              <RoutePath venue={v.venue} />
                            </div>
                          </td>
                          <td className="num mono">{sig(v.amountOutAtFull, tokenOut)}</td>
                          <td className={`num mono ${delta < 0 ? 'dn' : 'mut'}`}>
                            {delta === 0 ? 'best' : bps(delta)}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </Card>

          <LiveTape inSym={inSym} outSym={outSym} amount={amount} tokenOut={tokenOut} />
        </div>
      )}

      <AccountPanel />

      <p className="c-foot-note">
        Unaudited. Trades execute through Uniswap&rsquo;s, PancakeSwap&rsquo;s and
        Aerodrome&rsquo;s own audited routers — this app never holds your funds.
      </p>
    </>
  );
}

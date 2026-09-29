import { PageHead, Chip } from '@/components/ui';

export const metadata = { title: 'Docs' };

/** Sidebar entries, in page order. Each `id` is a section anchor below. */
const TOC = [
  {
    id: 'how-it-works',
    label: 'How it works',
    children: [
      { id: 'discovery', label: 'Discovery' },
      { id: 'quoting', label: 'Quoting' },
      { id: 'solving', label: 'Solving' },
      { id: 'gas', label: 'Gas' },
    ],
  },
  { id: 'verification', label: 'Verification', children: [] },
  { id: 'custody', label: 'Custody', children: [] },
  { id: 'limitations', label: 'Limitations', children: [] },
  { id: 'api', label: 'API', children: [] },
  { id: 'independence', label: 'Independence', children: [] },
];

/**
 * Docs.
 *
 * Laid out as documentation: a sidebar of anchors on the left, every section
 * open on the right, so the page can be scanned or jumped through rather than
 * unfolded one toggle at a time.
 */
export default function Page() {
  return (
    <div className="d-layout">
      <nav className="d-toc" aria-label="On this page">
        <ul>
          {TOC.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`}>{s.label}</a>
              {s.children.length > 0 && (
                <ul>
                  {s.children.map((c) => (
                    <li key={c.id}>
                      <a href={`#${c.id}`}>{c.label}</a>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </nav>

      <article className="d-body">
        <PageHead
          title="Docs"
          lede="How a route is computed here, and where the numbers stop being reliable."
        />

        <section id="how-it-works">
          <h2>How it works</h2>
          <h3 id="discovery">Discovery — what gets quoted</h3>
          <p>
            Nothing is hardcoded but factory addresses. For a pair the router asks Uniswap V2,
            SushiSwap and BaseSwap for their pair, Aerodrome for both its stable and volatile pool,
            and lists the fee tiers of each concentrated-liquidity deployment — Uniswap V3 and
            PancakeSwap V3 — then repeats all of that through WETH and USDC as intermediates. A
            two-hop route is a candidate on the same footing as a direct one.
          </p>
          <p>
            The candidate set is deliberately wide and pruned by price rather than guesswork: every
            candidate is quoted once at full size, and only the best six get the full ladder.
            Laddering all of them would be roughly a hundred and eighty contract calls.
          </p>

          <h3 id="quoting">Quoting — where prices come from</h3>
          <p>
            Constant-product venues are priced off-chain from reserves, with the fee numerator that
            fork actually charges — BaseSwap takes 25bp where Uniswap V2 takes 30. Once reserves are
            known the whole ladder is arithmetic, multi-hop included, since a two-hop route is the
            same function applied twice. All arithmetic is <code>bigint</code>.
          </p>
          <p>
            Aerodrome and the V3 deployments are quoted on-chain. A Solidly stable curve and a
            concentrated-liquidity tick walk can be reimplemented off-chain, and a reimplementation
            that drifts by one tick is worse than none.
          </p>

          <h3 id="solving">Solving — why it splits</h3>
          <p>
            Each venue is quoted at a geometric ladder of sizes, producing an output <em>curve</em>
            rather than a number. Because a pool&rsquo;s output is concave in size, handing each
            successive slice to whichever venue offers the best marginal rate converges on the
            optimum — the water-filling argument.
          </p>
          <p>
            Interpolation between rungs is piecewise-linear, which on a concave function
            underestimates. That is the safe direction: the solver will never believe a venue is
            deeper than it is.
          </p>
          <p>
            Splitting is then charged for what it costs. A split that wins 3bp on a trade whose
            extra hop costs 6bp of gas is a loss, and the recommendation needs a full basis point of
            daylight before it changes.
          </p>

          <h3 id="gas">Gas — priced without an oracle</h3>
          <p>
            Comparing a split to a single route needs both sides in one unit, and the extra cost is
            in ETH while the benefit is in the token being bought. Rather than a price feed, the
            router converts gas through the same pools it already quoted. The extra-hop cost is
            70,000 gas, measured on a mainnet fork as the marginal cost of a second swap.
          </p>
        </section>

        <section id="verification">
          <h2>Verification</h2>
          <p>
            The central claim is checked rather than asserted: the off-chain quote is compared
            against a real fill on a mainnet fork and has to match to the wei.
          </p>
          <h3>What each suite proves</h3>
          <p>
            <strong>Prediction</strong> quotes a set of trades at a pinned block, forks that exact
            block, executes them against the deployed routers, and compares. Tolerance is 1bp;
            measured drift is zero.
          </p>
          <p>
            <strong>Unit tests</strong> cover the arithmetic at edges the chain rarely visits —
            empty pools, one-wei trades, collapsed ladders, the interpolation lower bound the
            splitter depends on.
          </p>
          <p>
            <strong>Address and token checks</strong> assert every hardcoded address still has
            bytecode and every token&rsquo;s on-chain <code>symbol</code> and <code>decimals</code>{' '}
            match the table. A right address with wrong decimals misprices by a factor of a
            thousand, silently.
          </p>
          <p>
            <strong>Gas profile</strong> measures the constants the router makes decisions with, so
            a guessed number cannot quietly bias every routing choice.
          </p>
        </section>

        <section id="custody">
          <h2>Custody</h2>
          <p>
            <strong>This project holds nothing.</strong> Swaps execute through Uniswap&rsquo;s,
            PancakeSwap&rsquo;s and Aerodrome&rsquo;s own deployed routers. No approval is ever
            granted to it, because it has no contract deployed.
          </p>
          <h3>What a bug here could actually cost</h3>
          <p>
            A bad quote, not a balance. The minimum-output floor is enforced on-chain by the
            venue&rsquo;s router; if the price moves past it the trade reverts rather than filling
            badly.
          </p>
          <p>
            Approvals are for the exact trade amount, not <code>type(uint256).max</code>. Infinite
            approval is the convention and it is why a router bug drains wallets months later.
          </p>
          <p>
            <code>contracts/SplitRouter.sol</code> would take custody mid-trade. It is written,
            fork-tested, and deliberately not deployed.
          </p>
        </section>

        <section id="limitations">
          <h2>Limitations</h2>
          <div className="c-scroll">
            <table className="c-table">
              <tbody>
                <tr>
                  <td>
                    <strong>Two hops maximum</strong>
                    <div className="c-sub">
                      Routes go A→B or A→X→B where X is WETH or USDC. Three-hop routes are not
                      searched.
                    </div>
                  </td>
                </tr>
                <tr>
                  <td>
                    <strong>Execution is single-venue</strong>
                    <div className="c-sub">
                      The solved split is analysis until the router contract is deployed.
                    </div>
                  </td>
                </tr>
                <tr>
                  <td>
                    <strong>No Uniswap V4</strong>
                    <div className="c-sub">
                      Quotable today, but it settles through UniversalRouter with Permit2 rather
                      than a router call. This app does not quote what it cannot execute.
                    </div>
                  </td>
                </tr>
                <tr>
                  <td>
                    <strong>No MEV protection</strong>
                    <div className="c-sub">
                      Transactions go to the public mempool. Base&rsquo;s sequencer is first-come
                      rather than an auction, which limits sandwiching relative to L1, but that is
                      not a guarantee.
                    </div>
                  </td>
                </tr>
                <tr>
                  <td>
                    <strong>Fee-on-transfer tokens unsupported</strong>
                    <div className="c-sub">
                      The quote assumes the amount sent is the amount the pool receives.
                    </div>
                  </td>
                </tr>
                <tr>
                  <td>
                    <strong>Quotes expire after 30 seconds</strong>
                    <div className="c-sub">
                      A backstop against a tab left open, not a freshness guarantee. Base blocks are
                      two seconds.
                    </div>
                  </td>
                </tr>
                <tr>
                  <td>
                    <strong>Public RPC rate limits</strong>
                    <div className="c-sub">
                      Set <code>RPC_URL</code> for anything beyond casual use.
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section id="api">
          <h2>API</h2>
          <p>
            Full schema: <a href="/api/openapi">openapi.json</a>.
          </p>
          <div className="c-scroll">
            <table className="c-table">
              <tbody>
                <tr>
                  <td className="mono">/api/quote</td>
                  <td>The solved route and every venue curve behind it.</td>
                </tr>
                <tr>
                  <td className="mono">/api/analyze</td>
                  <td>
                    Sandwich exposure, measured slippage, capacity, fragmentation, round trip.
                  </td>
                </tr>
                <tr>
                  <td className="mono">/api/cycles</td>
                  <td>Arbitrage loops across the token graph.</td>
                </tr>
                <tr>
                  <td className="mono">/api/venues</td>
                  <td>Every pool considered, including mid-route ones, with balances.</td>
                </tr>
                <tr>
                  <td className="mono">/api/stream</td>
                  <td>Server-sent quotes, pushed when a block changes the answer.</td>
                </tr>
                <tr>
                  <td className="mono">/api/health</td>
                  <td>Chain height and block age. 503 when the head goes stale.</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            No authentication — every endpoint reads public chain state. Rate limited to 120
            requests per minute per IP.
          </p>
        </section>

        <section id="independence">
          <h2>Independence</h2>
          <p>
            <Chip tone="mut">unaffiliated</Chip> Not connected to Uniswap, Aerodrome, PancakeSwap,
            SushiSwap, BaseSwap, Coinbase or OKX. It reads their public contracts and routes to
            their public routers, which is what those contracts are for. All names are used
            descriptively.
          </p>
          <p>
            It holds no API keys and depends on no commercial data provider. That is a design
            constraint, not a cost saving: a router whose prices come from an aggregator cannot be
            checked against that aggregator.
          </p>
        </section>
      </article>
    </div>
  );
}

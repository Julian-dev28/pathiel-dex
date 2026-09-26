# PATHIEL DEX

An on-chain route solver for Robinhood Chain, Base and X Layer, with one account
across all three and Hyperliquid's stock perps. It quotes every major venue
directly from pool state — direct pools and two-hop routes alike — solves the
optimal split across them, and executes through the venues' own audited routers.

**Nothing asks which chain.** You name an asset and an amount of dollars; the
router prices every chain that lists it, spends dollars from wherever the account
holds them, crosses when crossing pays, and buys the gas it needs on the way. The
chain a trade landed on is shown afterwards, never demanded beforehand. The pages
that exist to compare chains — venues, depth, tools, backtests — carry their own
chain control, and the API and MCP tools still take
`chain=robinhood|base|xlayer`.

There is no aggregator API anywhere in it, and no API key of any kind. Prices
come from pool reserves and quoter contracts read over public RPC, which is what
makes the central claim checkable: **the router's off-chain quote is compared
against a real fill on a mainnet fork, and has to match.**

Live at **https://pathiel-dex.vercel.app**, invite-only while in beta — see
[Beta access](#beta-access).

```
npm install && npm run dev        # http://localhost:3000
npm run test:unit                 # solver maths, no network
npm run predict                   # quote a set of trades, pin the block
cd contracts && forge test        # replay them on a fork, compare
```

## Robinhood Chain

Robinhood Chain (4663) is an Arbitrum Orbit L2 with 100ms blocks, and its DEX
liquidity looks nothing like Base's. The hub dollar is **USDG**, not USDC, and
the tokens worth trading are Robinhood's tokenized stocks and ETFs — NVDA, QQQ,
SPY, TSLA, GOOGL, AMZN, AAPL, MSFT, META, MSTR, PLTR, COIN — plus WETH and cbBTC.
Two-hop routes go through WETH or USDG.

| Venue | Quote | Execute |
| --- | --- | --- |
| Uniswap V2 | reserves, off-chain | `UniswapV2Router02` |
| Uniswap V3 | `QuoterV2` | `SwapRouter02` |
| PancakeSwap V3 | `QuoterV2` | `SwapRouter` (with deadline) |
| Uniswap V4 | `V4Quoter` | `UniversalRouter` via Permit2 |

**Uniswap V4 carries about half of the chain's volume**, so it is quoted and
executed here. V4 has no factory to ask, and fee and tick spacing are free
parameters, so its pools cannot be guessed: `npm run scan:v4` reads the
PoolManager's `Initialize` events filtered to listed tokens and commits the
hookless pools holding liquidity to `src/lib/v4-pools.ts`. Pools with hooks are
excluded — a hook is arbitrary code on the swap path. Most V4 liquidity here is
paired with native ETH, so a route that starts or ends in an ETH pool is wrapped
or unwrapped inside the same Universal Router call; the wallet only ever holds
WETH. V4 swaps need two exact approvals rather than one: the token to Permit2,
then a 30-minute Permit2 allowance for the router.

The Solidity fork tests cannot reach this chain: its public RPC is not an
archive node, and at ten blocks a second a pinned fork block ages out within
seconds. `npm run sim:swaps` runs every execution path instead — V2, V3, V3 two-
hop, PancakeSwap, V4 with and without native ETH at either end, V4 two-hop — as
an `eth_simulateV1` sequence at the head, and checks the fill against the quote.
That is how the deployed router's single-hop V4 params were found to carry a
`maxHopSlippage` word the older struct lacks.

## X Layer

X Layer (196) is OKX's zkEVM L2, with 1s blocks and **OKB** as the gas token, so
the wrapped native asset is WOKB rather than WETH. The stocks here are Backed's
xStocks wrapped by OKX — `wNVDAx`, `wAAPLx`, `wCOINx`, `wHOODx`, `wSPCXx` and a
dozen more — and they trade against three dollars (USDG, USDC and Tether's
USD₮0) alongside OKX's wrapped majors `xETH` and `xBTC`. That is why this chain
carries three hub tokens where the others carry two: the stocks are split
between USDG and USDC, and the majors price against xETH.

Uniswap V2, V3 and V4 are all deployed here officially, and there is no
PancakeSwap. Nearly every pool is the 0.05% tier, with the dollar pairs at
0.01%; V4 holds a handful of stablecoin pools priced as low as 0.0009%, which is
why a USDG→USDC quote routes through V4 rather than V3.

Two endpoint limits shape the code rather than the config:

- **A log query may span 100 blocks.** Every scan here is a loop, which is what
  `maxLogSpan` on the chain config is for.
- **A JSON-RPC batch may carry 10 calls.** The eleventh fails the whole batch
  with `-32014 too many RPC calls in batch request`, which reads exactly like
  every contract on the chain having no bytecode. `maxRpcBatch` sizes the
  transport's batches per chain.

The 100-block cap also puts the V4 `Initialize` history out of reach — it would
be a quarter of a million queries — so `npm run scan:v4 -- xlayer` works the
other way round: it collects pool ids from recent `Swap` logs and resolves each
one back to its key through the PositionManager's `poolKeys` mapping. Narrower
by construction, since a pool nobody has traded lately is never found.

**Execution on X Layer is not yet verified.** Quotes are, live and against real
trades (`npm run backtest -- xlayer`), but the public RPC does not serve
`eth_simulateV1`, so `npm run sim:swaps` cannot run here. Unlike Robinhood
Chain, though, its RPC does serve deep archive state, so the Solidity fork tests
can reach it — that is the missing piece, not a permanent gap.

## One account, three chains

Sign in with your wallet, sign one message, deposit once, and trade Base,
Robinhood Chain, X Layer and Hyperliquid perps from a single balance — no chain
selector and no wallet popup per trade.

**Nothing is deployed and nothing is held.** The account is an ordinary
keypair derived from that signature, so it exists at the same address on every
EVM chain and is already a valid Hyperliquid account. There is no contract to
audit, no pooled wallet, and no ledger of liabilities: the funds sit at an
address only your wallet can reproduce, and the withdrawal path back is always
open.

**It is permanent, not a session.** The same wallet signing the same message
reproduces the same key on any device, years later. "Session" only describes
how long the key is held in memory — it is never written to storage, so a
reload asks again and a closed tab forgets.

A signature is put into one canonical form before it becomes a key (`v` as
27/28, `s` in the lower half). Two encodings of the same signature are the same
authorisation, and hashed raw they derived two different accounts — a customer
funding one and signing in later through another connector would have found an
empty account with their balance at an address the page no longer produced.

**What the customer is told before they fund it**, because they are creating
the thing that holds their money: the account is reproduced from their
signature, anyone who obtains that signature controls it permanently and it
cannot be rotated — only replaced by versioning the label — and the key lives
in the page, so this is a trading float rather than a vault.

**The deposit does not ask a chain either.** It reads what your wallet holds on
each configured chain and leaves from wherever it holds the most dollars — the only
answer that does not require knowing which of three dollars you own. There is no
"switch network" step: the transaction carries its chain id, so the wallet raises
the network itself as part of signing rather than this page becoming somewhere you
first pick a chain and then act.

**The dollars pool.** $60 on Base and $40 on X Layer is $100, and a $100 trade
draws on both: `planSpend` in `src/lib/account/plan.ts` takes from every chain
that can sign, largest first, to keep the number of crossings down. A router that
picks one source chain refuses that trade while showing the customer $100, which
is what this one used to do. Balances are compared in millionths of a dollar
rather than raw base units, so a future 18-decimal dollar cannot read as a
trillion times itself.

**The router buys its own gas.** A chain cannot be spent from without its native
currency — not the swap, not even the bridge out — so an account funded with
dollars alone is unsignable everywhere, and the first trade was impossible. Where
the destination has no gas, the plan reserves dollars and buys some through the
bridge before anything else is sent, and those reserved dollars cannot also be
spent on the trade.

The amount is quoted, never guessed. Sizing gas off each chain's configured fee
floor (which carries a 10× spike allowance for good reasons of its own) asked
**$8.10 of ETH to make a $100 trade** on Robinhood Chain; sized against the live
gas price it is about $0.71, and X Layer about $0.25. Exact-output is the precise
question — *land this many wei, tell me the cost* — and OKB cannot be quoted that
way, so the fallback learns the rate from one probe and sizes a second quote from
it.

Only one gas question is left in front of the customer: an account that can sign
**nowhere** cannot buy its own way out, so the first deposit to a chain carries a
little native currency with it, and the account page offers a top-up if that state
is ever reached. Everything after that the router handles.

**Ranked on what arrives.** Routes are ordered by units received per dollar that
leaves the account, counting the crossings and any gas bought — so a chain needing
several dollars of gas does not win by two basis points. The panel says that gas
stays in the account for later trades rather than being consumed by this one.

## Perps on the same names

The stocks this router quotes on three chains also trade as perpetuals, and the
two belong on one screen: the same company, priced by a pool on three chains and
by an oracle on a perp venue.

They are not in Hyperliquid's own perp universe. The equities live in a
builder-deployed **HIP-3 dex called `xyz`**, which the API treats as a separate
namespace — query it without a `dex` field and you get core crypto only, which
looks exactly like a venue with no stocks on it. That dex carries 123 markets
and more open interest than Hyperliquid's own ETH book, and 21 of its markets
are names this router already lists for spot.

`npm run perps` prints the join: every asset, what it costs on each chain, the
perp mark, the basis between them, and annualised funding. `/perps` shows the
same thing in the app. Spot comes from this router's own quote path, and every
read is public and unauthenticated.

**Trading them works in the browser, end to end.** `/perps` prices a market or
limit order, shows the summary, signs it with the trading account and sends it
straight to Hyperliquid — the venue answers `/exchange` with
`access-control-allow-origin: *`, so no server of this project's is in the path
and cannot delay, reorder or log an order. The same actions exist from
Claude: `build_perp_order` signs and shows, `perp_order` sends, both behind the
same key boundary as `swap`, so the hosted MCP server has neither.

The path is deliberately complete rather than just openable:

- **Margin is funded from the same balance.** A perp settles in USDC inside that
  dex's own margin account; dollars on Base cannot back it. `src/lib/account/margin.ts`
  quotes the crossing from whichever chain the account holds the most signable
  dollars on and sends it there. The cost is stated because it is nearly flat —
  $1.22 on $25 is 489bp, $1.24 on $150 is 82bp — so the panel says one transfer
  costs far less than three rather than quoting a percentage that flatters size.
- **Resting orders can be cancelled.** A limit order is `Gtc`: it sits until it
  fills or somebody cancels it, and for a while this app could place one and offer
  no way back, leaving the customer's only recourse in Hyperliquid's own interface
  for an order this app had signed. `/perps` now lists resting orders across both
  dexes with a cancel per row. They are read one dex at a time so the asset id a
  cancel must carry comes from the question rather than from parsing the coin
  field, and an order that cannot be resolved is dropped rather than shown with a
  button that would cancel the wrong market. `side` arrives as `A`/`B` — ask and
  bid — which read as a word would label every order backwards.
- **Margin comes back out.** The destination is the signing account and is not a
  parameter, so `withdraw3` — the one action that can pay a stranger — can only pay
  the owner back. `usdSend` and `spotSend` exist only to pay someone else and are
  still absent. Hyperliquid's flat $1 fee is stated, what will arrive is shown, and
  anything under $2 is refused rather than quietly eaten.
- **Orders the venue would refuse are refused first.** Hyperliquid's minimum is $10
  of notional, measured on the *rounded* size at the price the order will rest at:
  $10.40 of a two-decimal market works out at $9.11 and would have been thrown out
  after the customer had already signed for it.

`perp-order.ts` — the module the MCP server uses — still implements no withdrawal
at all, and should not. It is meant to be given an **agent (API) wallet**, which
Hyperliquid will not honour for a withdrawal anyway, and it runs next to a
tool-calling model where code that cannot withdraw cannot be talked into
withdrawing. The browser is a different case: it holds the master key by design,
so the exit exists there with its destination nailed down.

The signing is pinned to external vectors from Hyperliquid's own Python SDK
rather than to this code's output, because a wrong byte in the msgpack action
hash fails silently with no diagnostic. Asset ids matter as much: a HIP-3
market is `100000 + dexIndex * 10000 + index`, so `xyz:NVDA` is 110002 and the
same index in the core universe is a different instrument. The browser path signs
the same bytes as the key path, and the tests sign one order — and one cancel —
both ways and compare, because a payload that drifts does not fail loudly: it
produces a well-formed order the exchange silently rejects in front of someone
trying to trade.

**Verified against the live venue without funding anything.** Every action is
signed with a key generated on the spot and actually posted to `/exchange`. The
account has no deposit, so success is impossible and the error text is the result:
`User or API Wallet … does not exist` for an order or a cancel, and `Must deposit
before performing actions` for a withdrawal, both of which mean the signature
recovered, the action hash matched, and the asset ids and field order were
accepted. Anything about the signature or the payload would be a real bug. All
four pass today, with `xyz:NVDA` sent as 110002 and core BTC as 0.

What is still unproven is the money: **no funded trade has run**, on either side
of the product. Every step around it is verified.

**A perp is not a swap.** A bad route costs basis points; a liquidation costs
the position. The ticket reads the margin account before it offers a button, and
refuses to be a form that submits orders into an account with nothing behind them.

An asset is one thing listed in several places, so `NVDA` on Robinhood Chain,
`NVDAc` on Base, `wNVDAx` on X Layer and `xyz:NVDA` are one row. The canonical
symbol is derived from the listed symbol rather than stored in a table that
would drift — `src/lib/assets.ts`, with the rules pinned by unit tests, because
folding `USDC` into an asset called `USD` or a staking derivative into `ETH`
would quote a basis between two different things and do it silently.

**Two numbers of different kinds.** The spot side is what buying $1,000 of the
token actually returns from this router's pools — an executable price with the
venue's fee and that trade's price impact inside it. A perp mark comes from an
oracle run by the HIP-3 dex's deployer, who also sets that market's parameters:
a third party's number, not a chain's.

The gap between them is therefore **not a funding basis**, and the code refuses
to call it one (`perpVsBuyBps`, not `basisBps`). At a 0.30% fee tier the cost of
trading alone is thirty basis points — larger than the premium being measured,
and enough to flip its sign while looking perfectly smooth. What it does answer
is the question a trader actually has: is the perp dearer than buying outright,
fees and all?

It is also an MCP server — hosted at `https://pathiel-dex.vercel.app/api/mcp`
for quotes, and locally with your own key for trading from Claude. See [MCP](#mcp).

---

## The claim, and the test that checks it

`npm run predict` quotes eleven trades off-chain at a pinned block and writes
down what it expects each to pay. `forge test` forks that exact block, performs
the trades against the deployed Uniswap, Aerodrome and V2-fork routers, and
compares the realised fill to the prediction.

Latest run — 13 cases, **every one exact to the wei**:

| Trade | Route | Drift |
| --- | --- | ---: |
| 0.1 WETH → USDC | PancakeSwap V3 0.01% | 0 bp |
| 1 WETH → USDC | Uniswap V3 0.05% | 0 bp |
| 10 WETH → USDC | Uniswap V3 0.05% | 0 bp |
| 1,000 USDC → WETH | PancakeSwap V3 0.01% | 0 bp |
| 25,000 USDC → WETH | PancakeSwap V3 0.01% | 0 bp |
| 0.05 WETH → DAI | **Uniswap V3 via USDC** (2 hops) | 0 bp |
| 1 WETH → cbBTC | Uniswap V3 0.30% | 0 bp |
| 5,000 USDC → DAI | Uniswap V3 0.01% | 0 bp |
| 50,000 DEGEN → USDC | **Uniswap V3 via WETH** (2 hops) | 0 bp |
| 500 AERO → USDC | Uniswap V3 0.05% | 0 bp |
| 10,000 BRETT → WETH | Uniswap V3 0.30% | 0 bp |
| 2 WETH → USDC | PancakeSwap V3 0.01% *(forced)* | 0 bp |
| 0.5 cbBTC → USDC | PancakeSwap V3 0.01% *(forced)* | 0 bp |

Two cases are *forced* onto PancakeSwap rather than taking the best route.
Without that, fork coverage is whatever happened to win on the day, and
PancakeSwap's execution path is precisely the one that would silently revert —
see below.

Tolerance in the suite is 1bp; measured drift is zero. The multi-hop cases also
validate the path encoder — a packed V3 path this test cannot spend is a path
the app would have signed.

Reproduce with `npm run predict && cd contracts && forge test -vv`. The fixture
pins a block, so regenerate before running: public Base endpoints serve recent
state, not deep history, and a stale fixture skips with a message rather than
failing.

Getting to zero took finding three bugs that all looked like something else:

- **The test contaminated itself.** Cases shared one fork, so an earlier case
  selling 10 WETH into the 0.05% pool left it cheaper for a later case buying
  WETH back. That case came out 11bp *better* than predicted. Each case now runs
  from a snapshot of the pinned block.
- **There are no empty addresses on a mainnet fork.** `0xA11CE` already holds 23
  USDC on Base, so asserting on an absolute balance failed by exactly that
  amount. Assertions are on deltas.
- **PancakeSwap's router is not Uniswap's router.** It forked Uniswap's
  *original* `SwapRouter`, whose swap params carry a `deadline`; Uniswap moved
  to `SwapRouter02`, which does not. Same function names, different structs,
  different selectors — and encoding one against the other reverts every swap
  on that venue. Caught by reading the selectors out of the deployed bytecode
  (`npm run probe:venues`) before writing a line of integration, and now
  recorded as `routerHasDeadline` in the deployment table.

## Multi-hop, and when it matters

A route is a path through one protocol family, not a single pool: `WETH → USDC →
DAI` on Uniswap V3 is one venue with two hops, quoted through `quoteExactInput`
and executed atomically through `exactInput`. Direct and two-hop routes are
therefore interchangeable candidates rather than two separate features, and the
splitter allocates across both.

Candidates are enumerated generously — three V2 forks, Aerodrome's stable and
volatile curves, four V3 fee tiers, each crossed with WETH and USDC as
intermediates — then **pruned before laddering**. Every candidate is quoted once
at full size; only the best six get the full twelve-rung ladder. Laddering the
whole candidate set would be about a hundred and eighty contract calls.

From `npm run bench`, 24 cases across nine pairs:

| Pair | Size | Routes | Best single | Hops | Split legs | Gross | Net of gas | Picks |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| WETH/USDC | 1 | 9 | PancakeSwap V3 0.01% | 1 | 2 | +0.0 bp | +0.0 bp | single |
| WETH/USDC | 25 | 9 | PancakeSwap V3 0.01% | 1 | 4 | +4.0 bp | +4.0 bp | split |
| USDC/WETH | 100,000 | 9 | PancakeSwap V3 0.01% | 1 | 3 | +9.0 bp | +9.0 bp | split |
| WETH/cbBTC | 10 | 11 | PancakeSwap V3 0.01% | 1 | 3 | +0.0 bp | +0.0 bp | single |
| WETH/DAI | 0.1 | 12 | **Uniswap V3 via USDC** | 2 | 4 | +0.0 bp | +0.0 bp | single |
| USDC/DAI | 25,000 | 12 | Uniswap V3 0.01% | 1 | 4 | +3234.0 bp | +3234.0 bp | split |
| DEGEN/USDC | 10,000 | 11 | **Aerodrome v/s via WETH** | 2 | 5 | +5.0 bp | +1.0 bp | split |
| BRETT/USDC | 200,000 | 11 | **Uniswap V3 via WETH** | 2 | 2 | +18.0 bp | +18.0 bp | split |
| AERO/USDC | 25,000 | 12 | Aerodrome vAMM | 1 | 4 | +0.0 bp | +0.0 bp | single |
| cbETH/USDC | 20 | 11 | **Uniswap V3 via WETH** | 2 | 2 | +1727.0 bp | +1727.0 bp | split |

**Multi-hop was the best route in 8 of 24 cases. PancakeSwap V3 was the best
single venue in 10 of 24. Splitting was chosen in 10 of 24, median net edge
4.0bp.**

Three things fall out, and all three are worth saying plainly:

**On deep pairs, splitting is nearly worthless below size.** WETH/USDC under a
few ETH routes to one pool and stays there. A router reporting a win on those
trades is measuring rounding, which is why the recommendation needs a full basis
point of daylight before it switches.

**On long-tail tokens, multi-hop is not an optimisation — it is the only route.**
DEGEN, BRETT and cbETH have no direct USDC pool worth using; every route that
quotes at all passes through WETH. Before multi-hop, this router returned
nothing useful for them.

**The eye-catching numbers are facts about Base's liquidity, not this router's
cleverness.** cbETH/USDC at +1726bp means the direct pools are shallow enough
that spreading the trade is worth seventeen percent. That is a statement about
cbETH on Base.

## Does it actually route well? Replaying real trades

The fork tests prove the quote matches what the chain would pay. They say
nothing about whether the route it picks is any *good* — for that you need a
counterfactual, and the honest one is already on-chain. Every swap someone
executed is a decision made with real money by someone who had their own
router.

`npm run backtest` reads the Swap logs, takes each trade, re-quotes it **as it
stood one block earlier**, and compares. `npm run backtest -- robinhood` does
the same on Robinhood Chain, V4 pools included; `/backtest` shows whichever chain
its own tabs select, since which chain is the question that page exists to ask.

Current Base dataset — 2 runs, 6,263 swaps observed, 47 replayed:

| | |
| --- | --- |
| Median edge | **+1.0 bp** |
| Better / equal / worse | **27 / 14 / 6** (57% better, 30% exact ties) |
| Median win | +12 bp |
| Median loss | −23 bp |
| p10 – p90 | −1 … +39 bp |

The shape is more interesting than the headline. The router **matches or beats
87% of real trades**, and a third of the time it matches to the wei — it found
the same venue the trader did, which on a deep pair is the correct answer rather
than a missed opportunity. Losses are rare but larger than wins, which is what
you would expect: the cases where somebody beat this router are the ones where
they knew something it does not, such as a venue outside its table.

Three biases are corrected for in the code rather than mentioned in a footnote:

- **Quote at the parent block.** A trade's own swap is in the block it landed
  in, so quoting at that height prices a pool it already moved. The state the
  trader actually faced is the end of `block - 1`.
- **Single-swap transactions only.** A Swap log that is one leg of somebody's
  multi-hop route is not a complete trade, and comparing our whole route against
  one leg of theirs would flatter this project enormously. Transactions with more
  than one Swap log are discarded — that is why 6,263 observed becomes a far
  smaller eligible set.
- **Gross of gas on both sides.** We do not know what they paid, and our own
  extra-hop cost is not netted out either, which if anything favours them.

What it cannot correct for: *why* they routed as they did. A trade that looks
beatable may have been a deliberate venue choice, an MEV-protected order, or one
leg of an intent that settled elsewhere. The page says so.

## Interface

The frontend is built for someone who cannot easily hold five threads at once —
which, on a screen that spends money, is everyone under pressure.

The first version put its reasoning in front of its answers: five equal
sections, each opening with a paragraph about its own methodology, and the
number the reader wanted somewhere in the middle. Good research document, bad
instrument. The rules now:

- **The answer is the largest thing on screen.** Every card leads with its
  figure; every explanation is a closed `<details>` one tap away. Nothing was
  deleted — the rigour is the point — it is just no longer in the way.
- **Nothing sits between the number and the button.** The front page is an asset,
  an amount of dollars, and one action. What the router decided — the chain, the
  venue, the crossings, the gas it had to buy, the margin over the next-best chain
  — appears after pricing, above the button that spends the money, because deciding
  on someone's behalf is only honest if they can see what was decided. Every chain
  it considered and what each would have returned is one disclosure below that.
- **A chain is never a question on a trading screen.** The pair-by-pair terminal
  moved off the front page to `/tools`, where picking a pair and a chain is the
  stated job. A terminal is a thing you point at a chain, and leaving it under the
  buy panel meant the first screen still had one on it.
- **Nothing moves unless movement is the information.** The live block counter
  is gone from the masthead; the price tape only emits when the price actually
  changed; `prefers-reduced-motion` removes the rest.
- **Nothing arrives and shoves the page down.** Loading states reserve their
  height.
- **Every tappable thing is at least 40px**, there is a skip link, the current
  page is filled rather than underlined, and colour never carries meaning alone.

## Execution tools

Five things a swap interface could tell you and none of them do. All of it falls
out of quoting the pair in both directions — the forward ladder a quote needs
anyway, plus one reverse ladder — so the whole suite is one request:
`GET /api/analyze`.

**1 · Sandwich exposure.** A slippage tolerance is not a safety margin, it is a
standing offer: an attacker can push the pool until you receive exactly your
minimum and keep the difference. So the exposure is `quoted − floor`, which is
arithmetic on a number the user authorised rather than an estimate. On 1 WETH at
the stock 0.5% that is about **$12 posted to whoever wants it**.

**2 · Slippage measured, not guessed.** Every wallet ships 0.5% and nobody
changes it. This measures how much the pair's price *actually* moves over a
six-block inclusion window and recommends a tolerance that covers it. WETH/USDC
drifts a few basis points; the default is several times wider than the market it
is protecting against.

The measurement is nearly free: Uniswap V3 Swap events carry `sqrtPriceX96`, so
**one log query reconstructs a pool's entire price series** — no archive node,
no per-block calls, no price feed.

Getting this right took three corrections, all of which produced a confident
wrong answer first:

- *A pool existing is not a pool trading.* The factory returns an address for
  tiers nobody uses. Taking the first tier that resolved measured an abandoned
  pool and had DEGEN looking calmer than ETH. Now every tier is measured and the
  busiest one wins.
- *A hub token is not a constant.* The first version skipped any leg touching
  USDC. But WETH/USDC moves several bp over an inclusion window — it is a risk
  leg, not a numeraire — so cbETH/USDC reported cbETH's drift against ETH
  (0.01bp, true and irrelevant) while ignoring the ETH/USD move that dominates
  the trade.
- *A small sample is not evidence.* Twenty-three windows on a thin pool is not
  four hundred on WETH/USDC. The multiplier widens as the sample shrinks, and
  below fifty observations the recommendation **refuses to tighten below the
  wallet default at all**. A tool that exists to reduce risk must not increase it
  on the pairs it understands least.

**3 · Capacity.** How much the pair absorbs before impact exceeds 10, 50 or 100
bp. The first question a desk asks, and no interface answers it. (Its first
implementation returned zero for everything: dividing an 18-decimal input by a
6-decimal output truncated to zero before the comparison. It is cross-multiplied
now, and there is a test for exactly that shape.)

**4 · Fragmentation.** What share of optimal execution happens away from the
single best venue. Published precisely because it is sometimes unflattering — on
a deep pair at small size this number says routing does not matter, and that is
worth knowing.

**5 · Arbitrage loops.** A loop is profitable when its exchange rates multiply
to more than one. Take logarithms and that product becomes a sum; negate it and
the profitable case becomes a *negative cycle*, which Bellman-Ford finds. The
transformation is the whole trick — a multiplicative search over paths becomes
an additive one, and an additive one has a textbook algorithm. Gas is folded
into each edge rather than subtracted at the end, so the search prefers a
shorter loop on its own.

It draws the loop as a loop, and it ranks the near misses, because those are the
interesting part: how far the market is from opening. Expect nothing to be open
— these are contested by searchers with colocated infrastructure and close
inside a block. Finding none is the honest result of a correct search.

**6 · Cross-venue round trip.** Both legs move against you as size grows, so
profit is concave and the optimum is a *specific size* rather than as much as
possible — taking the maximum is how a naive searcher turns an edge into a loss.
It will almost always report nothing: these are contested by searchers with far
better latency and close within a block. Reporting nothing is the honest answer.

The trade form uses the second of these directly — it offers the measured
tolerance next to the slippage selector, with one click to apply, and never
changes it on the user's behalf.

## Storage, scheduling and streaming

The backtest needed somewhere to put results, which is where a project like this
usually acquires a database and a credential. It does not have one.

**The dataset is `data/backtest.jsonl`, committed to the repository.** A
scheduled GitHub Action appends one line per run and pushes it. Git is the
storage engine, the Action is the cron, and the commit is the audit trail. Every
number the site publishes about routing quality is therefore traceable to the
diff that introduced it — a stronger guarantee than a database nobody outside
the deployment can query, and it costs nothing. `src/lib/dataset.ts` is
deliberately shaped like the database call it would become if the dataset
outgrew this.

**`GET /api/stream` is server-sent events** — a re-quote pushed when a block
actually changes the answer. SSE rather than WebSockets because the traffic is
one-directional, reconnects are free, and there is no second protocol to run.
Two things keep it from being a load generator: blocks are coalesced to at most
one quote every six seconds, and an unchanged quote is not sent at all.

Getting that second part right took two attempts. The first fingerprint included
the block number, which always advances — so the check never fired and the
stream pushed on every tick, which is the exact behaviour it exists to prevent.
The second threw on `JSON.stringify` of a bigint and turned every tick into an
error frame. Both are visible in the git history and both were caught by
watching the actual stream rather than by reading the code.

The tape is deliberately *not* what the trade form signs against. The form keeps
its own quote with an explicit expiry, because a price that changes under the
user between reading and clicking is how people get a fill they did not agree
to.

**Observability**: `GET /api/metrics` reports in-process counters and quote
latency percentiles; `GET /api/health` returns 503 when the chain head goes
stale. `GET /api/openapi.json` is the contract, hand-written because a generator
can describe the shape but not the semantics — that `amountIn` is a base-unit
integer as a string, or that 404 means "no pool" rather than "wrong URL".

**Container**: a multi-stage `Dockerfile` producing a standalone runtime image
with no sources, no dev dependencies and no root user, and a `HEALTHCHECK` that
uses the chain-freshness endpoint rather than a bare liveness probe. It is
written but **not yet built** — there was no Docker daemon on the machine it was
authored on, so treat it as unverified until `docker build .` has run once.

## Adding venues, and which ones are worth adding

Every venue below is free: public contracts, public RPC, no key, no
registration. What separates them is whether they hold liquidity worth routing
to, which is a question you answer by measuring, not by counting integrations.
`npm run probe:venues` does the measuring — it reads reserves, asks each fork's
own router what it would pay, and **derives the fee from the two** rather than
trusting a constant.

**Added: PancakeSwap V3.** Its 0.01% tier prices better than anything else on
Base for mid-size WETH/USDC. After adding it, it is the best single venue in 10
of the 24 benchmark cases — one free venue changed the winner on 42% of them.
Its fee tiers are not Uniswap's either: 0.25% where Uniswap has 0.30%.

**Rejected: the V2 forks.** PancakeSwap V2, AlienBase and SwapBased all have
live WETH/USDC pairs. They hold 0.2, 0.1 and 0.5 WETH respectively — a few
hundred dollars each. They would never win a route, and each one costs a
discovery call on every quote. Measured and left out; the probe script keeps the
evidence.

**Executable on Robinhood Chain, not yet on Base: Uniswap V4.** On Robinhood
Chain V4 is quoted and executed (see [Robinhood Chain](#robinhood-chain)). On
Base it is not configured yet. V4 is live on Base and quotes
competitively (the hookless 0.30%/60 pool prices within a few bp of V3). It has
no factory — a pool is identified by its key, so discovery means enumerating
`(fee, tickSpacing, hooks)` and letting the quoter revert on the rest, which
works for hookless pools and cannot enumerate hooked ones at all. The blocker is
execution: V4 settles through `UniversalRouter` with Permit2 and an encoded
action sequence, not a router call. Quoting a venue this app cannot execute
would break the rule the rest of it follows, so V4 stays out until the execution
path is written. The probe script quotes it today.

**Not viable: the OKX repos.** Checked all five:

| Repo | What it actually is | Verdict |
| --- | --- | --- |
| `Web3-DEX-EVM-PMM` | RFQ onboarding for *private market makers* — you supply signed `OrderRFQ` quotes | Requires being an onboarded PMM counterparty. No public liquidity. |
| `Web3-DEX-evm-intent-sdk` | Calldata builder for `Settlement.settle()` | Requires being a solver in their auction. |
| `Web3-DEX-Router-EVM-V1` | The DexRouter contracts. Deployed on Base at `0x4409921a…`, exposing `smartSwapByOrderId` | Callable, but it is an *executor with no liquidity of its own*. Routing through it reaches the same Uniswap and Aerodrome pools this app already calls directly, plus a hop, plus its commission. |
| `Web3-DEX-Router-Solana-V1` | Anchor programs | Solana. Different chain. |
| `web3-solana-rfq-v2` | — | **404. The repository does not exist.** |

None of them offer a free liquidity source for a Base router. Two are
permissioned-counterparty infrastructure, one is a different chain, one is a
pass-through executor, and one is not there. The OKX *aggregator API* would give
routes, but it needs credentials, which is the dependency this project exists to
avoid.

## How it works

**Discovery.** Nothing is hardcoded but factory addresses. For a pair, the
router asks Uniswap V2, SushiSwap and BaseSwap for their pair, Aerodrome for
both its stable and volatile pool, and lists the fee tiers of each
concentrated-liquidity deployment — Uniswap V3 and PancakeSwap V3 — then repeats
that through each intermediate. A V3 fork is a row in a table, not a code path. Every address in `src/lib/chain.ts` is checked
for bytecode by `npm run verify:addresses`, and every token's `symbol()` and
`decimals()` is read from the chain by `npm run verify:tokens`. Both run in CI.
A token entry with the right address and the wrong decimals misprices every
trade in it by a factor of a thousand, silently.

**Quoting.** Constant-product venues are priced off-chain from reserves, with
the fee numerator that fork actually charges — BaseSwap takes 25bp where Uniswap
V2 takes 30. Once reserves are known the whole ladder is arithmetic, multi-hop
included, since a two-hop route is the same function applied twice. All
arithmetic is `bigint`. Aerodrome and Uniswap V3 are quoted on-chain, because a
Solidly stable curve and a concentrated-liquidity tick walk can be reimplemented
off-chain and a reimplementation that drifts by one tick is worse than none.

**Batching.** Everything goes through `Multicall3.aggregate3`, chunked twelve
calls at a time. Chunking is not an optimisation: a V3 quote through a thin pool
walks every initialised tick it crosses and can cost millions of gas, and enough
of those in one batch exceeds the node's `eth_call` gas cap, which rejects the
whole batch rather than the expensive part. WETH/DAI found that.

**Solving.** Each venue is quoted at a geometric ladder of sizes, producing an
output *curve* rather than a number. Because a pool's output is concave in size,
handing each successive slice to whichever venue offers the best marginal rate
converges on the optimum — the water-filling argument. Interpolation between
rungs is piecewise-linear, which on a concave function underestimates: the
solver will never believe a venue is deeper than it is.

**Pricing gas without an oracle.** Comparing a split to a single route needs both
sides in one unit, and the extra cost is in ETH while the benefit is in the token
being bought. Rather than a price feed, the router converts gas through the same
pools it already quoted. The extra-hop cost is 70,000 gas, measured in
`contracts/test/GasProfile.t.sol` as the marginal cost of a second swap.

## Tests

| Suite | What it covers | Network |
| --- | --- | --- |
| `npm run test:unit` | 464 tests: constant-product maths, hop chaining, ladders, interpolation bounds, the splitter, gas-adjusted route choice, slippage floors, path encoding, amount parsing, capacity across decimal mismatches, exposure and slippage recommendation, the backtest statistics, the signature-to-key derivation, one balance across three chains and the gas it reserves, the deposit chain, withdrawal ordering, perp sizing and margin arithmetic, order and cancel payloads signed both ways, resting-order parsing, and the withdrawal amount string | none |
| `contracts` — `Prediction.t.sol` | Off-chain prediction vs. realised fill, 11 cases, mainnet fork | fork |
| `contracts` — `SplitRouter.t.sol` | Atomic split execution, approval hygiene, the call-proxy exploit | fork |
| `contracts` — `GasProfile.t.sol` | The gas constants the router makes decisions with | fork |
| `npm run verify:addresses` | Every address in both chain tables still has bytecode on its chain | RPC |
| `npm run sim:swaps` | Every execution path on Robinhood Chain, simulated at the head | RPC |
| `npm run verify:tokens` | Every token's on-chain symbol and decimals | RPC |
| `npm run probe:venues` | Candidate venues: liquidity, derived fees, router selectors | RPC |
| `npm run backtest [-- robinhood]` | Replays real Base (or Robinhood Chain) swaps against the router, appends to the dataset | RPC |
| `npm run perps` | Spot on every chain beside the Hyperliquid perp, with basis and funding | RPC |

The fork suites share one public RPC endpoint and will fail on contention if
run alongside a backtest — the failure looks like a broken test and is a rate
limit. CI runs them in separate jobs for that reason. Locally, run one at a time
or set `RPC_URL_BASE` (plain `RPC_URL` still means Base; `RPC_URL_ROBINHOOD`
sets Robinhood Chain's).

The unit tests deliberately use no network. The fork tests prove the quoter
agrees with the chain; the unit tests prove the arithmetic behaves at the edges
the chain rarely visits — empty pools, one-wei trades, ladders that collapse,
curves that are flat. Those are where a router either returns nonsense or
divides by zero.

## Beta access

The deployment is invite-only, enforced in middleware rather than announced in a
banner: a gate rendered by the app it is gating has already served the app.

Codes are held as **hashes** in `INVITE_CODE_HASHES`, compared in constant time,
and checked against the current list on **every request** — so removing a hash
revokes access for people already holding the cookie, not just for new entrants.
An unset or empty `INVITE_CODE_HASHES` opens the gate to everyone, which is right
for local development and would silently un-gate production.

What stays reachable without an invitation: the invite screen, the endpoint that
redeems a code, and the three legal documents. Someone deciding whether to accept
the terms should not have to be inside the product to read them, and a risk
disclosure behind a gate is a risk disclosure nobody read.

The API is gated too. The pages are the product, but the endpoints are where the
RPC budget goes, and an ungated API is an open door with a closed sign on it.

`/terms`, `/risk` and `/privacy` are versioned (`LEGAL_VERSION`), and acceptance is
recorded against the version — raising it asks again rather than leaving somebody
bound to a document they never saw. Nobody can sign in without accepting, because
the signature they are about to give permanently controls an account holding their
money.

Working codes live in `BETA_CODES.local.md`, which is gitignored: only their hashes
are ever deployed, so plaintext cannot be recovered from the repo, from
`vercel env`, or from a deployment. Losing that file means issuing new codes rather
than finding the old ones.

## Execution and custody

**This project holds nothing.** Swaps go through Uniswap's `SwapRouter02`,
Aerodrome's `Router`, or the V2 forks' routers — all deployed and audited by
their own teams. There is no contract of this project's on mainnet, no approval
is ever granted to it, and the minimum-output floor is enforced on-chain by
those routers rather than by the interface. A bug here costs a user a bad quote,
not their balance.

Approvals are for the exact trade amount, not `type(uint256).max`. Infinite
approval is the convention and it is why a router bug drains wallets months
later.

The interface refuses to sign a quote older than 30 seconds, and requires an
explicit acknowledgement before executing a trade whose price impact is worse
than 3%.

`contracts/src/SplitRouter.sol` is the atomic split executor — the piece that
would let a solved split settle in one transaction. It is written, fork-tested,
and **not deployed**. Shipping an unaudited contract that takes custody mid-trade
to capture seven basis points is a bad trade. It is in the repo to be read.

Its tests include the attack it exists to refuse: a contract that forwards an
arbitrary payload to an arbitrary target is a universal call proxy, and anyone
who has ever approved it can be robbed by passing `target = token` and
`data = transferFrom(victim, attacker, allowance)`. `SplitRouter` allowlists call
targets at construction, so a token address can never be one.

## Serving

Quotes are cached for 3 seconds with request coalescing, so several browsers
asking for the same pair within one block produce one set of RPC calls rather
than several. Rate limiting is 120 requests per minute per IP. Both are
in-process: on serverless each instance keeps its own copy, so the limit is
per-instance rather than global. That defends against a browser hammering the
endpoint on every keystroke, which is the actual failure mode; it is not a
defence against a distributed attacker, and the code says so.

`GET /api/health` reports chain height, block age and RPC latency, and returns
503 when the head goes stale — a health check that only proves the web process
is up was never answering the question.

## MCP

The router is also a [Model Context Protocol](https://modelcontextprotocol.io)
server, at `https://pathiel-dex.vercel.app/api/mcp` (Streamable HTTP, no auth).

```
claude mcp add --transport http pathiel-dex https://pathiel-dex.vercel.app/api/mcp
```

| Tool | Does |
|---|---|
| `list_tokens` | Every token it can route, with address and decimals |
| `get_quote` | Best single venue, split comparison, price impact, block |
| `build_swap` | Unsigned approve + swap transactions for a given wallet |
| `get_perps` | Stock perp markets beside what the same asset costs to buy outright |

`build_swap` signs nothing and sends nothing. It returns calldata for the
caller's wallet, with the same rules as the interface: exact approvals, an
on-chain minimum-output floor, and a refusal on price impact worse than 3%
unless `acceptHighImpact` is set. It checks the wallet's balance and allowance
first, and omits the approval when one is already in place. It shares the quote
endpoint's cache and rate limit.

### Trading from Claude, with your own key

The hosted server will never accept a private key. To let Claude execute
trades, run the same tools locally over stdio: `scripts/mcp.ts` reads
`PATHIEL_PRIVATE_KEY` from `.env.local` (gitignored) or the environment, and adds
four tools — everything below `if (!account) return`.

| Tool | Does |
|---|---|
| `get_wallet` | The trading address, its ETH for gas, and its token balances |
| `swap` | Quotes, approves the exact amount if needed, swaps, waits for confirmation, reports what arrived |
| `build_perp_order` | Signs a perp order and shows it; sends nothing |
| `perp_order` | Sends exactly the order `build_perp_order` signed — nothing is re-priced |

`swap` applies the same guards as `build_swap`, and dry-runs the swap before
sending it so a trade that would revert costs nothing. `perp_order` takes only the
id from `build_perp_order` and sends that exact signed order, so what was shown is
what reaches the exchange.

One key serves both: `PATHIEL_PRIVATE_KEY` becomes the swap account and is handed
to the Hyperliquid signer as raw bytes, since that side signs with the key rather
than through an account object. **Make it a Hyperliquid agent (API) wallet**, which
can trade but not withdraw — nothing in the code can enforce that, so it is a
choice you make when you set the variable. Either way use a dedicated wallet
holding only what you intend to trade: whatever can call the tool can spend it.

```
# .env.local
PATHIEL_PRIVATE_KEY=0x...
```

Claude Code:

```
claude mcp add pathiel-trade -- node /path/to/pathiel-dex/node_modules/tsx/dist/cli.mjs /path/to/pathiel-dex/scripts/mcp.ts
```

Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`).
Desktop does not inherit your shell's `PATH`, so give `node` by absolute path
(`which node`):

```json
{
  "mcpServers": {
    "pathiel-trade": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/path/to/pathiel-dex/node_modules/tsx/dist/cli.mjs", "/path/to/pathiel-dex/scripts/mcp.ts"]
    }
  }
}
```

Without a key the local server runs read-only, the same as the hosted one.

**On latency.** A cold quote takes 2.4s on a deep pair and about 4s on a
long-tail one. That is three sequential network stages — discovery, then
reserves and pruning together, then the ladder — against a free public endpoint
at roughly 400ms per round trip. Cached repeats are instant. Two rounds of work
went into this (running the gas conversion alongside the ladder instead of
after it, and caching the ETH price rather than rediscovering every route to
compute it) and roughly halved it; the remainder is the public RPC, and the fix
for that is a paid endpoint via `RPC_URL`, not more code.

## Limitations

- **Two hops maximum.** Three-hop routes exist and are not searched.
- **Intermediates are WETH and the chain's dollar** (USDC on Base, USDG on
  Robinhood Chain). A token paired only against something else is invisible to
  the solver.
- **Hooked V4 pools are skipped**, and the V4 pool list is a committed snapshot:
  a pool created after the last `npm run scan:v4` is not seen until it is rerun.
- **Execution is single-venue.** The solved split is analysis until the router
  contract is deployed.
- **No MEV protection.** Transactions go to the public mempool. Base's sequencer
  is first-come rather than an auction, which limits sandwiching relative to L1,
  but that is not a guarantee and none is offered.
- **Fee-on-transfer tokens are unsupported.** The quote assumes the amount sent
  is the amount the pool receives.
- **Public RPC rate-limits.** Set `RPC_URL_ROBINHOOD` / `RPC_URL_BASE` /
  `RPC_URL_XLAYER` for anything beyond casual use. Robinhood Chain has one public
  endpoint.
- **Fifteen tokens on Robinhood Chain** (WETH, USDG, cbBTC and twelve Robinhood
  stock and ETF tokens), taken from the Uniswap default list and limited to
  those with a reachable pool.
- **Twenty-two tokens on Base.** Majors (WETH, cbBTC, USDC, USDT, SOL, cbXRP), Base
  staples and long-tail tokens, and seven Coinbase tokenized stocks (NVDAc,
  AAPLc, GOOGLc, SPCXc, AMZNc, MSFTc, METAc). Adding more is a line in
  `src/lib/chain.ts`; discovery does not care, but a token is only listed once
  it has a pool this router can reach — MSTRc, SNDKc and TSLAc do not yet.
- **Tokenized stocks carry the issuer's restrictions.** Coinbase offers them
  only in eligible jurisdictions outside the US. This router reads pools and
  builds calldata; it does not check who is trading.
- **The MCP `swap` tool's send path is not fork-tested.** The transactions it
  signs are the ones `build_swap` returns, which are simulated against mainnet;
  the send, wait and report steps around them are not yet covered by a test.
- **The backtest sample is small and recent.** Public RPC serves roughly three
  thousand blocks of logs and a few thousand blocks of historical state, so each
  run samples the last few hours. Robinhood Chain's RPC keeps about ten minutes
  of state, so a run there samples the last few minutes. Depth accumulates
  across scheduled runs rather than arriving in one pass.
- **Metrics are per-instance.** In-process counters, so on serverless they
  answer "is this instance healthy", not "how much traffic does the product get".
- **Hooked V4 pools are unenumerable by design.** A pool behind an arbitrary hook
  address cannot be discovered by guessing keys, so V4 coverage is whatever the
  scans can enumerate rather than everything that exists.
- **No funded trade has executed end to end.** Spot routing, cross-chain planning,
  gas purchases and every Hyperliquid action are verified live — the last against
  the venue itself — but nothing has yet moved a real position, on either side.
- **Only the `xyz` perp dex.** Several other HIP-3 dexes list the same tickers —
  `km` and `mkts` (Kinetiq), `cash` (dreamcash), `para` (Paragon), `io`
  (EntropyIO) — and none of them is quoted here, so the mark shown may not be the
  best one available.

## Layout

```
src/lib/quote.ts             discovery, multi-hop candidates, ladder quoting, the splitter
src/lib/chain.ts             every chain's addresses, tokens and venues, as data
src/lib/v4-pools.ts          Robinhood Chain's hookless V4 pools (generated by scripts/scan-v4.ts)
src/lib/execute.ts           calldata for each venue's router, single and multi-hop
src/lib/gas.ts               gas priced in the output token, no oracle
src/lib/serve.ts             cache with coalescing, rate limit
src/lib/solve.ts             one quote end to end, shared by /api/quote and /api/mcp
src/lib/mcp.ts               MCP tools; signing tools only when given a local account
src/lib/exposure.ts          sandwich exposure, drift measured from Swap logs
src/lib/arb.ts               round-trip search, capacity, fragmentation
src/lib/backtest.ts          log decoding, trade replay, summary statistics
src/lib/dataset.ts           reads the committed backtest dataset
src/lib/log.ts               structured logging and in-process metrics
src/lib/cycle.ts             Bellman-Ford negative-cycle search over the rate graph
src/lib/account/derive.ts    the signature-to-key derivation, canonicalised
src/lib/account/plan.ts      one balance across three chains; which dollars move, and the gas
src/lib/account/autoroute.ts prices every chain, buys gas, executes the plan
src/lib/account/margin.ts    dollars into a perp margin account
src/lib/account/trade.ts     signing and sending from the trading account, serialised per chain
src/lib/perp-browser.ts      orders and cancels as payloads for a wallet to sign
src/lib/perp-orders.ts       resting orders, and the asset id a cancel needs
src/lib/perp-withdraw.ts     margin back out, destination fixed to the owner
src/lib/invite.ts            the gate's configuration (Edge-safe: no node:crypto)
src/middleware.ts            the gate itself, applied before a page is served
src/components/ui.tsx        the interface vocabulary: cards, answers, disclosure
src/app/focus.css            the attention layer
src/app/api/                 quote, analyze, cycles, venues, perps, balances, stream (SSE), health, metrics, openapi, mcp
data/backtest.jsonl          append-only dataset, written by the scheduled worker
contracts/src                SplitRouter.sol — written, tested, not deployed
contracts/test               prediction-vs-fill, split router, gas profile
test/solver.test.ts          the maths, no network
scripts/                     fixture generation, benchmarks, address and token verification
```

Stack: Next.js, viem, wagmi with injected wallets only — no WalletConnect, which
would put a third-party relay between the user and their signer and require a
project ID this project would then have to hold.

## Independence

Not affiliated with, endorsed by, or connected to Uniswap, Aerodrome, SushiSwap,
BaseSwap, Coinbase or OKX. It reads their public contracts and routes to their
public routers, which is what those contracts are for. All names are used
descriptively.

**Unaudited. Beta.** It moves real money on mainnet. Read the code before you
use it with size.

MIT licensed.

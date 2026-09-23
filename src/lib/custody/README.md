# Custody

> **NOT IN USE — the product is non-custodial (`src/lib/account/`).**
>
> Nothing outside this directory imports any of it. It is kept because the
> licensed-venue path may want it, and because the audit that followed it is
> worth more than the code.
>
> An adversarial audit found two critical and four high findings. **All six are
> fixed**, each with a regression reproducing the state it demonstrated:
>
> - `recordTrade` was three transactions, so a failed leg left the customer
>   debited for an asset that never arrived, with a poisoned retry and a
>   reconciliation reading balanced. It is one `appendAll` now.
> - The double-spend guard assumed READ COMMITTED without setting it; one
>   managed-Postgres default would have disabled it silently.
> - `MemoryLedger` had no overdraft guard, so local development minted money
>   while Postgres refused — the parity suite proved nothing.
> - A deposit keyed on `logIndex` credited twice after a re-mine; it is now
>   keyed by the transfer's own identity.
> - `verifyChain` accepted a truncated or re-derived history — the forgery an
>   operator would actually commit. Sequence numbers and an expected length.
> - Reconciliation compared the books against a restatement of themselves.
>
> **Still true, and not fixable in code:** there is no KYC, sanctions screening
> or transaction monitoring here, and running this would need a DPT licence
> under the Payment Services Act plus — for tokenised equities and perps — very
> likely a CMS licence under the SFA. Do not put customer money behind this
> without both.

---

# Custody (design notes)

This directory holds other people's money. Everything in it is written on that
assumption, and the rules below are the reason each file looks the way it does.

## What changed

The router quotes and executes on three chains and a perp venue. Custody
inverts the relationship: the **ledger** becomes the product and the router
becomes the thing that moves the pooled funds. A customer no longer connects a
wallet to a chain — they sign in once, deposit once, and trade Base, Robinhood
Chain, X Layer and Hyperliquid against a single balance.

Most of the code here is accounting, not trading. That is the correct
proportion. Custodial venues do not usually fail because a swap routed badly;
they fail because the ledger and the chain disagreed for three weeks and
nobody could tell.

## The rules

**Balances are derived, never stored.** Every movement is two entries summing
to zero (`ledger.ts`). A balance is the sum of an account's entries, so it
cannot drift from them — there is no second number that could. A stored
balance that has drifted agrees with itself forever.

**Entries are immutable.** A mistake is corrected by a reversing entry, so the
history remains the explanation of the balance. "Why did this customer's
balance change" is a question a regulator asks precisely about the cases where
someone was tempted to edit a row.

**Amounts are integer minor units as `bigint`.** No floating point anywhere. A
tenth of a cent lost per trade to binary rounding is both a real loss and an
unprovable one.

**Nothing self-heals.** When the books and the wallets disagree, the
disagreement is the finding. Code that writes an adjusting entry so its own
report comes out clean has destroyed the evidence of whatever caused the gap.

## The files

| File | What it is for |
| --- | --- |
| `ledger.ts` | Double-entry primitives, the `LedgerStore` interface, an in-memory store for tests |
| `accounts.ts` | Deposits, withdrawals and trades as ledger operations |
| `reconcile.ts` | Owed + revenue + inventory against what the wallets hold |
| `compliance.ts` | Daily hash-chained snapshots, retention policy |
| `addresses.ts` | One derived deposit address per customer; wallet roles |
| `auth.ts` | Sign-in with a wallet (EIP-4361), sessions, nonces |
| `withdrawals.ts` | Payments authorised by their own signature |
| `postgres.ts`, `schema.sql` | The store that actually holds it |
| `watcher.ts` | Crediting confirmed deposits |

## Things that will lose money if changed carelessly

- **Deposit references.** A deposit is keyed `venue:txHash` and the ledger
  refuses a duplicate. The watcher *will* see the same transaction twice — a
  restart, a reorg, an overlapping window, two instances. Remove that key and
  the second sighting becomes free money.
- **Withdrawal reservation.** Money moves to a holding account *before*
  anything is broadcast, and is still owed until the payment confirms. Deduct
  on send instead and a failed broadcast is a customer whose balance vanished.
- **Derivation indices.** Assigned once, never reused. Reassigning a retired
  index credits a new customer with the previous one's late deposit.
- **Segregation.** Customer wallets are counted against customer balances;
  operational wallets are not. Paying a withdrawal from the operational pot
  must show up in reconciliation rather than nowhere.
- **The session/withdrawal split.** A session proves who is asking. A
  withdrawal is signed separately over its amount and destination. Collapse
  them and a stolen session becomes a theft.

## Singapore

The venue operates under MAS. Three obligations are reflected in code:
customer assets segregated from operational funds, daily reconciliation with
records retained five years (`compliance.ts`), and travel-rule information on
transfers above SGD 1,500 (`withdrawals.ts`).

Three things are **not** in code and are not made true by this directory:

- **Licensing.** A DPT licence under the Payment Services Act, and — because
  tokenised equities and perpetuals are involved — very likely a CMS licence
  under the Securities and Futures Act. These are different licences, not one
  with an extra box ticked.
- **KYC, sanctions screening and transaction monitoring.** There is no
  onboarding or screening here at all. `userId` is an address that signed a
  message; nothing has established who that is.
- **Trust arrangements and audit.** Segregation is an operational and legal
  structure. The code can refuse to confuse the two pots and can notice when
  they have been confused. It cannot make the customer assets held on trust.

## Production shape

- The **seed never enters this process.** Addresses are derived for display
  and for watching; only the sweeper, in a separate service holding the seed
  in a KMS or HSM, derives anything that can spend. Reading the ledger and
  moving the money are different privileges.
- The **store must serialise transfers against one account**, or two trades
  will both pass a balance check and both spend the same dollar. The
  application-level check in `accounts.ts` is a second line, not the first.
- The **in-memory implementations are for tests.** `MemoryLedger` and
  `MemoryNonces` forget everything when the process ends, and two instances
  would each accept the same nonce once.

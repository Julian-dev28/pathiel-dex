# Custody

> **NOT IN USE, AND NOT SAFE TO WIRE UP.**
>
> The product moved to a non-custodial model (`src/lib/account/`): the customer
> derives their own account from a signature and the venue never holds their
> funds. Nothing outside this directory imports anything in it.
>
> An adversarial audit of this code then found defects that must be fixed
> before a single real deposit reaches it. The worst is not an attack — it is
> ordinary operation:
>
> - **`recordTrade` is not atomic.** It makes three separate `append` calls in
>   three transactions. A failure on the second or third — an ordinary fee
>   calculation against a balance the trade just emptied, or one dropped
>   connection — leaves the first committed, throws an error saying nothing
>   happened, poisons the retry (the reference is already recorded), and leaves
>   the customer's money gone. Reconciliation reports `balanced` and `solvent`
>   throughout.
> - **The double-spend guard depends on an isolation level nothing sets.** The
>   design is correct only at READ COMMITTED; `BEGIN` is issued bare. One
>   managed-Postgres default turns the in-transaction re-check into a no-op,
>   and no test catches it because PGlite is single-connection.
> - **Reconciliation cannot detect value moving between the venue and its
>   customers.** The expression reduces to `held − net deposits`, so a
>   half-applied trade, an operational wallet counted as customer funds, and a
>   balance owed on a chain holding nothing all read as `balanced`.
> - **A reorg or a disagreeing RPC re-keys a deposit and credits it twice.**
>   `logIndex` is a position in the block, not in the transaction, and it is
>   the sole idempotency key.
> - **`verifyChain` does not prevent what it claims.** Truncating the tail or
>   re-deriving the whole history both verify as `ok`.
> - **The two stores are not interchangeable.** `MemoryLedger` has no balance
>   guard, so it will mint money in local development while Postgres refuses.
>
> The full audit, with runnable reproductions, is in the conversation that
> produced this line. Read it before reviving any of this.

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

-- The ledger, as tables.
--
-- Two rules shape everything below, and both come from `ledger.ts`: a balance
-- is the sum of an account's entries, and an entry, once written, is history.
-- So there is no balances table — not as a cache, not as a materialised view,
-- because a stored number that drifted from its entries would agree with
-- itself forever and a reconciliation against it would prove nothing.
--
-- Retention: MAS expects these records kept for five years and reconciled
-- daily, so nothing here deletes or rewrites. Every future migration must be
-- additive; if this table ever needs partitioning by month it can be done by
-- attaching partitions, and dropping an old one is a business decision with a
-- retention date attached, never a migration.

-- Accounts exist to be locked, and hold nothing else.
--
-- One row per account id, no balance column, no total: the row is a place for
-- `SELECT ... FOR UPDATE` to serialise two transfers that would spend the same
-- dollar. Giving it a balance would be the one change that breaks the model.
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  transfer_id TEXT NOT NULL,
  account TEXT NOT NULL,
  asset TEXT NOT NULL,
  -- Exact integers of minor units. NUMERIC(78,0) rather than BIGINT because a
  -- wei-denominated amount carries eighteen decimals and passes 2^63 long
  -- before it is an interesting sum of money; 78 digits covers a uint256.
  -- Never a float: a tenth of a cent lost to binary rounding is both a real
  -- loss and an unprovable one.
  amount NUMERIC(78, 0) NOT NULL,
  reason TEXT NOT NULL,
  -- Unbounded TEXT because the shape of a reference belongs to whatever wrote
  -- it: a deposit is keyed `venue:0xhash#logIndex`, since one transaction can
  -- pay several recipients and a hash alone would credit the first and refuse
  -- the rest. A column sized to today's longest reference is a migration
  -- waiting for the first venue that formats its order ids differently, and in
  -- Postgres TEXT costs nothing over VARCHAR(n).
  reference TEXT,
  at BIGINT NOT NULL,
  -- Write order, which `at` is not: it is supplied by the caller and a trade
  -- deliberately stamps its three transfers with one timestamp. Ordering a
  -- statement by something a caller chooses is how two entries swap places
  -- between two reads of the same account.
  seq BIGSERIAL NOT NULL
);

-- A reference is recorded once per reason, and the database is what says so.
--
-- The race that matters is two watcher instances seeing the same deposit in
-- the same second: both read no prior entry, both credit it. Only an index
-- decides that correctly. The predicate picks the debit side because a
-- transfer writes exactly one of those, so the pair does not collide with
-- itself — and a partial index costs nothing on entries with no reference.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_reference
  ON ledger_entries (reason, reference)
  WHERE reference IS NOT NULL AND amount < 0;

-- The reads that exist: a balance by account, an account's entries
-- newest-first, and every entry for an asset when reconciliation sweeps the
-- book. `amount` rides along on the account index so summing a balance need
-- not visit the table.
CREATE INDEX IF NOT EXISTS ledger_entries_account
  ON ledger_entries (account, seq DESC) INCLUDE (amount);
CREATE INDEX IF NOT EXISTS ledger_entries_asset
  ON ledger_entries (asset, seq DESC);

-- Append-only, enforced rather than intended.
--
-- A correction is a new entry; that is the whole reason the history explains
-- the balance. The REVOKE is the honest half of this — it stops the
-- application role, which is the role that will ever be compromised or
-- mistaken, but not the table owner or a superuser, so it is a guard rail and
-- not a proof. The trigger is what makes an UPDATE impossible for everyone,
-- including a migration written at 3am that meant well.
REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entries FROM PUBLIC;

CREATE OR REPLACE FUNCTION ledger_entries_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only: correct % with a reversing entry', OLD.id;
END;
$$;

DROP TRIGGER IF EXISTS ledger_entries_append_only ON ledger_entries;
CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_append_only();

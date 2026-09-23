/**
 * A deposit address per customer, so money arriving explains itself.
 *
 * The alternative — one shared address and a memo the customer is asked to
 * include — loses funds for a living. People forget the memo, exchanges strip
 * it, and the venue is left with money it cannot attribute and a customer who
 * can prove they sent it. A distinct address per customer makes attribution a
 * property of the transfer rather than of the sender's care.
 *
 * Derivation is hierarchical and deterministic (BIP-32, the standard Ethereum
 * account path), which buys two things that matter under MAS custody rules:
 *
 *   - **Reproducible.** The same master seed and index always give the same
 *     address, so the whole mapping can be rebuilt from the seed if the
 *     database is lost. Addresses are derived, not data that can go missing.
 *   - **One address across every EVM chain.** The same key controls the same
 *     address on Base, Robinhood Chain and X Layer, so a customer has one
 *     deposit address rather than three to confuse.
 *
 * The seed never belongs in this repository, this database, or the web
 * process. In production it lives in a KMS or HSM and the signer that uses it
 * is a separate service: reading the ledger and moving the money are different
 * privileges, and custody infrastructure exists to keep them apart. What runs
 * here derives addresses for display and for the watcher; only the sweeper,
 * in the process that legitimately holds the seed, derives a signer.
 */

import { HDKey } from '@scure/bip32';
import { hdKeyToAccount, mnemonicToAccount, type HDAccount } from 'viem/accounts';
import { getAddress, type Address } from 'viem';

/** Where a customer's deposit address sits on the derivation path. */
export type DepositAccount = {
  userId: string;
  /** Position on the path. Assigned once and never changed or reused. */
  index: number;
  /** The same on every EVM chain this venue settles. */
  address: Address;
};

export class AddressError extends Error {}

/**
 * Derive the account at an index.
 *
 * `m/44'/60'/0'/0/<index>` — the path a hardware wallet uses, so the whole set
 * is recoverable by a third party with ordinary tools in the situation where
 * that matters most. Returns a signing account, so callers that only need an
 * address should use `depositAddress` and stay unable to spend.
 */
export function depositAccount(seed: HDKey | string, index: number): HDAccount {
  assertIndex(index);
  const hd = typeof seed === 'string' ? mnemonicToAccount(seed, { addressIndex: index }) : null;
  return hd ?? hdKeyToAccount(seed as HDKey, { addressIndex: index });
}

/** A customer's deposit address, without the means to spend from it. */
export function depositAddress(seed: HDKey | string, index: number): Address {
  return getAddress(depositAccount(seed, index).address);
}

/** The master node from a mnemonic. Development only; production uses a KMS. */
export const masterKeyFromMnemonic = (mnemonic: string): string => mnemonic;

/**
 * Assign the next index to a customer.
 *
 * Monotonic and never reused: handing a retired index to a new customer would
 * credit them with the previous one's late deposit — precisely the failure
 * this scheme exists to prevent, reintroduced by an allocator being tidy. The
 * caller persists the result; this only states the rule.
 */
export function nextIndex(highestAssigned: number | null): number {
  const next = (highestAssigned ?? -1) + 1;
  assertIndex(next);
  return next;
}

function assertIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index > 2 ** 31 - 1) {
    throw new AddressError(`derivation index must be a non-negative 31-bit integer, got ${index}`);
  }
}

/**
 * Where customer assets are held, kept apart from the venue's own money.
 *
 * MAS requires customer assets to be segregated from operational funds and
 * held on trust. That is an operational arrangement rather than something code
 * can enforce alone, but the code can at least refuse to confuse the two: the
 * wallets are named separately here, and the reconciliation counts only the
 * customer wallets against what customers are owed. Sweeping a deposit into an
 * operational wallet would then show up as a shortfall rather than as nothing.
 */
export type WalletRole = 'customer' | 'operational';

export type VenueWallet = {
  role: WalletRole;
  /** Chain key, or the venue's name for an exchange account. */
  venue: string;
  address: Address;
};

/** Only customer wallets back customer balances. */
export const customerWallets = (wallets: VenueWallet[]): VenueWallet[] =>
  wallets.filter((w) => w.role === 'customer');

'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAccount } from 'wagmi';
import type { Address, Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { AccountKeyring, deriveKey } from '@/lib/account/derive';

const storageKey = (owner: Address) => `pathiel.account.${owner.toLowerCase()}`;

function remembered(owner: Address): Hex | null {
  try {
    return localStorage.getItem(storageKey(owner)) as Hex | null;
  } catch {
    return null;
  }
}

function remember(owner: Address, key: Hex | null): void {
  try {
    if (key) localStorage.setItem(storageKey(owner), key);
    else localStorage.removeItem(storageKey(owner));
  } catch {
    // Storage blocked: the account still works for this tab.
  }
}

/**
 * The trading account, remembered in this browser until sign-out.
 *
 * The derived key is kept in localStorage, per owner wallet, so a reload or a
 * new tab restores the account instead of asking for the signature again.
 * Signing out deletes it. The cost is that anything able to run script on this
 * origin can read the key, which the terms and risk disclosure state.
 *
 * The one piece of state beyond the keyring is which wallet signed for it. The
 * account is derived from a particular owner's signature, so a wallet switched
 * in the extension leaves this tab holding a key that belongs to the previous
 * account — and every balance and withdrawal on the page would then be about
 * one account while the "your wallet" line named another. Changing owner locks.
 */

type TradingAccount = {
  /** Signs trades and withdrawals. Null until the owner signs in. */
  account: PrivateKeyAccount | null;
  /** Where the customer sends funds. Same on every chain. */
  address: Address | null;
  unlock: (signature: Hex) => void;
  lock: () => void;
};

const Ctx = createContext<TradingAccount | null>(null);

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const { address: owner } = useAccount();
  const [keyring] = useState(() => new AccountKeyring());
  const [account, setAccount] = useState<PrivateKeyAccount | null>(null);
  const signedFor = useRef<Address | null>(null);

  /** Forget the key in this tab; what is remembered for the owner stays. */
  const forget = useCallback(() => {
    keyring.lock();
    setAccount(null);
    signedFor.current = null;
  }, [keyring]);

  /** Sign out: forget the key here and delete what is remembered. */
  const lock = useCallback(() => {
    if (signedFor.current) remember(signedFor.current, null);
    forget();
  }, [forget]);

  // A switched wallet drops the previous owner's key, then picks up whatever
  // the new owner left remembered.
  useEffect(() => {
    if (signedFor.current && signedFor.current !== owner) forget();
    if (!owner || signedFor.current === owner) return;
    const key = remembered(owner);
    if (!key) return;
    try {
      setAccount(keyring.restore(key));
      signedFor.current = owner;
    } catch {
      remember(owner, null);
    }
  }, [owner, forget, keyring]);

  const unlock = useCallback(
    (signature: Hex) => {
      const key = deriveKey(signature);
      setAccount(keyring.restore(key));
      signedFor.current = owner ?? null;
      if (owner) remember(owner, key);
    },
    [keyring, owner],
  );

  const value = useMemo(
    () => ({ account, address: account?.address ?? null, unlock, lock }),
    [account, unlock, lock],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTradingAccount(): TradingAccount {
  const value = useContext(Ctx);
  if (!value) throw new Error('useTradingAccount used outside an AccountProvider');
  return value;
}

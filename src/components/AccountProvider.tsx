'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAccount } from 'wagmi';
import type { Address, Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { AccountKeyring } from '@/lib/account/derive';

/**
 * The trading account, for as long as this tab is open.
 *
 * The key is held in an `AccountKeyring` and nowhere else: not localStorage,
 * not sessionStorage, not a cookie, not the URL. A reload asks for the
 * signature again, which is the trade this shape is built on — one extra
 * signature against a key that cannot outlive the tab. There is deliberately
 * no "remember me" to add later.
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

  const lock = useCallback(() => {
    keyring.lock();
    setAccount(null);
    signedFor.current = null;
  }, [keyring]);

  useEffect(() => {
    if (signedFor.current && signedFor.current !== owner) lock();
  }, [owner, lock]);

  const unlock = useCallback(
    (signature: Hex) => {
      setAccount(keyring.unlock(signature));
      signedFor.current = owner ?? null;
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

'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { CHAINS, DEFAULT_CHAIN, isChainKey, type ChainConfig, type ChainKey } from '@/lib/chain';

const STORAGE_KEY = 'pathiel.chain';

const ChainContext = createContext<{ chain: ChainConfig; setChain: (k: ChainKey) => void }>({
  chain: CHAINS[DEFAULT_CHAIN],
  setChain: () => {},
});

/**
 * The chain every page quotes on. One choice for the whole app, so switching on
 * the trade page also moves the depth, venue and tools pages. Remembered in
 * this browser only; the server always renders the default.
 */
export function ChainProvider({ children }: { children: React.ReactNode }) {
  const [key, setKey] = useState<ChainKey>(DEFAULT_CHAIN);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && isChainKey(saved)) setKey(saved);
    } catch {
      /* storage blocked; the default stands */
    }
  }, []);

  const setChain = useCallback((k: ChainKey) => {
    setKey(k);
    try {
      localStorage.setItem(STORAGE_KEY, k);
    } catch {
      /* not remembered, still switched */
    }
  }, []);

  return <ChainContext.Provider value={{ chain: CHAINS[key], setChain }}>{children}</ChainContext.Provider>;
}

export const useChain = () => useContext(ChainContext);

/**
 * A page's token pair, reset to the chain's WETH and dollar when the chain
 * changes. Derived during render rather than reset in an effect: the symbols
 * from the old chain may not exist on the new one, and the render between the
 * switch and an effect would look them up and throw.
 */
export function usePair() {
  const { chain } = useChain();
  const fresh = () => ({ key: chain.key, inSym: chain.weth.symbol, outSym: chain.usd.symbol });
  const [state, setState] = useState(fresh);
  const cur = state.key === chain.key ? state : fresh();
  return {
    chain,
    inSym: cur.inSym,
    outSym: cur.outSym,
    setInSym: (s: string) => setState({ ...cur, inSym: s }),
    setOutSym: (s: string) => setState({ ...cur, outSym: s }),
    flip: () => setState({ ...cur, inSym: cur.outSym, outSym: cur.inSym }),
  };
}

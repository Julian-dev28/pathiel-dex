'use client';

import { CHAIN_LIST } from '@/lib/chain';
import { useChain } from './ChainProvider';

/**
 * A chain control for the pages where the chain is the question.
 *
 * Buying does not need one: which chain a trade lands on is arithmetic, and
 * the router answers it per trade. But "what venues exist on X Layer" and
 * "how deep is this pool" are questions *about* a chain, and a page answering
 * them has to let you say which. So the control moved out of the masthead,
 * where it implied every page needed an answer, and into the pages that do.
 */
export function ChainTabs() {
  const { chain, setChain } = useChain();
  return (
    <div className="tabs-main" role="tablist" aria-label="Chain">
      {CHAIN_LIST.map((c) => (
        <button
          key={c.key}
          type="button"
          role="tab"
          aria-selected={c.key === chain.key}
          className={`tab${c.key === chain.key ? ' on' : ''}`}
          onClick={() => setChain(c.key)}
        >
          {c.name}
        </button>
      ))}
    </div>
  );
}

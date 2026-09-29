'use client';

import { useState } from 'react';
import { BuyPanel } from './BuyPanel';
import { Terminal } from './Terminal';
import { Segmented } from './ui';

type Mode = 'swap' | 'buy';

/**
 * One trade surface. Swap is a pair on a chain you pick; Buy spends the
 * trading account's dollars on a stock and lets the router pick the chain.
 * Only the chosen one is mounted, so the other is not quoting in the
 * background.
 */
export function TradeView() {
  const [mode, setMode] = useState<Mode>('swap');
  return (
    <>
      <div style={{ marginBottom: 14 }}>
        <Segmented
          label="Trade type"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'swap', label: 'Swap' },
            { value: 'buy', label: 'Buy stocks' },
          ]}
        />
      </div>
      {mode === 'swap' ? <Terminal /> : <BuyPanel />}
    </>
  );
}

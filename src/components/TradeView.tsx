'use client';

import { useState } from 'react';
import { BuyPanel } from './BuyPanel';
import { PerpsTrade } from './PerpsTrade';
import { Terminal } from './Terminal';
import { Segmented } from './ui';

type Mode = 'swap' | 'buy' | 'perps';

/**
 * One trade surface. Swap is any pair, routed to whichever chain and venue
 * pays best; Buy spends the trading account's dollars on a stock; Perps opens
 * a leveraged position on Hyperliquid. Only the chosen one is mounted, so the
 * others are not quoting in the background.
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
            { value: 'perps', label: 'Perps' },
          ]}
        />
      </div>
      {mode === 'swap' ? <Terminal /> : mode === 'buy' ? <BuyPanel /> : <PerpsTrade />}
    </>
  );
}

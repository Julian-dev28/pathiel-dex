'use client';

import { useState } from 'react';
import { PerpsTrade } from './PerpsTrade';
import { Terminal } from './Terminal';
import { Segmented } from './ui';

type Mode = 'swap' | 'perps';

/**
 * One trade surface on the one trading account. Swap is any asset for any
 * other, routed across every chain the account holds money on; Perps opens a
 * leveraged position on Hyperliquid. Only the chosen one is mounted, so the
 * other is not quoting in the background.
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
            { value: 'perps', label: 'Perps' },
          ]}
        />
      </div>
      {mode === 'swap' ? <Terminal /> : <PerpsTrade />}
    </>
  );
}

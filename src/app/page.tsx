import { BuyPanel } from '@/components/BuyPanel';
import { PageHead } from '@/components/ui';
import { Terminal } from '@/components/Terminal';
import { ToolsView } from '@/components/ToolsView';

/**
 * Trade: buying first, then the pair-level tools.
 *
 * An asset and an amount of dollars is the whole of what someone arriving here
 * has to say, so the buy panel leads. The terminal and its readings follow for
 * anyone who wants to point at a specific chain and pair. Both halves of the
 * tools read the same pair from `usePair`, so the tabs and token selects drive
 * the swap ticket below them.
 */
export default function Page() {
  return (
    <>
      <PageHead
        title="Trade"
        lede="Buy from your trading account, or pick a chain and pair and swap directly."
      />
      <BuyPanel />
      <ToolsView />
      <Terminal />
    </>
  );
}

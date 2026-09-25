import { Terminal } from '@/components/Terminal';
import { ToolsView } from '@/components/ToolsView';

export const metadata = { title: 'Execution tools' };

/**
 * The pair-level page: a chain, a pair, a swap, and the five readings of it.
 *
 * The terminal sits here rather than on the front page because it is the one
 * surface where a chain is genuinely the question being asked. Both halves read
 * the same pair from `usePair`, so the tabs and token selects above drive the
 * swap ticket below.
 */
export default function Page() {
  return (
    <>
      <ToolsView />
      <Terminal />
    </>
  );
}

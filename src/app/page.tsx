import { BuyPanel } from '@/components/BuyPanel';
import { Terminal } from '@/components/Terminal';

/**
 * Buying first, the router underneath it.
 *
 * Most people arriving here want an asset for an amount of dollars and have no
 * view on which chain that should happen on — so that is the form they meet.
 * The pair-by-pair terminal stays below for anyone who does have a view, and
 * because it is the thing that proves the quote: every figure the panel above
 * acts on comes from the same routing it shows.
 */
export default function Page() {
  return (
    <>
      <BuyPanel />
      <Terminal />
    </>
  );
}

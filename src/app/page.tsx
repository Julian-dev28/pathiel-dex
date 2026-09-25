import { BuyPanel } from '@/components/BuyPanel';

/**
 * Buying, and nothing else.
 *
 * An asset and an amount of dollars is the whole of what someone arriving here
 * has to say. The pair-by-pair terminal used to sit underneath this panel, but
 * a terminal is a thing you point at a chain, and leaving it here meant the
 * first screen still had a chain on it — which is the one thing this product
 * exists to take away. It moved to the tools page, where picking a pair and a
 * chain is the stated job.
 */
export default function Page() {
  return <BuyPanel />;
}

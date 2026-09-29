import { TradeView } from '@/components/TradeView';
import { PageHead } from '@/components/ui';

export default function Page() {
  return (
    <>
      <PageHead
        title="Trade"
        lede="One account across every chain. Swap anything, or trade perps with leverage — the router decides where."
      />
      <TradeView />
    </>
  );
}

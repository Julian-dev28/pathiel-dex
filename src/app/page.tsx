import { TradeView } from '@/components/TradeView';
import { PageHead } from '@/components/ui';

export default function Page() {
  return (
    <>
      <PageHead
        title="Trade"
        lede="Swap any pair, buy stocks, or trade perps with leverage. The router picks the chain."
      />
      <TradeView />
    </>
  );
}

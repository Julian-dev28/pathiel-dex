import { TradeView } from '@/components/TradeView';
import { PageHead } from '@/components/ui';

export default function Page() {
  return (
    <>
      <PageHead
        title="Trade"
        lede="Swap any pair on the chain you pick, or buy stocks from your trading account."
      />
      <TradeView />
    </>
  );
}

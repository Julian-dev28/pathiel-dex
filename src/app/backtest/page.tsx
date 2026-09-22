import { aggregate, type Aggregate } from '@/lib/dataset';
import { CHAIN_LIST, type ChainKey } from '@/lib/chain';
import { BacktestView } from '@/components/BacktestView';

export const metadata = { title: 'Backtest' };
export const dynamic = 'force-dynamic';

export default function Page() {
  const byChain = Object.fromEntries(CHAIN_LIST.map((c) => [c.key, aggregate(c.key)])) as Record<ChainKey, Aggregate>;
  return <BacktestView byChain={byChain} />;
}

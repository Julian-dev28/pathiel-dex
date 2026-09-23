import { AccountProvider } from '@/components/AccountProvider';
import { TradingAccount } from '@/components/TradingAccount';
import { BalancesView } from '@/components/BalancesView';

export const metadata = { title: 'Account' };

/**
 * The trading account first, the connected wallet's balances underneath it.
 *
 * Both are this person's money and neither replaces the other: the panel above
 * is the account trades are signed from, the view below is what the wallet
 * that funds it still holds.
 */
export default function Page() {
  return (
    <AccountProvider>
      <TradingAccount />
      <BalancesView />
    </AccountProvider>
  );
}

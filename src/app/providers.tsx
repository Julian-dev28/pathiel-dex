'use client';

import { WagmiProvider, createConfig, http } from 'wagmi';
// From @wagmi/core rather than wagmi/connectors: that barrel re-exports every
// connector, including Coinbase's, which drags in @base-org/account and a
// half-installed x402 dependency tree that fails the build. We want one
// connector, so we import the one.
import { injected } from '@wagmi/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { CHAINS } from '@/lib/chain';
import { ChainProvider } from '@/components/ChainProvider';

/**
 * Injected connectors only — MetaMask, Rabby, Coinbase Wallet, Brave.
 *
 * WalletConnect would add phone wallets and costs a free project ID, but it
 * also adds a third-party relay between the user and their signer, and a key
 * this project would then have to hold. For a router whose whole claim is that
 * it depends on nothing but public RPC, that trade is not worth one connector.
 */
export const wagmiConfig = createConfig({
  chains: [CHAINS.robinhood.viem, CHAINS.base.viem],
  connectors: [injected()],
  transports: {
    [CHAINS.robinhood.id]: http(CHAINS.robinhood.rpcUrls[0]),
    [CHAINS.base.id]: http(CHAINS.base.rpcUrls[0]),
  },
  ssr: true,
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}

export function Providers({ children }: { children: React.ReactNode }) {
  // wagmi skips EIP-6963 discovery entirely when `ssr` is set, and drops late
  // announcements until its storage has hydrated (see createConfig). Wallets
  // announce themselves during exactly that window, so with two extensions
  // installed the only connector left is the generic one, pointing at whichever
  // of them won the race for window.ethereum. Asking again after mount arrives
  // after hydration, so each wallet registers as its own named connector.
  useEffect(() => {
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  }, []);

  // One client per mount, not a module singleton: a shared client leaks one
  // user's cached quotes into the next request under SSR.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 4_000, retry: 1, refetchOnWindowFocus: false } },
      }),
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ChainProvider>{children}</ChainProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

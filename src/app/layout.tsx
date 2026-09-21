import type { Metadata, Viewport } from 'next';
import { Providers } from './providers';
import { Masthead } from '@/components/Masthead';
import { ThemeScript } from '@/components/ThemeToggle';
import './pathiel.css';
import './router.css';
import './focus.css';

const DESCRIPTION =
  'Quotes every major Robinhood Chain and Base venue directly from pool state, solves the optimal split across them, and executes through the venues own audited routers. No aggregator API, no keys.';

export const metadata: Metadata = {
  metadataBase: new URL('https://pathiel-dex.vercel.app'),
  title: {
    default: 'PATHIEL DEX — on-chain route solver for Robinhood Chain and Base',
    template: '%s — PATHIEL DEX',
  },
  description: DESCRIPTION,
  applicationName: 'PATHIEL DEX',
  keywords: ['Robinhood Chain', 'Base', 'DEX', 'router', 'Uniswap', 'Aerodrome', 'swap', 'DeFi'],
  openGraph: {
    type: 'website',
    title: 'PATHIEL DEX — on-chain route solver for Robinhood Chain and Base',
    description: DESCRIPTION,
    siteName: 'PATHIEL DEX',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'PATHIEL DEX',
    description: DESCRIPTION,
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Matches --bar so the mobile browser chrome does not sit on a different
  // colour to the masthead directly beneath it.
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#060d0c' },
    { media: '(prefers-color-scheme: light)', color: '#0a1211' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body>
        <a className="c-skip" href="#main">
          Skip to content
        </a>
        <Providers>
          <Masthead />
          <main className="c-shell c-wide" id="main">{children}</main>
          <footer className="site-foot">
            <div className="site-foot-inner">
              <span>
                Unaudited, beta. Routes are computed here; trades execute through each
                venue&rsquo;s own audited router. Not affiliated with Uniswap, Aerodrome,
                SushiSwap, BaseSwap or Coinbase.
              </span>
              <a href="/docs">Method &amp; limitations</a>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}

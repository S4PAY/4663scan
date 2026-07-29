import type { Metadata, Viewport } from 'next';
import { JetBrains_Mono, Space_Grotesk } from 'next/font/google';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Footer } from '@/components/Footer';
import { Nav } from '@/components/Nav';
import { PriceStrip } from '@/components/PriceStrip';
import { SearchBar } from '@/components/SearchBar';
import './globals.css';

/* Brand type: clean geometric sans for UI labels, terminal mono for chain
   data. Self-hosted via next/font (size-adjusted fallbacks keep CLS at 0). */
const sans = Space_Grotesk({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans-next',
  display: 'swap',
});
const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono-next',
  display: 'swap',
});

const DESCRIPTION =
  'Fast block explorer for Robinhood Chain (chain id 4663): blocks, transactions, tokens and tokenized stocks, live from mainnet.';

export const metadata: Metadata = {
  metadataBase: new URL('https://4663scan.io'),
  title: {
    template: '%s · RHEX',
    default: 'RHEX — Robinhood Chain explorer',
  },
  description: DESCRIPTION,
  openGraph: {
    siteName: 'RHEX',
    type: 'website',
    title: 'RHEX — Robinhood Chain explorer',
    description: DESCRIPTION,
    // Native banner dimensions (1734x907) — its own grid texture runs to the
    // edges, so padding it to a different aspect would show a visible seam;
    // explicit width/height lets platforms that respect them scale it
    // correctly instead of assuming 1200x630 (close to that ratio anyway).
    images: [{ url: '/og-banner.png', width: 1734, height: 907 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'RHEX — Robinhood Chain explorer',
    description: DESCRIPTION,
    images: ['/og-banner.png'],
  },
  icons: {
    icon: [
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon.ico', sizes: 'any' },
    ],
    apple: '/apple-touch-icon.png',
  },
};

export const viewport: Viewport = {
  themeColor: '#0a0a0a',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`dark ${sans.variable} ${mono.variable}`}>
      {/* overflow-x-hidden is a sitewide backstop: nothing here should ever
          need horizontal page scroll. Containers that legitimately scroll
          sideways (.raw, wide tables) manage their own overflow-x-auto
          internally, which this doesn't affect. */}
      <body className="flex min-h-screen flex-col overflow-x-hidden">
        <header className="glass sticky top-0 z-40 border-b">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5">
            <Link
              href="/"
              className="order-1 flex items-center gap-1.5 font-mono text-base font-semibold tracking-tight"
            >
              {/* alt="" — decorative next to the adjacent wordmark text,
                  which already names the site for assistive tech. Glow
                  preserved (not the crisp favicon cutout): only ever shown
                  on the site's own near-black background. */}
              <img src="/mark-header.png" alt="" className="h-6 w-auto shrink-0" />
              <span className="text-accent">RHEX</span>
            </Link>
            <div className="order-3 w-full min-w-0 sm:order-2 sm:w-auto sm:flex-1">
              <SearchBar />
            </div>
            <div className="order-2 ml-auto sm:order-3 sm:ml-0">
              <Nav />
            </div>
          </div>
        </header>
        <PriceStrip />
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-5">{children}</main>
        <Footer />
      </body>
    </html>
  );
}

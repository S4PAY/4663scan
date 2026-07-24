import type { MetadataRoute } from 'next';

/**
 * Next's file convention: auto-served at /manifest.webmanifest with the
 * right <link rel="manifest">, no metadata wiring needed. Icons-only — this
 * isn't an installable PWA (no offline support), just what completes the
 * favicon set for Android's home-screen/task-switcher icon expectations.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: '4663scan — Robinhood Chain explorer',
    short_name: '4663scan',
    description:
      'Block explorer for Robinhood Chain (chain id 4663): blocks, transactions, tokens and tokenized stocks.',
    start_url: '/',
    display: 'browser',
    background_color: '#0a0a0a',
    theme_color: '#0a0a0a',
    icons: [
      { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}

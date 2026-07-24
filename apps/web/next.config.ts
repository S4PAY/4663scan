import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import type { NextConfig } from 'next';

// All configuration lives in the repo-root .env.
loadDotenv({ path: join(import.meta.dirname, '..', '..', '.env'), quiet: true });

const nextConfig: NextConfig = {
  transpilePackages: ['@4663scan/shared'],
  poweredByHeader: false,
  // public/ files get Next's default `max-age=0` unless overridden here.
  // Logos are self-hosted precisely so they can be edge-cached hard (M6
  // charter: "never hotlink a third party on every pageview") — 7 days +
  // stale-while-revalidate, not `immutable`/1y, since a token's logo can
  // legitimately be re-fetched later if Robinhood updates it upstream.
  async headers() {
    return [
      {
        source: '/token-logos/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=604800, stale-while-revalidate=86400',
          },
        ],
      },
    ];
  },
};

export default nextConfig;

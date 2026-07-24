'use client';

import { useEffect, useState } from 'react';

interface PriceData {
  ok: boolean;
  usdPrice: number | null;
  change24h: number | null;
  sparkline: number[];
}

function formatUsd(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: n >= 100 ? 0 : 2,
  });
}

function Sparkline({ points, rising }: { points: number[]; rising: boolean }) {
  if (points.length < 2) return null;
  const w = 48;
  const h = 18;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min;
  // A perfectly flat 14 days (span 0) would otherwise divide to y=h for
  // every point — a hairline glued to the bottom edge, half-clipped by the
  // svg's own overflow:hidden. Center it instead.
  const coords = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = span === 0 ? h / 2 : h - ((p - min) / span) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="shrink-0"
      role="img"
      aria-label="ETH price, last 14 days"
    >
      <polyline
        points={coords}
        fill="none"
        stroke={rising ? 'var(--color-accent)' : 'var(--color-red)'}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Client-only, mounts after hydration and never blocks page render. Renders
 * nothing while loading or on any failure — a missing price strip is a
 * strictly safer default than a broken one. Fetches the same-origin
 * /price-feed route (see app/price-feed/route.ts — deliberately not under
 * /api/, which production Caddy proxies straight to the backend API), which
 * owns the actual CoinGecko call and its caching; this component just polls
 * that cache once per mount.
 */
export function PriceStrip() {
  const [data, setData] = useState<PriceData | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/price-feed')
      .then((res) => (res.ok ? (res.json() as Promise<PriceData>) : Promise.reject()))
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch(() => {
        // Leave data null — the strip stays absent.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data?.ok || data.usdPrice == null) return null;

  const change = data.change24h;
  const positive = change == null || change >= 0;

  return (
    <div className="border-b border-border bg-bg/60">
      <div className="mx-auto flex max-w-5xl items-center gap-2 overflow-hidden px-4 py-1.5 text-xs">
        <span className="badge shrink-0">ETH · Gas Token</span>
        <span className="mono shrink-0 font-medium text-text">
          {formatUsd(data.usdPrice)}
        </span>
        {change != null && (
          <span className={`mono shrink-0 ${positive ? 'text-accent' : 'text-red'}`}>
            {positive ? '▲' : '▼'} {Math.abs(change).toFixed(2)}%
          </span>
        )}
        <div className="hidden shrink-0 sm:block">
          <Sparkline points={data.sparkline} rising={positive} />
        </div>
        <span className="ml-auto hidden shrink-0 text-muted sm:inline">
          24h · via CoinGecko
        </span>
      </div>
    </div>
  );
}

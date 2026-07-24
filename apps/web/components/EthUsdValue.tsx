'use client';

import { useEffect, useState } from 'react';

interface PriceData {
  ok: boolean;
  usdPrice: number | null;
}

function formatUsd(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: n >= 100 ? 0 : 2,
  });
}

/**
 * ETH balance × the same /price-feed CoinGecko-backed price PriceStrip uses
 * (client-side fetch, same reasoning as PriceStrip: same-origin Next route,
 * not the /v1 API — see app/price-feed/route.ts). Renders nothing while
 * loading or on any failure, same "absent is safer than wrong" rule as
 * PriceStrip — never shows a stale or fabricated USD figure.
 */
export function EthUsdValue({ balanceWei }: { balanceWei: string | null }) {
  const [usdPrice, setUsdPrice] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/price-feed')
      .then((res) => (res.ok ? (res.json() as Promise<PriceData>) : Promise.reject()))
      .then((json) => {
        if (!cancelled && json.ok && json.usdPrice != null) setUsdPrice(json.usdPrice);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (balanceWei == null || usdPrice == null) return null;
  const eth = Number(balanceWei) / 1e18;
  if (!Number.isFinite(eth)) return null;
  return <span className="text-sm text-muted">≈ {formatUsd(eth * usdPrice)}</span>;
}

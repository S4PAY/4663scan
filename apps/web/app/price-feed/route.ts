/**
 * ETH price, 24h change and a 14-day daily sparkline, proxied from CoinGecko
 * and cached at this route via Next's fetch data cache. This chain has no
 * native token — gas is paid in ETH — so this is intentionally the only
 * price this app ever surfaces; never derive or display a "4663" price.
 *
 * Deliberately NOT under /api/ — production Caddy has `handle /api/* {
 * uri strip_prefix /api; reverse_proxy 127.0.0.1:4663 }`, which forwards
 * everything under /api/ straight to the Fastify API service unconditionally
 * (no fallback). A Next.js route at /api/price would 404 there without ever
 * reaching this app. See docs/ops.md's Cloudflare cache rules: this path
 * isn't in their bypass list, so it falls under "everything else — respect
 * origin Cache-Control", which is exactly what the header below relies on.
 *
 * Cache-Control on the response is a backstop for any layer in front of
 * this route; the real dedupe of upstream calls happens via
 * `next: { revalidate }` on the two fetches below, which is process-wide,
 * not per-request.
 */

export const revalidate = 60;

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

interface PriceResponse {
  ok: boolean;
  usdPrice: number | null;
  change24h: number | null;
  /** Daily close, oldest first; empty when the chart fetch failed or is cold. */
  sparkline: number[];
}

const FAILURE_HEADERS = {
  // Short TTL so a transient CoinGecko outage heals on its own quickly.
  'Cache-Control': 'public, max-age=15, stale-while-revalidate=60',
};

export async function GET() {
  const [priceOutcome, chartOutcome] = await Promise.allSettled([
    fetch(
      `${COINGECKO_BASE}/simple/price?ids=ethereum&vs_currencies=usd&include_24hr_change=true`,
      { next: { revalidate: 60 } },
    ),
    fetch(
      `${COINGECKO_BASE}/coins/ethereum/market_chart?vs_currency=usd&days=14&interval=daily`,
      { next: { revalidate: 300 } },
    ),
  ]);

  // Price is the load-bearing field — without it there's nothing to show,
  // so any failure here (network, non-2xx, bad JSON, non-finite value) is
  // a hard failure for the whole response.
  let usdPrice: number;
  let change24h: number | null;
  try {
    if (priceOutcome.status !== 'fulfilled' || !priceOutcome.value.ok) {
      throw new Error('coingecko price fetch failed');
    }
    const priceJson = (await priceOutcome.value.json()) as {
      ethereum?: { usd?: number; usd_24h_change?: number };
    };
    const usd = priceJson.ethereum?.usd;
    if (typeof usd !== 'number' || !Number.isFinite(usd)) {
      throw new Error('coingecko: missing or non-finite usd price');
    }
    usdPrice = usd;
    const chg = priceJson.ethereum?.usd_24h_change;
    change24h = typeof chg === 'number' && Number.isFinite(chg) ? chg : null;
  } catch {
    const body: PriceResponse = { ok: false, usdPrice: null, change24h: null, sparkline: [] };
    return Response.json(body, { headers: FAILURE_HEADERS });
  }

  // The sparkline is decorative: a fetch rejection, non-2xx, or malformed
  // body (CoinGecko's free tier occasionally serves an HTML rate-limit page
  // with a 200) degrades to an empty array without discarding the price we
  // already have — deliberately a separate try/catch from the block above,
  // and Promise.allSettled (not Promise.all) so this failing can never
  // drag the price fetch down with it.
  let sparkline: number[] = [];
  try {
    if (chartOutcome.status === 'fulfilled' && chartOutcome.value.ok) {
      const chartJson = (await chartOutcome.value.json()) as { prices?: [number, number][] };
      sparkline = (chartJson.prices ?? []).map(([, p]) => p);
    }
  } catch {
    // Leave sparkline empty.
  }

  const body: PriceResponse = { ok: true, usdPrice, change24h, sparkline };
  return Response.json(body, {
    headers: { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=300' },
  });
}

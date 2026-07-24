import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { stockTokens, type Db } from '@4663scan/shared/db';

const FETCH_TIMEOUT_MS = 10_000;
/**
 * Chainlink's own published per-network feed directory (the same data that
 * backs docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood
 * — that page embeds a large client-rendered table with no small JSON
 * response, so this is the underlying static file it reads from instead).
 * Confirmed live 2026-07-24: 56 feeds, tickers cross-checked against every
 * one of this chain's 96 registry tokens with zero mismatches.
 */
const CHAINLINK_ROBINHOOD_FEEDS_URL =
  'https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json';

interface ChainlinkFeed {
  name?: string;
  proxyAddress?: string;
}

/** "Robinhood AAPL / USD" / "Robinhood SGOV-USD" → "AAPL" / "SGOV". Chainlink
 *  also lists plain crypto/forex feeds (BTC / USD, LINK / USD, …) on the
 *  same network — deliberately not matched, only the Robinhood-prefixed
 *  stock/ETF feeds are what this app cares about. */
const FEED_NAME_PATTERN = /^Robinhood ([A-Z.]+)\s*(?:\/\s*USD|-USD)/;

export async function fetchChainlinkTickerMap(): Promise<Map<string, string>> {
  const res = await fetch(CHAINLINK_ROBINHOOD_FEEDS_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`chainlink feed directory responded ${res.status}`);
  const feeds = (await res.json()) as ChainlinkFeed[];
  const map = new Map<string, string>();
  for (const feed of feeds) {
    const match = feed.name ? FEED_NAME_PATTERN.exec(feed.name) : null;
    if (match && feed.proxyAddress) {
      map.set(match[1]!, feed.proxyAddress.toLowerCase());
    }
  }
  return map;
}

/** One-shot / periodic: match every stock token's ticker against Chainlink's
 *  published feed list. Soft — most tokens simply won't have one yet. */
export async function backfillChainlinkFeeds(
  db: Db,
  logger: Logger,
): Promise<{ matched: number; checked: number }> {
  let tickerMap: Map<string, string>;
  try {
    tickerMap = await fetchChainlinkTickerMap();
  } catch (err) {
    logger.warn({ err }, 'chainlink feed directory fetch failed; skipping this pass');
    return { matched: 0, checked: 0 };
  }
  const rows = await db
    .select({
      tokenAddress: stockTokens.tokenAddress,
      ticker: stockTokens.ticker,
      chainlinkFeed: stockTokens.chainlinkFeed,
    })
    .from(stockTokens);

  let matched = 0;
  for (const row of rows) {
    const feed = tickerMap.get(row.ticker);
    if (feed && feed !== row.chainlinkFeed) {
      await db
        .update(stockTokens)
        .set({ chainlinkFeed: feed })
        .where(eq(stockTokens.tokenAddress, row.tokenAddress));
      matched += 1;
    }
  }
  return { matched, checked: rows.length };
}

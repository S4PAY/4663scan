import {
  createPublicClient,
  defineChain,
  fallback,
  http,
  webSocket,
  type Chain,
  type FallbackTransport,
  type PublicClient,
} from 'viem';
import type { Env } from './env.js';

export function robinhoodChain(env: Env): Chain {
  return defineChain({
    id: env.CHAIN_ID,
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: {
      default: { http: httpUrls(env), webSocket: env.RPC_WSS ? [env.RPC_WSS] : [] },
    },
  });
}

export function httpUrls(env: Env): string[] {
  return [env.RPC_HTTP_PRIMARY, ...fallbackUrls(env)];
}

/** Every configured non-primary endpoint, in priority order. */
export function fallbackUrls(env: Env): string[] {
  return [
    env.RPC_HTTP_FALLBACK,
    env.RPC_HTTP_TERTIARY,
    env.RPC_HTTP_QUATERNARY,
    env.RPC_HTTP_QUINARY,
  ].filter((url): url is string => Boolean(url));
}

/**
 * Fallback over all configured HTTP endpoints with JSON-RPC batching.
 * Batching multiplexes many logical calls into one HTTP request, which keeps
 * us well under per-IP request-rate caps.
 *
 * Retry contract: transport-level retries are DISABLED (`retryCount: 0` on
 * both the inner http() transports and the fallback wrapper — viem lets the
 * inner config win, so both must be explicit). One logical JSON-RPC call
 * therefore performs at most one HTTP attempt per endpoint (~3 total via
 * fallback failover) instead of viem's default nested retries (up to
 * 4 passes × 3 endpoints × 3 attempts = 36 requests), which would bypass the
 * indexer's rate limiter exactly when endpoints are already throttling.
 * Callers own retry policy: the indexer's loops back off and re-acquire
 * limiter tokens per attempt; the API fails over across every endpoint once
 * and then surfaces the error to its HTTP client (fail fast, no hidden
 * multi-minute stalls).
 */
export function makeHttpTransport(env: Env): FallbackTransport {
  return fallback(
    httpUrls(env).map((url) =>
      http(url, {
        batch: { batchSize: 10, wait: 25 },
        retryCount: 0,
        timeout: 15_000,
      }),
    ),
    { rank: false, retryCount: 0 },
  );
}

export function makePublicClient(env: Env): PublicClient {
  return createPublicClient({
    chain: robinhoodChain(env),
    transport: makeHttpTransport(env),
  });
}

/**
 * A client pinned to exactly one HTTP endpoint — no fallback rotation. Exists
 * for callers that need to deliberately bypass the primary-preferring
 * fallback() client: viem's fallback transport only rotates to the next URL
 * when a call throws (network error, non-2xx, JSON-RPC error), so a primary
 * node that's stuck-but-still-answering (e.g. serving a frozen block number,
 * or a well-formed `null` for a block it hasn't caught up to) never triggers
 * failover on its own — that response is, from viem's point of view, a
 * success. A caller who's independently detected that kind of staleness (the
 * indexer's head-follower does, via a "no progress in N seconds" watchdog)
 * needs a way to force a specific URL instead of hoping the wrapper notices.
 * The head-follower builds one of these per entry in fallbackUrls() and
 * rotates across them — no single free-tier provider's own rate limit
 * should be able to cap recovery throughput once more than one is available.
 *
 * Batched, at a smaller size than the primary's. An earlier version of this
 * disabled batching entirely after seeing a batched call come back as a
 * single malformed (non-array) error object — but confirmed directly since:
 * that only happens when the endpoint is already near its own rate limit; an
 * isolated batch request succeeds and returns a proper response array.
 * Batching genuinely works correctly the rest of the time, so disabling it
 * outright just meant needing many more individual HTTP requests to fetch
 * the same data — directly counterproductive against a rate limit that (as
 * far as this client can tell) counts requests, not JSON-RPC calls within
 * them. Caller must still treat ANY error from this client as a signal to
 * back off (not just ones shaped like a clean 429) — see head.ts.
 */
export function makeDirectHttpClient(env: Env, url: string): PublicClient {
  return createPublicClient({
    chain: robinhoodChain(env),
    transport: http(url, {
      batch: { batchSize: 8, wait: 25 },
      retryCount: 0,
      timeout: 15_000,
    }),
  });
}

/** WSS client for newHeads subscriptions. Returns null when RPC_WSS is unset. */
export function makeWsClient(env: Env): PublicClient | null {
  if (!env.RPC_WSS) return null;
  return createPublicClient({
    chain: robinhoodChain(env),
    transport: webSocket(env.RPC_WSS, { retryCount: 3, timeout: 15_000 }),
  });
}

import { desc } from 'drizzle-orm';
import { blocks } from '@4663scan/shared/db/schema';
import { httpUrls, makeDirectHttpClient } from '@4663scan/shared/chain';
import type { AppContext } from '../context.js';
import { dedupe } from '../lib/ttl.js';

/** Cached views of the RPC chain head (≤2s stale) and DB head (≤1s stale). */
export function makeHeads(ctx: AppContext) {
  let rpc: { v: number; exp: number; at: number } | null = null;
  let idx: { v: number; exp: number } | null = null;

  /**
   * One pinned client per configured endpoint (primary + every fallback),
   * queried directly and reduced by max — NOT ctx.client (the primary-
   * preferring fallback() wrapper used elsewhere for state reads). That
   * wrapper only rotates away from an endpoint that throws, so a primary
   * that's stuck-but-still-answering (serving a frozen block number without
   * erroring — confirmed still the case here) never fails over on its own.
   * Once indexing has since passed that frozen number, Math.max(rpcHead,
   * indexedBlock) below would silently and permanently resolve to
   * indexedBlock, misreporting a large, real, still-growing backlog as
   * fully caught up. Querying every endpoint directly and taking the max
   * self-heals the same way head.ts's fallback pool does for the indexer,
   * without any of that pool's fetch/backoff machinery — this is one cheap
   * eth_blockNumber call per endpoint every ≤2s, not sustained block
   * fetching, so no per-endpoint cooldown is needed.
   */
  const headClients = httpUrls(ctx.env).map((url) => makeDirectHttpClient(ctx.env, url));

  async function fetchRpcHead(): Promise<number> {
    const v = await dedupe('heads:rpc', async () => {
      const results = await Promise.allSettled(
        headClients.map(
          (c) => c.request({ method: 'eth_blockNumber' }) as Promise<string>,
        ),
      );
      let max = 0;
      for (const r of results) {
        if (r.status === 'fulfilled') max = Math.max(max, Number(BigInt(r.value)));
      }
      return max;
    });
    rpc = { v, exp: Date.now() + 2000, at: Date.now() };
    return v;
  }

  async function rpcHead(): Promise<number> {
    if (rpc && rpc.exp > Date.now()) return rpc.v;
    return fetchRpcHead();
  }

  /**
   * Bypasses the 2s cache for near-head existence checks (a just-mined block
   * must not 404 on a stale head). Still bounded: at most ~2 upstream head
   * fetches per second even when hammered with above-head requests.
   */
  async function refreshRpcHead(): Promise<number> {
    if (rpc && Date.now() - rpc.at < 500) return rpc.v;
    return fetchRpcHead();
  }

  async function indexedHead(): Promise<number> {
    if (idx && idx.exp > Date.now()) return idx.v;
    const v = await dedupe('heads:indexed', async () => {
      const rows = await ctx.db
        .select({ number: blocks.number })
        .from(blocks)
        .orderBy(desc(blocks.number))
        .limit(1);
      return rows[0]?.number ?? 0;
    });
    idx = { v, exp: Date.now() + 1000 };
    return v;
  }

  /** Lets the cold path advance the cached DB head right after an insert. */
  function bumpIndexed(n: number): void {
    if (idx && n > idx.v) idx.v = n;
  }

  return { rpcHead, refreshRpcHead, indexedHead, bumpIndexed };
}

export type Heads = ReturnType<typeof makeHeads>;

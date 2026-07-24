import { eq, sql } from 'drizzle-orm';
import { numberToHex } from 'viem';
import {
  addressTokenSeen,
  blocks,
  logs,
  tokenTransfers,
  tokens,
  transactions,
  type BlockRow,
  type TxRow,
} from '@4663scan/shared/db/schema';
import {
  blockToRows,
  type IngestRows,
  type RawBlock,
  type RawReceipt,
  type RawTx,
} from '@4663scan/shared/ingest';
import {
  addressTokenPairs,
  filterStockTransfers,
  isSlimBlock,
  isSlimTx,
  loadStockAddressSet,
  slimBlockRow,
  slimTxRow,
  tierForTimestamp,
} from '@4663scan/shared/tiering';
import { LogsPartitionManager } from '@4663scan/shared/db/partitions';
import type { AppContext } from '../context.js';
import { ApiHttpError } from '../lib/errors.js';
import { TtlMap, dedupe } from '../lib/ttl.js';
import type { Heads } from './heads.js';

type PendingRawTx = Omit<RawTx, 'blockNumber' | 'blockHash'> & {
  blockNumber: string | null;
  blockHash: string | null;
};

/** Global cap on concurrent upstream RPC fetches from the cold path. */
const MAX_CONCURRENT_FETCHES = 4;
/** Beyond this many queued cold fetches, shed load instead of piling up. */
const MAX_QUEUED_FETCHES = 100;

/** Negative-cache TTLs. Tx/near-head misses may become hits within seconds. */
const MISS_TTL_TX_MS = 3_000;
const MISS_TTL_BLOCK_MS = 2_000;
const MISS_TTL_HASH_MS = 30_000;

/** Stock-token set refresh cadence for slim-tier transfer filtering. */
const STOCK_SET_TTL_MS = 60_000;

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/** Bounded-concurrency gate with a finite wait queue (overflow → 503). */
function makeGate(limit: number, maxQueue: number) {
  let active = 0;
  const waiters: Array<() => void> = [];
  return async function gate<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      if (waiters.length >= maxQueue) {
        throw new ApiHttpError(503, 'upstream fetch backlog');
      }
      await new Promise<void>((resolve) => waiters.push(resolve));
      // The releaser handed us its slot; `active` already counts it.
    } else {
      active += 1;
    }
    try {
      return await fn();
    } finally {
      const next = waiters.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

/** A cold lookup result: a DB (or just-persisted) row, or an ephemeral one. */
export interface ColdBlock {
  row: BlockRow;
  /**
   * Set when the block's full detail was served straight from the RPC
   * without being persisted. Carries the full ingest row set so routes can
   * serve txs/logs/transfers consistently.
   */
  ephemeral: IngestRows | null;
  /**
   * True when the ephemeral bundle re-materializes finalized (deep) chain
   * content — a slim-tier hydrate — rather than a near-head serve that may
   * still reorg. Deterministic content, so immutable caching stays allowed.
   */
  hydrated?: boolean;
}

export interface ColdTx {
  row: TxRow;
  /** Ingest rows of the tx's block when it was served without persisting. */
  ephemeral: IngestRows | null;
  /** See ColdBlock.hydrated. */
  hydrated?: boolean;
}

export interface EnsureBlockOpts {
  /** false = return slim DB rows as-is instead of RPC-hydrating them. */
  hydrateSlim?: boolean;
}

/**
 * Lazy fetch of pre-index history. Only blocks at depth ≥ CONFIRM_DEPTH are
 * persisted (final, hence a permanent cache; writes mirror the indexer's
 * claim-then-children pattern). Shallower misses are served straight from the
 * RPC without persisting: the indexer owns the near-head range, so the cold
 * path can never suppress its NOTIFY or store a soon-orphaned block.
 *
 * Tier-aware in both directions (docs/architecture.md): slim DB rows hydrate
 * ephemerally from the RPC for detail views, and persists apply the same
 * slim + stock-only projection as backfill for pre-hot blocks, so the cold
 * path can never re-inflate a demoted range.
 */
export function makeCold(ctx: AppContext, heads: Heads) {
  // viem's typed request union doesn't cover raw pass-through cleanly.
  const request = ctx.client.request as unknown as (args: {
    method: string;
    params?: unknown[];
  }) => Promise<unknown>;

  const gate = makeGate(MAX_CONCURRENT_FETCHES, MAX_QUEUED_FETCHES);
  const misses = new TtlMap<string, true>(MISS_TTL_HASH_MS, 20_000);
  // Short-lived cache for ephemeral (non-persisted) blocks by number.
  const ephemeralCache = new TtlMap<number, IngestRows>(2_000, 256);
  // Single manager per process: coverage state is in-memory (partitions.ts).
  const partitions = new LogsPartitionManager(ctx.db);
  const stockSetCache = new TtlMap<string, ReadonlySet<string>>(STOCK_SET_TTL_MS, 1);

  /** Stock-token addresses (registry ∪ flagged), for slim transfer filtering. */
  async function stockAddressSet(): Promise<ReadonlySet<string>> {
    const hit = stockSetCache.get('stock');
    if (hit) return hit;
    return dedupe('cold:stock-set', async () => {
      const set = await loadStockAddressSet(ctx.db);
      stockSetCache.set('stock', set);
      return set;
    });
  }

  async function storeRows(rows: IngestRows): Promise<void> {
    // Tier is decided per block by timestamp, mirroring backfill: a pre-hot
    // block persists slim, without logs, transfers filtered to stock tokens.
    // Token upserts stay full so historical token discovery still works.
    const tier = tierForTimestamp(rows.block.timestamp, ctx.env.HOT_WINDOW_SECONDS);
    const stockSet = tier === 'slim' ? await stockAddressSet() : null;
    if (stockSet != null && stockSet.size === 0) {
      // Empty set almost certainly means the stock_tokens seed never ran;
      // persisting slim through it would silently drop stock transfers.
      // Serve ephemerally and let a correctly-seeded process persist later.
      return;
    }
    const block = tier === 'slim' ? slimBlockRow(rows.block) : rows.block;
    const txs = tier === 'slim' ? rows.txs.map(slimTxRow) : rows.txs;
    const logRows = tier === 'slim' ? [] : rows.logs;
    const transfers =
      tier === 'slim' ? filterStockTransfers(rows.transfers, stockSet!) : rows.transfers;
    // logs is range-partitioned: an insert into an uncovered range errors.
    if (tier === 'full') {
      await partitions.ensureCovers(rows.block.number, rows.block.number);
    }
    const stored = await ctx.db.transaction(async (tx) => {
      // Claim the block first; children only when claimed (mirrors the
      // indexer's writer) so a conflicting height never gains phantom rows.
      const claimed = await tx
        .insert(blocks)
        .values(block)
        .onConflictDoNothing()
        .returning({ number: blocks.number });
      if (claimed.length === 0) return false;
      for (const chunk of chunks(txs, 500)) {
        await tx.insert(transactions).values(chunk).onConflictDoNothing();
      }
      for (const chunk of chunks(logRows, 1000)) {
        await tx.insert(logs).values(chunk).onConflictDoNothing();
      }
      for (const chunk of chunks(transfers, 1000)) {
        await tx.insert(tokenTransfers).values(chunk).onConflictDoNothing();
      }
      // Unfiltered on purpose — mirrors the indexer's writer: slim persists
      // drop non-stock transfer rows but must keep the (holder, token) pair.
      for (const chunk of chunks(addressTokenPairs(rows.transfers), 1000)) {
        await tx.insert(addressTokenSeen).values(chunk).onConflictDoNothing();
      }
      if (rows.tokenAddresses.length > 0) {
        // Cross-writer convention: acquire token row locks in ascending
        // address order so concurrent upserts cannot deadlock.
        const sorted = [...rows.tokenAddresses].sort();
        await tx
          .insert(tokens)
          .values(
            sorted.map((address) => ({
              address,
              firstSeenBlock: rows.block.number,
              lastSeenBlock: rows.block.number,
            })),
          )
          .onConflictDoUpdate({
            target: tokens.address,
            set: {
              firstSeenBlock: sql`least(coalesce(${tokens.firstSeenBlock}, excluded.first_seen_block), excluded.first_seen_block)`,
              lastSeenBlock: sql`greatest(coalesce(${tokens.lastSeenBlock}, excluded.last_seen_block), excluded.last_seen_block)`,
            },
          });
      }
      return true;
    });
    if (stored) heads.bumpIndexed(rows.block.number);
  }

  async function fetchBundle(raw: RawBlock): Promise<IngestRows> {
    const receipts = (await request({
      method: 'eth_getBlockReceipts',
      params: [raw.number],
    })) as RawReceipt[] | null;
    if (!receipts) throw new ApiHttpError(502, 'upstream receipts unavailable');
    return blockToRows(raw, receipts);
  }

  /** Canonical block hash at a height (lowercased), or null when unknown. */
  async function canonicalHashAt(numberHex: string): Promise<string | null> {
    const raw = (await request({
      method: 'eth_getBlockByNumber',
      params: [numberHex, false],
    })) as { hash?: string } | null;
    return raw?.hash?.toLowerCase() ?? null;
  }

  async function selectBlockByNumber(n: number): Promise<BlockRow | null> {
    const rows = await ctx.db.select().from(blocks).where(eq(blocks.number, n)).limit(1);
    return rows[0] ?? null;
  }

  /**
   * Gated eth_getBlockByNumber + receipts fetch that never persists, sharing
   * the ephemeral cache, single-flight dedupe and miss caches with the miss
   * path. null = the RPC does not know the block.
   */
  async function fetchBlockBundleEphemeral(n: number): Promise<IngestRows | null> {
    const eph = ephemeralCache.get(n);
    if (eph) return eph;
    if (misses.get(`b:${n}`)) return null;
    return dedupe(`cold:bundle:${n}`, async () => {
      const rows = await gate(async () => {
        const raw = (await request({
          method: 'eth_getBlockByNumber',
          params: [numberToHex(n), true],
        })) as RawBlock | null;
        return raw ? fetchBundle(raw) : null;
      });
      if (!rows) {
        misses.set(`b:${n}`, true, MISS_TTL_BLOCK_MS);
        return null;
      }
      ephemeralCache.set(n, rows);
      return rows;
    });
  }

  /**
   * A slim DB row proves the data exists on chain, so a failed hydrate is
   * upstream trouble (503/502) — never a 404 and never a partial response.
   */
  async function hydrateBundle(n: number): Promise<IngestRows> {
    let bundle: IngestRows | null;
    try {
      bundle = await fetchBlockBundleEphemeral(n);
    } catch (err) {
      if (err instanceof ApiHttpError) throw err;
      throw new ApiHttpError(503, 'upstream unreachable');
    }
    if (!bundle) throw new ApiHttpError(502, 'upstream block unavailable');
    return bundle;
  }

  async function hydrateSlimBlock(n: number): Promise<ColdBlock> {
    const bundle = await hydrateBundle(n);
    return { row: bundle.block as BlockRow, ephemeral: bundle, hydrated: true };
  }

  async function hydrateSlimTx(row: TxRow): Promise<ColdTx> {
    const bundle = await hydrateBundle(row.blockNumber);
    const full = (bundle.txs as TxRow[]).find((t) => t.hash === row.hash);
    if (!full) throw new ApiHttpError(502, 'upstream tx unavailable');
    return { row: full, ephemeral: bundle, hydrated: true };
  }

  async function serveRows(rows: IngestRows, head: number): Promise<ColdBlock> {
    const n = rows.block.number;
    const deep = Math.max(head, n) - n + 1 >= ctx.env.CONFIRM_DEPTH;
    if (deep) {
      await storeRows(rows);
      const stored = await selectBlockByNumber(n);
      // Hash check: if a different row already occupied this height, serve
      // the freshly fetched canonical data ephemerally instead of that row.
      // A slim persist (pre-hot block) also serves ephemerally: the caller
      // gets full detail while the DB keeps only the slim projection.
      if (stored && stored.hash === rows.block.hash && !isSlimBlock(stored)) {
        return { row: stored, ephemeral: null };
      }
    }
    ephemeralCache.set(n, rows);
    // Deep content is deterministic from chain even when served ephemerally.
    return { row: rows.block as BlockRow, ephemeral: rows, hydrated: deep };
  }

  async function ensureBlockByNumber(
    n: number,
    attested = false,
    opts: EnsureBlockOpts = {},
  ): Promise<ColdBlock | null> {
    const hit = await selectBlockByNumber(n);
    if (hit) {
      if (isSlimBlock(hit) && (opts.hydrateSlim ?? true)) return hydrateSlimBlock(n);
      return { row: hit, ephemeral: null };
    }
    const eph = ephemeralCache.get(n);
    if (eph) {
      // Same deep-ness rule as serveRows, so a cache hit within the 2s TTL
      // keeps the immutable-eligible marking instead of downgrading it.
      const deep =
        Math.max(await heads.rpcHead(), n) - n + 1 >= ctx.env.CONFIRM_DEPTH;
      return { row: eph.block as BlockRow, ephemeral: eph, hydrated: deep };
    }
    let head = await heads.rpcHead();
    if (n > head && !attested) {
      // The cached head can lag ~2s (~20 blocks here); refresh once before
      // 404ing what may be a just-mined block.
      head = await heads.refreshRpcHead();
      if (n > head) return null;
    }
    if (misses.get(`b:${n}`)) return null;
    return dedupe(`cold:block:${n}`, async () => {
      const rows = await fetchBlockBundleEphemeral(n);
      if (!rows) return null;
      return serveRows(rows, Math.max(head, n));
    });
  }

  async function ensureBlockByHash(
    hash: string,
    opts: EnsureBlockOpts = {},
  ): Promise<ColdBlock | null> {
    const select = async () => {
      const rows = await ctx.db
        .select()
        .from(blocks)
        .where(eq(blocks.hash, hash))
        .limit(1);
      return rows[0] ?? null;
    };
    const hit = await select();
    if (hit) {
      // The stored hash↔height mapping was canonical at persist time, so a
      // slim hit hydrates by number like the by-number path.
      if (isSlimBlock(hit) && (opts.hydrateSlim ?? true)) {
        return hydrateSlimBlock(hit.number);
      }
      return { row: hit, ephemeral: null };
    }
    if (misses.get(`h:${hash}`)) return null;
    return dedupe(`cold:blockhash:${hash}`, async () => {
      const rows = await gate(async () => {
        const raw = (await request({
          method: 'eth_getBlockByHash',
          params: [hash, true],
        })) as RawBlock | null;
        if (!raw) return null;
        // eth_getBlockByHash happily returns orphaned fork blocks; only a
        // hash that is canonical at its height may be served or persisted.
        if ((await canonicalHashAt(raw.number)) !== hash) return null;
        return fetchBundle(raw);
      });
      if (!rows) {
        misses.set(`h:${hash}`, true, MISS_TTL_HASH_MS);
        return null;
      }
      return serveRows(rows, await heads.rpcHead());
    });
  }

  /** id: block number, or lowercased 0x block hash. */
  async function ensureBlock(
    id: number | string,
    opts: EnsureBlockOpts = {},
  ): Promise<ColdBlock | null> {
    return typeof id === 'number'
      ? ensureBlockByNumber(id, false, opts)
      : ensureBlockByHash(id, opts);
  }

  async function ensureTx(hash: string): Promise<ColdTx | null> {
    const select = async () => {
      const rows = await ctx.db
        .select()
        .from(transactions)
        .where(eq(transactions.hash, hash))
        .limit(1);
      return rows[0] ?? null;
    };
    const hit = await select();
    // A slim hit (input IS NULL) needs its block re-fetched for full detail;
    // routes rely on the hydrated row carrying calldata/gas/logs.
    if (hit) return isSlimTx(hit) ? hydrateSlimTx(hit) : { row: hit, ephemeral: null };
    if (misses.get(`t:${hash}`)) return null;
    return dedupe(`cold:tx:${hash}`, async () => {
      const raw = (await gate(() =>
        request({ method: 'eth_getTransactionByHash', params: [hash] }),
      )) as PendingRawTx | null;
      if (!raw) {
        misses.set(`t:${hash}`, true, MISS_TTL_TX_MS);
        return null;
      }
      // Pending txs surface as 404, not negative-cached: they may land soon.
      if (raw.blockNumber == null) return null;
      // The RPC just attested the block exists — bypass the head guard.
      const block = await ensureBlockByNumber(Number(BigInt(raw.blockNumber)), true);
      if (!block) return null;
      if (block.ephemeral) {
        const row = (block.ephemeral.txs as TxRow[]).find((t) => t.hash === hash);
        return row
          ? { row, ephemeral: block.ephemeral, hydrated: block.hydrated }
          : null;
      }
      const stored = await select();
      if (!stored) return null;
      // A demotion racing the persist can slim the row before this re-read.
      return isSlimTx(stored) ? hydrateSlimTx(stored) : { row: stored, ephemeral: null };
    });
  }

  /** Search probe: does the RPC know this tx (mined or pending)? */
  async function probeTx(hash: string): Promise<boolean> {
    if (misses.get(`t:${hash}`)) return false;
    try {
      const raw = await gate(() =>
        request({ method: 'eth_getTransactionByHash', params: [hash] }),
      );
      if (!raw) {
        misses.set(`t:${hash}`, true, MISS_TTL_TX_MS);
        return false;
      }
      return true;
    } catch {
      // Upstream trouble degrades search to "no result", never a 5xx.
      return false;
    }
  }

  /** Search probe: canonical hash at a height, without ingesting the block. */
  async function probeBlockHashByNumber(n: number): Promise<string | null> {
    const eph = ephemeralCache.get(n);
    if (eph) return eph.block.hash;
    if (misses.get(`b:${n}`)) return null;
    try {
      const hash = await dedupe(`cold:bh:${n}`, () =>
        gate(() => canonicalHashAt(numberToHex(n))),
      );
      if (!hash) misses.set(`b:${n}`, true, MISS_TTL_BLOCK_MS);
      return hash;
    } catch {
      return null;
    }
  }

  /** Search probe: canonical block for this hash, without ingesting it. */
  async function probeBlockByHash(
    hash: string,
  ): Promise<{ number: number; hash: string } | null> {
    if (misses.get(`h:${hash}`)) return null;
    try {
      const found = await gate(async () => {
        const raw = (await request({
          method: 'eth_getBlockByHash',
          params: [hash, false],
        })) as { number: string } | null;
        if (!raw) return null;
        if ((await canonicalHashAt(raw.number)) !== hash) return null;
        return { number: Number(BigInt(raw.number)), hash };
      });
      if (!found) misses.set(`h:${hash}`, true, MISS_TTL_HASH_MS);
      return found;
    } catch {
      return null;
    }
  }

  return { ensureBlock, ensureTx, probeTx, probeBlockByHash, probeBlockHashByNumber };
}

export type Cold = ReturnType<typeof makeCold>;

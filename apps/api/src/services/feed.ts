import { eq } from 'drizzle-orm';
import { transactions, type TxRow } from '@4663scan/shared/db/schema';
import type { LiveFeed } from '@4663scan/shared/api-types';
import type { AppContext } from '../context.js';
import { memo } from '../lib/ttl.js';
import { toBlockSummary, type Views } from '../views.js';
import type { Cold, ColdBlock } from './cold.js';
import type { Heads } from './heads.js';

/** Blocks shown in the home feed — also the pool the tx list draws from. */
const FEED_BLOCK_COUNT = 12;
/** Matches the route's HTTP cache; a client poll essentially never misses. */
const FEED_TTL_MS = 2_000;
/**
 * Headroom above the UI's tx cap so a poll never shorts the list just
 * because one block in the window happened to be tx-heavy, without being so
 * wide that label/method resolution runs on rows the client discards anyway.
 */
const FEED_TX_LIMIT = 30;

/**
 * Home feed: the newest FEED_BLOCK_COUNT blocks read straight from RPC via
 * the existing cold-fetch path (ensureBlock), never persisted — this chain's
 * indexed range is always far behind the tip on free RPC, so the DB is not a
 * usable source for "latest". Reusing cold.ensureBlock gets the same gate
 * (bounded concurrent upstream fetches), ephemeral cache and dedupe the
 * detail-page cold path already relies on, instead of a second RPC-fetching
 * subsystem; the whole compute is additionally memoized so concurrent home
 * page visitors within the same ~2s window share one fetch cycle.
 */
export function makeFeed(ctx: AppContext, heads: Heads, cold: Cold, views: Views) {
  async function txRowsFor(found: ColdBlock): Promise<TxRow[]> {
    if (found.ephemeral) return found.ephemeral.txs as TxRow[];
    // Only reachable once indexing has genuinely caught up to this window.
    return ctx.db
      .select()
      .from(transactions)
      .where(eq(transactions.blockNumber, found.row.number));
  }

  async function compute(): Promise<LiveFeed> {
    const head = await heads.rpcHead();
    const numbers: number[] = [];
    for (let n = head; n > head - FEED_BLOCK_COUNT && n >= 0; n--) numbers.push(n);
    const found = (await Promise.all(numbers.map((n) => cold.ensureBlock(n)))).filter(
      (f): f is ColdBlock => f != null,
    );
    const blocks = found.map((f) => toBlockSummary(f.row));
    const txRowLists = await Promise.all(found.map(txRowsFor));
    const txRows = txRowLists
      .flat()
      // Newest block first, highest txIndex first within a block.
      .sort((a, b) => b.blockNumber - a.blockNumber || b.txIndex - a.txIndex)
      .slice(0, FEED_TX_LIMIT);
    const txs = await views.toTxSummaries(txRows);

    const newest = blocks[0];
    const oldest = blocks[blocks.length - 1];
    const blockTimeSeconds =
      newest && oldest && newest.number > oldest.number
        ? Math.round(
            ((newest.timestamp - oldest.timestamp) / (newest.number - oldest.number)) *
              100,
          ) / 100
        : null;

    return {
      headBlock: head,
      blockTimeSeconds,
      baseFeePerGas: newest?.baseFeePerGas ?? null,
      blocks,
      txs,
    };
  }

  function getFeed(): Promise<LiveFeed> {
    return memo('feed', FEED_TTL_MS, compute);
  }

  return { getFeed };
}

export type Feed = ReturnType<typeof makeFeed>;

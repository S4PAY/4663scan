import { eq, inArray, sql } from 'drizzle-orm';
import {
  NEW_BLOCKS_CHANNEL,
  addressTokenSeen,
  blocks,
  logs,
  tokenTransfers,
  tokens,
  transactions,
  type Db,
} from '@4663scan/shared/db';
import type { LogsPartitionManager } from '@4663scan/shared/db/partitions';
import { env } from '@4663scan/shared/env';
import { blockToRows } from '@4663scan/shared/ingest';
import {
  addressTokenPairs,
  filterStockTransfers,
  slimBlockRow,
  slimTxRow,
  tierForTimestamp,
  type WriteTierMode,
} from '@4663scan/shared/tiering';
import type { BlockBundle } from './rpc.js';
import { writeState, type StateWrite } from './state.js';
import { chunk } from './util.js';

const INSERT_CHUNK = 500;
/** NOTIFY payloads are capped at 8000 bytes server-side; stay well under. */
const NOTIFY_NUMBERS_PER_PAYLOAD = 500;

export interface IngestOpts {
  notify: boolean;
  /**
   * 'full' (head follower — its catch-up range is always recent) or 'auto'
   * (per block by timestamp: past the hot window the slim projection is
   * written — slim block/tx rows, no logs, stock-only transfers).
   */
  tierMode: WriteTierMode;
  /** Never-pruned token addresses; required with tierMode 'auto'. */
  stockSet?: ReadonlySet<string>;
  /** logs partitions must exist before full-tier inserts land in them. */
  partitions: LogsPartitionManager;
  /** Checkpoint(s) written in the same transaction as the batch's last block. */
  state?: StateWrite | StateWrite[];
}

export interface IngestResult {
  inserted: number[];
  /** Subset of `inserted` whose stale (different-hash) row was replaced. */
  repaired: number[];
  skipped: number[];
  txCount: number;
  transferCount: number;
}

/**
 * One drizzle transaction per block: insert block, then txs / logs /
 * transfers in ≤500-row chunks, then token upserts. Each block is written at
 * its tier: full detail, or (tierMode 'auto', past the hot window) the slim
 * projection — slim block/tx rows, no logs, transfers filtered to the stock
 * set. Token upserts always cover every seen address so historical token
 * discovery keeps working. A number conflict is only a skip when the stored
 * hash matches the fetched one; a different hash is a stale fork row (crash
 * above the checkpoint, or an insert that raced a reorg rollback) and is
 * repaired in place — children deleted explicitly (no FKs from children to
 * blocks), then the fresh bundle inserted at its tier. The state checkpoint
 * rides in the last block's transaction so a kill -9 mid-batch loses nothing:
 * un-checkpointed blocks are refetched and skipped or repaired on restart.
 */
export async function ingestBlocks(
  db: Db,
  bundles: BlockBundle[],
  opts: IngestOpts,
): Promise<IngestResult> {
  if (opts.tierMode === 'auto' && (opts.stockSet == null || opts.stockSet.size === 0)) {
    // An empty set almost certainly means the stock_tokens seed never ran;
    // writing slim blocks through it would silently drop every stock
    // transfer past the window — unrecoverable without a re-backfill.
    throw new Error(
      "ingestBlocks: tierMode 'auto' requires a non-empty stockSet (run pnpm db:seed)",
    );
  }

  const result: IngestResult = {
    inserted: [],
    repaired: [],
    skipped: [],
    txCount: 0,
    transferCount: 0,
  };

  const prepared = bundles.map((bundle) => {
    const rows = blockToRows(bundle.block, bundle.receipts);
    const tier =
      opts.tierMode === 'full'
        ? 'full'
        : tierForTimestamp(rows.block.timestamp, env.HOT_WINDOW_SECONDS);
    return { rows, tier };
  });

  // An INSERT into an uncovered logs partition range errors; make sure the
  // batch's full-tier blocks are covered before any transaction opens — both
  // ends, since backfill descends. Slim blocks write no logs and need no
  // partition.
  let minFullBlock = Number.MAX_SAFE_INTEGER;
  let maxFullBlock = -1;
  for (const p of prepared) {
    if (p.tier !== 'full') continue;
    if (p.rows.block.number > maxFullBlock) maxFullBlock = p.rows.block.number;
    if (p.rows.block.number < minFullBlock) minFullBlock = p.rows.block.number;
  }
  if (maxFullBlock >= 0) await opts.partitions.ensureCovers(minFullBlock, maxFullBlock);

  for (let i = 0; i < prepared.length; i++) {
    const { rows, tier } = prepared[i]!;
    const isLast = i === prepared.length - 1;
    const blockRow = tier === 'slim' ? slimBlockRow(rows.block) : rows.block;
    const txRows = tier === 'slim' ? rows.txs.map(slimTxRow) : rows.txs;
    const logRows = tier === 'slim' ? [] : rows.logs;
    const transferRows =
      tier === 'slim'
        ? filterStockTransfers(rows.transfers, opts.stockSet!)
        : rows.transfers;

    await db.transaction(async (tx) => {
      const claimed = await tx
        .insert(blocks)
        .values(blockRow)
        .onConflictDoNothing()
        .returning({ number: blocks.number });

      let owned = claimed.length > 0;
      if (!owned) {
        // The number is taken: compare hashes before skipping. A mismatch
        // means the stored row belongs to an abandoned fork — delete it and
        // its children explicitly (there are no FKs from children to blocks)
        // and insert the fresh bundle at its tier.
        const existing = await tx
          .select({ hash: blocks.hash })
          .from(blocks)
          .where(eq(blocks.number, rows.block.number));
        if (existing[0]?.hash !== rows.block.hash) {
          await tx.delete(logs).where(eq(logs.blockNumber, rows.block.number));
          await tx
            .delete(tokenTransfers)
            .where(eq(tokenTransfers.blockNumber, rows.block.number));
          await tx
            .delete(transactions)
            .where(eq(transactions.blockNumber, rows.block.number));
          await tx.delete(blocks).where(eq(blocks.number, rows.block.number));
          // A reorg during downtime can have moved a tx from a stale fork
          // row at another height to this block; hash is a global PK, so
          // evict colliding rows wherever they sit or the insert below
          // aborts on every retry.
          for (const c of chunk(rows.txs.map((t) => t.hash), INSERT_CHUNK)) {
            await tx.delete(transactions).where(inArray(transactions.hash, c));
          }
          await tx.insert(blocks).values(blockRow);
          result.repaired.push(rows.block.number);
          owned = true;
        }
      }

      if (owned) {
        for (const c of chunk(txRows, INSERT_CHUNK)) {
          await tx.insert(transactions).values(c);
        }
        for (const c of chunk(logRows, INSERT_CHUNK)) {
          await tx.insert(logs).values(c);
        }
        for (const c of chunk(transferRows, INSERT_CHUNK)) {
          await tx.insert(tokenTransfers).values(c);
        }
        // Pairs come from the unfiltered transfers: a slim block stores no
        // non-stock transfer rows, but the (holder, token) sighting must
        // survive or holdings discovery loses the token forever.
        for (const c of chunk(addressTokenPairs(rows.transfers), INSERT_CHUNK)) {
          await tx.insert(addressTokenSeen).values(c).onConflictDoNothing();
        }
        if (rows.tokenAddresses.length > 0) {
          await tx
            .insert(tokens)
            .values(
              // Sorted ascending so concurrent bulk upserts lock tokens
              // rows in a consistent order and cannot deadlock.
              [...rows.tokenAddresses].sort().map((address) => ({
                address,
                firstSeenBlock: rows.block.number,
                lastSeenBlock: rows.block.number,
              })),
            )
            .onConflictDoUpdate({
              target: tokens.address,
              set: {
                // Seeded registry rows may have null first/last seen.
                firstSeenBlock: sql`least(coalesce(${tokens.firstSeenBlock}, excluded.first_seen_block), excluded.first_seen_block)`,
                lastSeenBlock: sql`greatest(coalesce(${tokens.lastSeenBlock}, excluded.last_seen_block), excluded.last_seen_block)`,
              },
            });
        }
        result.inserted.push(rows.block.number);
        result.txCount += txRows.length;
        result.transferCount += transferRows.length;
      } else {
        result.skipped.push(rows.block.number);
      }

      if (isLast && opts.state) {
        const writes = Array.isArray(opts.state) ? opts.state : [opts.state];
        for (const s of writes) await writeState(tx, s);
      }
    });
  }

  if (opts.notify && result.inserted.length > 0) {
    for (const numbers of chunk(result.inserted, NOTIFY_NUMBERS_PER_PAYLOAD)) {
      const payload = JSON.stringify({ numbers });
      await db.execute(sql`select pg_notify(${NEW_BLOCKS_CHANNEL}, ${payload})`);
    }
  }

  return result;
}

import { and, desc, gte, isNotNull, lt, lte, notInArray, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { blocks, tokenTransfers, transactions, type Db } from '@4663scan/shared/db';
import { dropLogsPartitionsBefore } from '@4663scan/shared/db/partitions';
import { env } from '@4663scan/shared/env';
import { loadStockAddressSet } from '@4663scan/shared/tiering';
import { readHeadState, readRetentionState, writeState } from './state.js';
import { sleep } from './util.js';

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
/** Breather between batch transactions: keeps the event loop and vacuum fed. */
const BATCH_YIELD_MS = 50;

export interface RetentionStats {
  cutoffBlock: number;
  txsDemoted: number;
  blocksDemoted: number;
  transfersDeleted: number;
  partitionsDropped: number;
  /** True when shouldStop() interrupted the pass; the rest runs next pass. */
  aborted?: boolean;
}

/**
 * One retention pass (docs/architecture.md): demote hot rows past the window
 * to the slim projection, prune non-stock transfers, drop expired logs
 * partitions. Everything happens at or below head − CONFIRM_DEPTH — far
 * beyond REORG_LIMIT — so the pass never races head rewrites. Batches are
 * found via the partial hot indexes, which makes passes idempotent and
 * self-healing: anything that re-inflates old ranges is re-found next pass.
 * A pass over backlog can run for minutes, so `shouldStop` is checked
 * between batches — every phase checkpoints per batch, making early exit
 * free. Returns null when there is nothing past the window yet.
 */
export async function runRetentionPass(
  db: Db,
  log: Logger,
  shouldStop: () => boolean = () => false,
): Promise<RetentionStats | null> {
  const head = await readHeadState(db);
  if (head == null) {
    log.debug('no head checkpoint; skipping retention pass');
    return null;
  }

  const cutoffTs = Math.floor(Date.now() / 1000) - env.HOT_WINDOW_SECONDS;
  const newest = await db
    .select({ number: blocks.number })
    .from(blocks)
    .where(lt(blocks.timestamp, cutoffTs))
    .orderBy(desc(blocks.timestamp))
    .limit(1);
  if (newest[0] == null) {
    log.debug({ cutoffTs }, 'no blocks past the hot window; skipping retention pass');
    return null;
  }
  const cutoffBlock = Math.min(newest[0].number, head.lastBlock - env.CONFIRM_DEPTH);
  if (cutoffBlock <= 0) {
    log.debug({ cutoffTs }, 'cutoff within confirm depth; skipping retention pass');
    return null;
  }

  const stats: RetentionStats = {
    cutoffBlock,
    txsDemoted: 0,
    blocksDemoted: 0,
    transfersDeleted: 0,
    partitionsDropped: 0,
  };

  // Demote transactions in block-range batches. min() over the partial
  // txs_hot_idx finds the lowest not-yet-slim block instantly and skips all
  // already-demoted history; each UPDATE NULLs the same columns as slimTxRow.
  for (;;) {
    if (shouldStop()) return { ...stats, aborted: true };
    const found = await db
      .select({ lo: sql<string | null>`min(${transactions.blockNumber})` })
      .from(transactions)
      .where(
        and(isNotNull(transactions.input), lte(transactions.blockNumber, cutoffBlock)),
      );
    if (found[0]?.lo == null) break;
    const lo = Number(found[0].lo);
    const hi = Math.min(lo + env.RETENTION_BATCH_BLOCKS - 1, cutoffBlock);
    const res = await db
      .update(transactions)
      .set({
        blockHash: null,
        nonce: null,
        type: null,
        gas: null,
        gasPrice: null,
        maxFeePerGas: null,
        maxPriorityFeePerGas: null,
        input: null,
        gasUsed: null,
        effectiveGasPrice: null,
        gasUsedForL1: null,
      })
      .where(
        and(
          gte(transactions.blockNumber, lo),
          lte(transactions.blockNumber, hi),
          isNotNull(transactions.input),
        ),
      );
    stats.txsDemoted += res.count;
    await sleep(BATCH_YIELD_MS);
  }

  // Demote blocks the same way (blocks_hot_idx / slimBlockRow's null set).
  for (;;) {
    if (shouldStop()) return { ...stats, aborted: true };
    const found = await db
      .select({ lo: sql<string | null>`min(${blocks.number})` })
      .from(blocks)
      .where(and(isNotNull(blocks.parentHash), lte(blocks.number, cutoffBlock)));
    if (found[0]?.lo == null) break;
    const lo = Number(found[0].lo);
    const hi = Math.min(lo + env.RETENTION_BATCH_BLOCKS - 1, cutoffBlock);
    const res = await db
      .update(blocks)
      .set({
        parentHash: null,
        baseFeePerGas: null,
        miner: null,
        size: null,
        l1BlockNumber: null,
      })
      .where(
        and(gte(blocks.number, lo), lte(blocks.number, hi), isNotNull(blocks.parentHash)),
      );
    stats.blocksDemoted += res.count;
    await sleep(BATCH_YIELD_MS);
  }

  // Prune non-stock transfers up to the watermark. An empty stock set almost
  // certainly means the seeds never ran — deleting everything would be wrong.
  const stockSet = await loadStockAddressSet(db);
  if (stockSet.size === 0) {
    log.warn('stock address set is empty; skipping transfer pruning');
  } else {
    const stockAddresses = [...stockSet];
    const watermark =
      (await readRetentionState(db)) ?? { transfersPrunedThrough: -1 };
    // Re-scan a CONFIRM_DEPTH trailing band below the watermark: an API
    // cold persist can decide 'full' at the window boundary and commit its
    // (all-transfer) write after this pass advanced past that block. The
    // band is exactly the range such writes can land in, and re-scanning it
    // is one cheap indexed range per pass.
    let lo = Math.max(
      0,
      Math.min(watermark.transfersPrunedThrough + 1, cutoffBlock - env.CONFIRM_DEPTH),
    );
    while (lo <= cutoffBlock) {
      if (shouldStop()) return { ...stats, aborted: true };
      const hi = Math.min(lo + env.RETENTION_BATCH_BLOCKS - 1, cutoffBlock);
      // Watermark advances in the same transaction as its range's delete, so
      // steady state scans each block range once (plus the trailing band).
      await db.transaction(async (tx) => {
        const res = await tx
          .delete(tokenTransfers)
          .where(
            and(
              gte(tokenTransfers.blockNumber, lo),
              lte(tokenTransfers.blockNumber, hi),
              notInArray(tokenTransfers.tokenAddress, stockAddresses),
            ),
          );
        stats.transfersDeleted += res.count;
        await writeState(tx, {
          key: 'retention',
          value: {
            transfersPrunedThrough: Math.max(watermark.transfersPrunedThrough, hi),
          },
        });
      });
      lo = hi + 1;
      await sleep(BATCH_YIELD_MS);
    }
  }

  const dropped = await dropLogsPartitionsBefore(db, cutoffBlock);
  if (dropped.length > 0) log.info({ dropped }, 'dropped expired logs partitions');
  stats.partitionsDropped = dropped.length;

  return stats;
}

/**
 * Periodic retention worker. Single-flight by construction: the loop runs one
 * pass at a time, sleeps RETENTION_INTERVAL_SECONDS between passes, and backs
 * off exponentially on error.
 */
export class RetentionWorker {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private backoffMs = BACKOFF_START_MS;

  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.running = true;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loopPromise;
  }

  private async loop(): Promise<void> {
    try {
      while (this.running) {
        try {
          const stats = await runRetentionPass(this.db, this.logger, () => !this.running);
          if (stats != null) this.logger.info(stats, 'retention pass complete');
          this.backoffMs = BACKOFF_START_MS;
          await this.interruptibleSleep(env.RETENTION_INTERVAL_SECONDS * 1000);
        } catch (err) {
          if (!this.running) break;
          this.logger.warn(
            { err, backoffMs: this.backoffMs },
            'retention pass failed; backing off',
          );
          await this.interruptibleSleep(this.backoffMs);
          this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
        }
      }
    } catch (err) {
      // Never crash the process from the retention loop.
      this.logger.error({ err }, 'retention loop aborted');
    }
  }

  private async interruptibleSleep(ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (this.running && Date.now() < until) await sleep(100);
  }
}

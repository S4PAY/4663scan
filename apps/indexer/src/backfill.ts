import type { Logger } from 'pino';
import type { Db } from '@4663scan/shared/db';
import type { LogsPartitionManager } from '@4663scan/shared/db/partitions';
import { env } from '@4663scan/shared/env';
import type { RpcClient } from './rpc.js';
import { readBackfillState, type BackfillState } from './state.js';
import type { StockSetProvider } from './stock-set.js';
import { ingestBlocks } from './writer.js';
import { rangeDesc, sleep } from './util.js';

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

export interface BackfillSummary {
  cursor: number | null;
  floor: number;
  gaps: number;
  done: boolean;
}

/**
 * Background history filler. Newest gap range first (hi → lo), then the main
 * cursor descending toward floor. Cursor/gaps state is persisted in the same
 * transaction as each batch's last (lowest) block, so progress survives kill
 * -9 with at most one refetched batch.
 */
export class BackfillRunner {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private backoffMs = BACKOFF_START_MS;
  private state: BackfillState | null = null;

  constructor(
    private readonly db: Db,
    private readonly rpc: RpcClient,
    private readonly partitions: LogsPartitionManager,
    private readonly stockSet: StockSetProvider,
    private readonly logger: Logger,
  ) {}

  summary(): BackfillSummary | null {
    const s = this.state;
    if (s == null) return null;
    return {
      cursor: s.cursor,
      floor: s.floor,
      gaps: s.gaps.length,
      done: s.cursor == null && s.gaps.length === 0,
    };
  }

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
      this.state = await readBackfillState(this.db);
      if (this.state == null) {
        this.logger.warn('no backfill state found; backfill idle');
        return;
      }
      this.logger.info(
        { cursor: this.state.cursor, floor: this.state.floor, gaps: this.state.gaps.length },
        'backfill starting',
      );
      while (this.running) {
        try {
          const worked = await this.iteration();
          this.backoffMs = BACKOFF_START_MS;
          if (!worked) {
            this.logger.info('backfill complete: cursor at floor and no gaps remain');
            return;
          }
        } catch (err) {
          this.logger.warn(
            { err, backoffMs: this.backoffMs },
            'backfill iteration failed; backing off',
          );
          await this.interruptibleSleep(this.backoffMs);
          this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
        }
      }
    } catch (err) {
      // Never crash the process from the backfill loop.
      this.logger.error({ err }, 'backfill loop aborted');
    }
  }

  /** Runs one batch; returns false when there is no work left. */
  private async iteration(): Promise<boolean> {
    const state = this.state;
    if (state == null) return false;

    const gap = state.gaps[state.gaps.length - 1];
    if (gap != null) {
      // Newest gap first, filled from its top edge downward.
      const lo = Math.max(gap.lo, gap.hi - env.BACKFILL_CHUNK + 1);
      const rest = state.gaps.slice(0, -1);
      const next: BackfillState = {
        ...state,
        gaps: lo > gap.lo ? [...rest, { lo: gap.lo, hi: lo - 1 }] : rest,
      };
      await this.fetchAndIngest(rangeDesc(gap.hi, lo), next);
      this.state = next;
      if (next.gaps.length < state.gaps.length) {
        this.logger.info({ lo: gap.lo, hi: gap.hi }, 'gap range filled');
      }
      return true;
    }

    if (state.cursor != null && state.cursor >= state.floor) {
      const lo = Math.max(state.floor, state.cursor - env.BACKFILL_CHUNK + 1);
      const done = lo - 1 < state.floor;
      const next: BackfillState = { ...state, cursor: done ? null : lo - 1 };
      await this.fetchAndIngest(rangeDesc(state.cursor, lo), next);
      this.state = next;
      if (done) {
        this.logger.info(
          { floor: state.floor, startedFrom: state.startedFrom },
          'backfill cursor reached floor',
        );
      }
      return true;
    }

    return false;
  }

  private async fetchAndIngest(numbers: number[], next: BackfillState): Promise<void> {
    const bundles = await this.rpc.getBlocksWithReceipts(numbers, 'backfill');
    // Bundles stay descending: the checkpoint rides in the lowest block's
    // transaction, matching the cursor's walk direction. Tier is per block:
    // gap ranges handed off by the head follower are recent (hot), while
    // deep history lands slim.
    const res = await ingestBlocks(this.db, bundles, {
      notify: false,
      tierMode: 'auto',
      stockSet: this.stockSet.get(),
      partitions: this.partitions,
      state: { key: 'backfill', value: next },
    });
    this.logger.debug(
      {
        hi: numbers[0],
        lo: numbers[numbers.length - 1],
        inserted: res.inserted.length,
        skipped: res.skipped.length,
      },
      'backfill batch',
    );
  }

  private async interruptibleSleep(ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (this.running && Date.now() < until) await sleep(100);
  }
}

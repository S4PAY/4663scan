import { desc } from 'drizzle-orm';
import { blocks, indexerState } from '@4663scan/shared/db/schema';
import type { ChainStatus } from '@4663scan/shared/api-types';
import type { AppContext } from '../context.js';
import { memo } from '../lib/ttl.js';
import type { Heads } from './heads.js';

interface BackfillState {
  cursor?: number;
  floor?: number;
  startedFrom?: number;
  gaps?: { lo: number; hi: number }[];
}

interface RetentionState {
  transfersPrunedThrough?: number;
}

export function makeStatus(ctx: AppContext, heads: Heads) {
  async function tableCounts(): Promise<{ blocksIndexed: number; txsIndexed: number }> {
    // Exact COUNT(*) will not scale on these tables; planner estimates are
    // fine, falling back to exact only when never analyzed (reltuples = -1).
    const est = await ctx.sql<{ relname: string; est: number }[]>`
      select relname, reltuples::float8 as est from pg_class
      where relname in ('blocks', 'transactions')
        and relkind = 'r' and relnamespace = 'public'::regnamespace`;
    const by = new Map(est.map((r) => [r.relname, r.est]));
    const resolve = async (table: 'blocks' | 'transactions'): Promise<number> => {
      const e = by.get(table);
      if (e !== undefined && e >= 0) return Math.round(e);
      const exact =
        table === 'blocks'
          ? await ctx.sql<{ c: number }[]>`select count(*)::float8 as c from blocks`
          : await ctx.sql<{ c: number }[]>`select count(*)::float8 as c from transactions`;
      return exact[0]?.c ?? 0;
    };
    const [blocksIndexed, txsIndexed] = await Promise.all([
      resolve('blocks'),
      resolve('transactions'),
    ]);
    return { blocksIndexed, txsIndexed };
  }

  async function compute(): Promise<ChainStatus> {
    const [rpcHead, latestRows, stateRows, counts, recent] = await Promise.all([
      heads.rpcHead().catch(() => 0),
      ctx.db.select().from(blocks).orderBy(desc(blocks.number)).limit(1),
      ctx.db.select().from(indexerState),
      tableCounts(),
      ctx.db
        .select({ number: blocks.number, timestamp: blocks.timestamp })
        .from(blocks)
        .orderBy(desc(blocks.number))
        .limit(100),
    ]);

    const latest = latestRows[0] ?? null;
    const backfillRow = stateRows.find((r) => r.key === 'backfill');
    const backfillVal = (backfillRow?.value ?? null) as BackfillState | null;
    const retentionRow = stateRows.find((r) => r.key === 'retention');
    const retentionVal = (retentionRow?.value ?? null) as RetentionState | null;
    const cursor = typeof backfillVal?.cursor === 'number' ? backfillVal.cursor : null;
    const floor = typeof backfillVal?.floor === 'number' ? backfillVal.floor : 0;
    const pendingGaps = Array.isArray(backfillVal?.gaps) ? backfillVal.gaps.length : 0;

    // Window-span average: block timestamps have 1s resolution while blocks
    // arrive every ~100ms, so per-pair deltas quantize to 0. The span of a
    // ~100-block window divided by block distance recovers the real float
    // rate (and stays sane across non-contiguous head-first windows).
    const newest = recent[0];
    const oldest = recent[recent.length - 1];
    const blockTimeSeconds =
      newest && oldest && newest.number > oldest.number
        ? Math.round(
            ((newest.timestamp - oldest.timestamp) / (newest.number - oldest.number)) *
              100,
          ) / 100
        : null;

    return {
      chainId: ctx.env.CHAIN_ID,
      headBlock: Math.max(rpcHead, latest?.number ?? 0),
      indexedBlock: latest?.number ?? 0,
      indexedBlockTimestamp: latest?.timestamp ?? null,
      indexStartBlock:
        typeof backfillVal?.startedFrom === 'number' ? backfillVal.startedFrom : null,
      backfill: {
        enabled: ctx.env.BACKFILL_ENABLED,
        cursor,
        floor,
        done:
          backfillVal != null &&
          (cursor == null || cursor < floor) &&
          pendingGaps === 0,
      },
      blocksIndexed: counts.blocksIndexed,
      txsIndexed: counts.txsIndexed,
      blockTimeSeconds,
      baseFeePerGas: latest?.baseFeePerGas ?? null,
      tiering: {
        hotWindowSeconds: ctx.env.HOT_WINDOW_SECONDS,
        transfersPrunedThrough:
          typeof retentionVal?.transfersPrunedThrough === 'number'
            ? retentionVal.transfersPrunedThrough
            : null,
      },
    };
  }

  function getStatus(): Promise<ChainStatus> {
    return memo('status', 1000, compute);
  }

  return { getStatus };
}

export type Status = ReturnType<typeof makeStatus>;

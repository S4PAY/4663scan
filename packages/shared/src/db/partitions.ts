import { sql } from 'drizzle-orm';
import type { Db } from './index.js';

/**
 * Width of a logs partition in blocks (~15h of chain at current rates).
 * Fixed at first deploy: existing partition bounds live in the catalog and
 * are read back from there (never derived from names), but mixing widths
 * makes the layout harder to reason about — don't change casually.
 */
export const LOGS_PARTITION_BLOCKS = 500_000;

export interface LogsPartition {
  name: string;
  from: number;
  to: number;
  /** A crashed DETACH CONCURRENTLY leaves this set; needs FINALIZE, not DETACH. */
  pendingDetach: boolean;
}

export function logsPartitionStart(block: number): number {
  return Math.floor(block / LOGS_PARTITION_BLOCKS) * LOGS_PARTITION_BLOCKS;
}

/** Attached partitions of `logs`, bounds parsed from the catalog. */
export async function listLogsPartitions(db: Db): Promise<LogsPartition[]> {
  const rows = (await db.execute(sql`
    select c.relname as name,
           i.inhdetachpending as pending,
           pg_get_expr(c.relpartbound, c.oid) as bound
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    join pg_class p on p.oid = i.inhparent
    join pg_namespace n on n.oid = p.relnamespace
    where p.relname = 'logs' and n.nspname = current_schema()
  `)) as unknown as { name: string; pending: boolean; bound: string }[];
  const parts: LogsPartition[] = [];
  for (const r of rows) {
    const m = /FROM \('?(\d+)'?\) TO \('?(\d+)'?\)/.exec(r.bound ?? '');
    if (m) {
      parts.push({
        name: r.name,
        from: Number(m[1]),
        to: Number(m[2]),
        pendingDetach: Boolean(r.pending),
      });
    }
  }
  return parts.sort((a, b) => a.from - b.from);
}

/**
 * Ensures logs partitions exist covering [fromBlock, toBlock + lookahead].
 * Callers move in BOTH directions (head ascends, backfill descends, the API
 * cold path jumps arbitrarily), so known coverage is a verified interval —
 * a request outside it re-lists the catalog and creates every missing
 * partition across the union span (bounded by the hot window, since only
 * full-tier blocks write logs). Safe under concurrent callers (IF NOT EXISTS
 * + duplicate swallow). Instantiate once per process.
 */
export class LogsPartitionManager {
  /** Verified-covered interval [coveredFrom, coveredTo); null = nothing yet. */
  private coveredFrom: number | null = null;
  private coveredTo: number | null = null;

  constructor(private readonly db: Db) {}

  async ensureCovers(fromBlock: number, toBlock: number): Promise<void> {
    let needFrom = logsPartitionStart(Math.min(fromBlock, toBlock));
    // One partition of lookahead so head ingest never trips on a boundary
    // mid-batch.
    let needTo = logsPartitionStart(Math.max(fromBlock, toBlock)) + 2 * LOGS_PARTITION_BLOCKS;
    if (this.coveredFrom !== null && needFrom >= this.coveredFrom && needTo <= this.coveredTo!) {
      return;
    }
    // Widen to the union with what's already verified: the claim below must
    // describe one contiguous interval.
    if (this.coveredFrom !== null) {
      needFrom = Math.min(needFrom, this.coveredFrom);
      needTo = Math.max(needTo, this.coveredTo!);
    }
    const existing = await listLogsPartitions(this.db);
    const have = new Set(existing.filter((p) => !p.pendingDetach).map((p) => p.from));
    for (let s = needFrom; s < needTo; s += LOGS_PARTITION_BLOCKS) {
      if (!have.has(s)) await this.create(s);
    }
    this.coveredFrom = needFrom;
    this.coveredTo = needTo;
  }

  private async create(from: number): Promise<void> {
    const to = from + LOGS_PARTITION_BLOCKS;
    const name = `logs_p${from / LOGS_PARTITION_BLOCKS}`;
    try {
      await this.db.execute(
        sql.raw(
          `create table if not exists "${name}" partition of "logs" for values from (${from}) to (${to})`,
        ),
      );
    } catch (err) {
      // Two writers can pass IF NOT EXISTS and race the attach; the loser is fine.
      if ((err as { code?: string }).code !== '42P07') throw err;
    }
  }
}

/**
 * Drops every logs partition whose entire range is below `cutoffBlock`.
 * DETACH CONCURRENTLY runs outside a transaction and is internally
 * two-phase: a crash mid-statement leaves the partition pending-detach
 * (which blocks every later detach on the table) — those are completed with
 * DETACH ... FINALIZE. A crash between detach and drop leaves an orphan
 * table which the next call sweeps up. A concurrent pass (retention worker
 * vs retention:once) winning the race for a partition is benign and skipped.
 */
export async function dropLogsPartitionsBefore(
  db: Db,
  cutoffBlock: number,
): Promise<string[]> {
  const dropped: string[] = [];
  for (const p of await listLogsPartitions(db)) {
    if (p.to > cutoffBlock && !p.pendingDetach) continue;
    try {
      await db.execute(
        sql.raw(
          p.pendingDetach
            ? `alter table "logs" detach partition "${p.name}" finalize`
            : `alter table "logs" detach partition "${p.name}" concurrently`,
        ),
      );
      await db.execute(sql.raw(`drop table if exists "${p.name}"`));
      dropped.push(p.name);
    } catch (err) {
      const code = (err as { code?: string }).code;
      // 42P01 undefined table / 55000 already pending detach / 42P17 not a
      // partition: a concurrent pass got here first — its problem now.
      if (code === '42P01' || code === '55000' || code === '42P17') continue;
      throw err;
    }
  }
  // Orphans from a crash between detach and drop: logs_p* tables no longer
  // attached to logs. Only ever created by this module, so safe to remove.
  const orphans = (await db.execute(sql`
    select c.relname as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = current_schema()
      and c.relkind = 'r'
      and c.relname ~ '^logs_p[0-9]+$'
      and not exists (select 1 from pg_inherits i where i.inhrelid = c.oid)
  `)) as unknown as { name: string }[];
  for (const o of orphans) {
    await db.execute(sql.raw(`drop table if exists "${o.name}"`));
    dropped.push(o.name);
  }
  return dropped;
}

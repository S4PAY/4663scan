import { eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import type { PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';
import { indexerState, schema } from '@4663scan/shared/db';

/** Common supertype of the drizzle db handle and its transaction objects. */
export type DbConn = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;

export interface HeadState {
  lastBlock: number;
  lastHash: string;
}

export interface GapRange {
  lo: number;
  hi: number;
}

export interface BackfillState {
  /** Next block the main backfill will fetch (walks toward floor); null = done. */
  cursor: number | null;
  floor: number;
  startedFrom: number;
  /** Ranges the head follower jumped over; filled newest-first, hi → lo. */
  gaps: GapRange[];
}

export interface RetentionState {
  /** Highest block whose non-stock transfers have been pruned. */
  transfersPrunedThrough: number;
}

export type StateWrite =
  | { key: 'head'; value: HeadState }
  | { key: 'backfill'; value: BackfillState }
  | { key: 'retention'; value: RetentionState };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export async function readHeadState(db: DbConn): Promise<HeadState | null> {
  const rows = await db
    .select({ value: indexerState.value })
    .from(indexerState)
    .where(eq(indexerState.key, 'head'));
  const v = rows[0]?.value;
  if (!isRecord(v) || typeof v.lastBlock !== 'number' || typeof v.lastHash !== 'string') {
    return null;
  }
  return { lastBlock: v.lastBlock, lastHash: v.lastHash };
}

export async function readBackfillState(db: DbConn): Promise<BackfillState | null> {
  const rows = await db
    .select({ value: indexerState.value })
    .from(indexerState)
    .where(eq(indexerState.key, 'backfill'));
  const v = rows[0]?.value;
  if (!isRecord(v) || typeof v.floor !== 'number' || typeof v.startedFrom !== 'number') {
    return null;
  }
  const cursor = typeof v.cursor === 'number' ? v.cursor : null;
  const gaps: GapRange[] = Array.isArray(v.gaps)
    ? v.gaps.filter(
        (g): g is GapRange =>
          isRecord(g) && typeof g.lo === 'number' && typeof g.hi === 'number',
      )
    : [];
  return { cursor, floor: v.floor, startedFrom: v.startedFrom, gaps };
}

export async function readRetentionState(db: DbConn): Promise<RetentionState | null> {
  const rows = await db
    .select({ value: indexerState.value })
    .from(indexerState)
    .where(eq(indexerState.key, 'retention'));
  const v = rows[0]?.value;
  if (!isRecord(v) || typeof v.transfersPrunedThrough !== 'number') {
    return null;
  }
  return { transfersPrunedThrough: v.transfersPrunedThrough };
}

export async function writeState(db: DbConn, s: StateWrite): Promise<void> {
  await db
    .insert(indexerState)
    .values({ key: s.key, value: s.value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: indexerState.key,
      set: { value: s.value, updatedAt: new Date() },
    });
}

export async function initStateIfAbsent(db: DbConn, s: StateWrite): Promise<void> {
  await db
    .insert(indexerState)
    .values({ key: s.key, value: s.value, updatedAt: new Date() })
    .onConflictDoNothing();
}

import type { ChainStatus } from '@4663scan/shared/api-types';

/**
 * Percent of the head-first backfill walked toward genesis, or null when it
 * can't be computed yet (state not seeded, or backfill hasn't started).
 * indexStartBlock is the height backfill started descending from; floor is
 * usually 0 (genesis).
 */
export function backfillPercent(status: ChainStatus): number | null {
  if (status.backfill.done) return 100;
  const { indexStartBlock, backfill } = status;
  if (indexStartBlock == null || backfill.cursor == null) return null;
  const span = indexStartBlock - backfill.floor;
  if (span <= 0) return null;
  const progressed = indexStartBlock - backfill.cursor;
  return Math.min(100, Math.max(0, Math.round((progressed / span) * 100)));
}

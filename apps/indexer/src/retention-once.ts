import { pino } from 'pino';
import { makeDb } from '@4663scan/shared/db';
import { runRetentionPass } from './retention.js';

/**
 * Single retention pass for tests/ops (`pnpm --filter @4663scan/indexer
 * retention:once`). Deliberately does NOT take the indexer's advisory lock:
 * a pass only touches blocks at or below head − CONFIRM_DEPTH — far beyond
 * REORG_LIMIT, so it never overlaps ranges the running indexer rewrites —
 * and any full row an 'auto'-tier writer lands near the cutoff boundary is
 * simply re-found via the partial hot indexes on the next pass.
 */

const logger = pino(
  process.stdout.isTTY
    ? {
        level: process.env.LOG_LEVEL ?? 'info',
        transport: {
          target: 'pino-pretty',
          options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : { level: process.env.LOG_LEVEL ?? 'info' },
);

async function main(): Promise<void> {
  const { db, sql } = makeDb({ max: 2 });
  try {
    const stats = await runRetentionPass(db, logger);
    if (stats == null) logger.info('nothing past the hot window; no work done');
    else logger.info(stats, 'retention pass complete');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().then(
  () => {
    // Give the pretty-transport worker a beat to flush.
    setTimeout(() => process.exit(0), 100);
  },
  (err: unknown) => {
    logger.fatal({ err }, 'retention pass failed');
    setTimeout(() => process.exit(1), 100);
  },
);

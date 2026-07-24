import { pino } from 'pino';
import { makeDb } from '@4663scan/shared/db';
import { backfillChainlinkFeeds } from './chainlink-feeds.js';
import { backfillLogos } from './logos.js';

/**
 * One-shot backfill for the M6 charter (`pnpm --filter @4663scan/indexer
 * backfill-stock-metadata`): logos + asset class + Chainlink feed for every
 * existing stock token. Safe to re-run any time — both passes are
 * idempotent (skip tokens that already have what they need). No RPC calls,
 * no advisory lock needed: this never touches chain state or the indexer's
 * rate limiter, only the stock_tokens table and two plain HTTP fetches.
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
    const logos = await backfillLogos(db, logger);
    logger.info(logos, 'logo backfill complete');
    const feeds = await backfillChainlinkFeeds(db, logger);
    logger.info(feeds, 'chainlink feed backfill complete');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().then(
  () => {
    setTimeout(() => process.exit(0), 100);
  },
  (err: unknown) => {
    logger.fatal({ err }, 'stock metadata backfill failed');
    setTimeout(() => process.exit(1), 100);
  },
);

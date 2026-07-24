import { pino } from 'pino';
import postgres from 'postgres';
import { fallbackUrls, makeDirectHttpClient, makePublicClient } from '@4663scan/shared/chain';
import { makeDb } from '@4663scan/shared/db';
import { LogsPartitionManager } from '@4663scan/shared/db/partitions';
import { env } from '@4663scan/shared/env';
import { BackfillRunner } from './backfill.js';
import { HeadFollower } from './head.js';
import { RateLimiter } from './rate-limiter.js';
import { RetentionWorker } from './retention.js';
import { RpcClient } from './rpc.js';
import { StockSetProvider } from './stock-set.js';
import { TokenWorker } from './tokens.js';

const STATS_INTERVAL_MS = 10_000;
/**
 * Constant pg_advisory_lock key shared by every indexer instance: only the
 * holder may run. A second instance would race checkpoints and reorg
 * rollbacks (stale state overwrites, fork rows re-inserted after a rollback).
 */
const INSTANCE_LOCK_KEY = 4663_4663_4663;

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
  const { db, sql } = makeDb({ max: 5 });

  // Single-instance guard. Advisory locks are session-scoped, so the lock
  // lives on its own dedicated connection with recycling disabled —
  // postgres.js retires pooled connections after 30-60 min (max_lifetime),
  // which would silently release the lock and let a second instance in.
  const lockSql = postgres(env.DATABASE_URL, {
    max: 1,
    max_lifetime: null,
    onnotice: () => {},
  });
  const lockRows = await lockSql`
    select pg_try_advisory_lock(${INSTANCE_LOCK_KEY}::bigint) as locked
  `;
  if (lockRows[0]?.locked !== true) {
    logger.fatal(
      { lockKey: INSTANCE_LOCK_KEY },
      'another indexer instance holds the advisory lock; exiting',
    );
    await lockSql.end({ timeout: 5 });
    await sql.end({ timeout: 5 });
    // Give the pretty-transport worker a beat to flush.
    setTimeout(() => process.exit(1), 100);
    return;
  }

  const limiter = new RateLimiter(env.INDEXER_MAX_RPS);
  const client = makePublicClient(env);
  const rpc = new RpcClient(client, limiter);
  // One pinned client per configured fallback (RPC_HTTP_FALLBACK, _TERTIARY,
  // _QUATERNARY — whichever are set), bypassing the primary-preferring
  // fallback() wrapper — see makeDirectHttpClient's comment. Every entry
  // shares the SAME limiter/lane as `rpc`, so this never adds RPS budget, it
  // only spreads already-budgeted calls across more upstream destinations
  // when the head-follower's staleness watchdog trips (see head.ts) —
  // confirmed live that relying on a single fallback endpoint caps recovery
  // throughput around 1.5-2 blocks/s regardless of client-side tuning,
  // which is the fallback provider's own rate limit, not this process's.
  const fallbackPoolUrls = fallbackUrls(env);
  const fallbackPool = fallbackPoolUrls.map((url) => ({
    rpc: new RpcClient(makeDirectHttpClient(env, url), limiter),
    url,
  }));

  logger.info(
    {
      chainId: env.CHAIN_ID,
      rpc: env.RPC_HTTP_PRIMARY,
      rpcFallbackPool: fallbackPoolUrls,
      wss: env.RPC_WSS ?? null,
      maxRps: env.INDEXER_MAX_RPS,
      backfillEnabled: env.BACKFILL_ENABLED,
      backfillChunk: env.BACKFILL_CHUNK,
      reorgLimit: env.REORG_LIMIT,
      hotWindowSeconds: env.HOT_WINDOW_SECONDS,
      retentionEnabled: env.RETENTION_ENABLED,
    },
    '4663scan indexer starting',
  );

  const partitions = new LogsPartitionManager(db);
  const stockSet = new StockSetProvider(db, logger.child({ mod: 'stock-set' }));
  const head = new HeadFollower(
    db,
    rpc,
    fallbackPool,
    partitions,
    logger.child({ mod: 'head' }),
  );
  const backfill = new BackfillRunner(
    db,
    rpc,
    partitions,
    stockSet,
    logger.child({ mod: 'backfill' }),
  );
  const tokenWorker = new TokenWorker(
    db,
    client,
    rpc,
    limiter,
    logger.child({ mod: 'tokens' }),
  );
  const retention = new RetentionWorker(db, logger.child({ mod: 'retention' }));

  // Stock set loads before any 'auto'-tier writer starts: an empty set would
  // silently drop stock transfers from slim writes — a permanent loss only a
  // re-backfill could repair, so refuse to run backfill without seeds.
  await stockSet.start();
  if (env.BACKFILL_ENABLED && stockSet.get().size === 0) {
    logger.fatal(
      'stock address set is empty (did `pnpm db:seed` run?); ' +
        'refusing to start backfill, which would write slim history without stock transfers',
    );
    process.exit(1);
  }
  await head.start();
  if (env.BACKFILL_ENABLED) backfill.start();
  else logger.info('backfill disabled (BACKFILL_ENABLED=false)');
  tokenWorker.start();
  if (env.RETENTION_ENABLED) retention.start();
  else logger.info('retention disabled (RETENTION_ENABLED=false)');

  let prev = limiter.stats();
  const statsTimer = setInterval(() => {
    const s = limiter.stats();
    const bf = backfill.summary();
    logger.info(
      {
        head: head.lastIngested,
        lag: Math.max(0, head.target - head.lastIngested),
        wss: head.wssOk,
        rps: {
          head: Number(((s.head.acquired - prev.head.acquired) / (STATS_INTERVAL_MS / 1000)).toFixed(1)),
          backfill: Number(
            ((s.backfill.acquired - prev.backfill.acquired) / (STATS_INTERVAL_MS / 1000)).toFixed(1),
          ),
        },
        queues: { head: s.head.queueDepth, backfill: s.backfill.queueDepth },
        backfill:
          bf == null ? null : { cursor: bf.cursor, gaps: bf.gaps, done: bf.done },
      },
      'stats',
    );
    prev = s;
  }, STATS_INTERVAL_MS);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    clearInterval(statsTimer);
    void (async () => {
      try {
        await tokenWorker.stop();
        await head.stop();
        await backfill.stop();
        await retention.stop();
        await stockSet.stop();
        limiter.stop();
        await sql.end({ timeout: 5 });
        // Ending the session releases the advisory lock.
        await lockSql.end({ timeout: 5 });
        logger.info('shutdown complete');
      } catch (err) {
        logger.error({ err }, 'error during shutdown');
      } finally {
        // Give the pretty-transport worker a beat to flush.
        setTimeout(() => process.exit(0), 100);
      }
    })();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'indexer crashed during startup');
  process.exit(1);
});

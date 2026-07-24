import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env.js';
import * as schema from './schema.js';

export * from './schema.js';
export { schema };

export type Db = ReturnType<typeof makeDb>['db'];
export type Sql = ReturnType<typeof postgres>;

/**
 * Creates a drizzle client plus the underlying postgres.js handle (needed for
 * LISTEN/NOTIFY and raw SQL). Callers own the connection lifecycle: call
 * `sql.end()` on shutdown.
 */
export function makeDb(opts: { max?: number } = {}) {
  const sql = postgres(env.DATABASE_URL, {
    max: opts.max ?? 10,
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

/** Channel used by the indexer to announce newly ingested blocks. */
export const NEW_BLOCKS_CHANNEL = 'new_blocks';

/** Payload published on NEW_BLOCKS_CHANNEL (kept small; consumers re-query). */
export interface NewBlocksNotification {
  /** Block numbers just ingested, ascending. */
  numbers: number[];
}

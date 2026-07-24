import { env, type Env } from '@4663scan/shared/env';
import { makePublicClient } from '@4663scan/shared/chain';
import { makeDb, type Db, type Sql } from '@4663scan/shared/db';
import type { PublicClient } from 'viem';

export interface AppContext {
  env: Env;
  db: Db;
  sql: Sql;
  client: PublicClient;
}

export function createContext(): AppContext {
  const { db, sql } = makeDb({ max: 10 });
  return { env, db, sql, client: makePublicClient(env) };
}

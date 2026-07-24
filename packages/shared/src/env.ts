import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// Root .env lives three levels up from packages/shared/src.
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
loadDotenv({ path: join(ROOT_DIR, '.env'), quiet: true });

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

const envSchema = z.object({
  RPC_HTTP_PRIMARY: z.string().url().default('https://rpc.arrowrpc.com'),
  RPC_HTTP_FALLBACK: z.preprocess(
    emptyToUndefined,
    z.string().url().default('https://rpc.mainnet.chain.robinhood.com'),
  ),
  RPC_HTTP_TERTIARY: z.preprocess(emptyToUndefined, z.string().url().optional()),
  RPC_HTTP_QUATERNARY: z.preprocess(emptyToUndefined, z.string().url().optional()),
  /** Validation Cloud (2026-07-24) — keyed, added after the free-tier pool
   *  above proved rate-limit-bound; see docs/ops.md for the before/after
   *  throughput comparison. */
  RPC_HTTP_QUINARY: z.preprocess(emptyToUndefined, z.string().url().optional()),
  RPC_WSS: z.preprocess(emptyToUndefined, z.string().url().optional()),
  CHAIN_ID: z.coerce.number().int().default(4663),

  DATABASE_URL: z
    .string()
    .default('postgres://fourscan:fourscan@127.0.0.1:54663/fourscan'),
  /** false = system Postgres; scripts/db.mjs start/stop become no-ops. */
  DB_EMBEDDED: z
    .preprocess(emptyToUndefined, z.enum(['true', 'false']).default('true'))
    .transform((v) => v === 'true'),
  PGDATA_DIR: z.preprocess(emptyToUndefined, z.string().optional()),
  PGPORT: z.coerce.number().int().default(54663),

  INDEXER_MAX_RPS: z.coerce.number().positive().default(60),
  CONFIRM_DEPTH: z.coerce.number().int().positive().default(10000),
  REORG_LIMIT: z.coerce.number().int().positive().default(512),
  BACKFILL_ENABLED: z
    .preprocess(emptyToUndefined, z.enum(['true', 'false']).default('true'))
    .transform((v) => v === 'true'),
  BACKFILL_CHUNK: z.coerce.number().int().positive().default(16),

  /** Storage tiering (docs/architecture.md). Full detail is kept this long. */
  HOT_WINDOW_SECONDS: z.coerce.number().int().positive().default(604800),
  RETENTION_ENABLED: z
    .preprocess(emptyToUndefined, z.enum(['true', 'false']).default('true'))
    .transform((v) => v === 'true'),
  RETENTION_INTERVAL_SECONDS: z.coerce.number().int().positive().default(900),
  /** Block-range width of one demotion UPDATE transaction. */
  RETENTION_BATCH_BLOCKS: z.coerce.number().int().positive().default(20000),

  API_PORT: z.coerce.number().int().default(4663),
  API_HOST: z.string().default('0.0.0.0'),

  API_URL: z.preprocess(
    emptyToUndefined,
    z.string().url().default('http://localhost:4663'),
  ),

  /**
   * Paid token submissions (M8). No safe default exists for a real payee —
   * left unset, the submissions route degrades to 503 rather than accepting
   * payments toward a made-up address. Must be operator-supplied.
   */
  TREASURY_ADDRESS: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 40-hex-char address')
      .optional(),
  ),
  SUBMISSION_PRICE_USD: z.coerce.number().positive().default(99),
  /** Global Dollar (USDG) — confirmed 2026-07 as chain 4663's own native,
   *  liquid USD stablecoin (Paxos-issued, ~$280M+ supply, tens of thousands
   *  of holders on this chain) — see docs/ops.md. */
  PAYMENT_TOKEN_ADDRESS: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .default('0x5fc5360d0400a0fd4f2af552add042d716f1d168'),
  ),
  PAYMENT_TOKEN_SYMBOL: z.string().default('USDG'),
  PAYMENT_TOKEN_DECIMALS: z.coerce.number().int().positive().default(6),
  /** How long a frozen price_quoted_usd stays honorable before the payer
   *  must resubmit the form for a fresh quote. */
  PAYMENT_QUOTE_WINDOW_HOURS: z.coerce.number().positive().default(24),
  /** Reject a payment tx older than this even if everything else checks out
   *  — guards against replaying an old, unrelated treasury-bound transfer. */
  PAYMENT_MAX_TX_AGE_SECONDS: z.coerce.number().int().positive().default(86400),
});

export type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(process.env);

export const rootDir: string = ROOT_DIR;

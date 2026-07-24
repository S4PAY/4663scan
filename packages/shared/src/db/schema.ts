import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { hexBytea } from './hex-bytea.js';

/**
 * Conventions:
 * - Addresses, hashes, topics and calldata are stored as bytea via the
 *   hexBytea codec and surface app-side as 0x-prefixed lowercase hex strings.
 * - uint256 / wei quantities use numeric(78,0) and surface as strings.
 * - Gas *units*, block numbers and unix timestamps fit in 2^53 and use
 *   bigint columns in 'number' mode.
 * - Storage is tiered (see docs/architecture.md): rows older than the hot
 *   window are demoted in place — the columns marked "hot tier only" below
 *   are set to NULL and the block's logs are dropped with their partition.
 *   There are deliberately no FKs from child tables to blocks: reorg
 *   rollback deletes children explicitly, and cascades would couple pruning
 *   of blocks to the never-pruned stock-token transfers.
 */

export const blocks = pgTable(
  'blocks',
  {
    number: bigint('number', { mode: 'number' }).primaryKey(),
    hash: hexBytea('hash').notNull(),
    /** Hot tier only; NULL marks a slim (demoted) block. */
    parentHash: hexBytea('parent_hash'),
    timestamp: bigint('timestamp', { mode: 'number' }).notNull(),
    txCount: integer('tx_count').notNull(),
    gasUsed: bigint('gas_used', { mode: 'number' }).notNull(),
    gasLimit: bigint('gas_limit', { mode: 'number' }).notNull(),
    /** Hot tier only. */
    baseFeePerGas: numeric('base_fee_per_gas', { precision: 78, scale: 0 }),
    /** Hot tier only. */
    miner: hexBytea('miner'),
    /** Hot tier only. */
    size: bigint('size', { mode: 'number' }),
    /** Hot tier only. */
    l1BlockNumber: bigint('l1_block_number', { mode: 'number' }),
  },
  (t) => [
    uniqueIndex('blocks_hash_idx').on(t.hash),
    index('blocks_timestamp_idx').on(t.timestamp),
    // Not-yet-demoted rows only; keeps retention scans off slim history.
    index('blocks_hot_idx')
      .on(t.number)
      .where(sql`parent_hash is not null`),
  ],
);

export const transactions = pgTable(
  'transactions',
  {
    hash: hexBytea('hash').primaryKey(),
    blockNumber: bigint('block_number', { mode: 'number' }).notNull(),
    /** Hot tier only; NULL marks a slim (demoted) tx. Use `input` as the tier flag. */
    blockHash: hexBytea('block_hash'),
    txIndex: integer('tx_index').notNull(),
    timestamp: bigint('timestamp', { mode: 'number' }).notNull(),
    from: hexBytea('from').notNull(),
    to: hexBytea('to'),
    value: numeric('value', { precision: 78, scale: 0 }).notNull(),
    /** Hot tier only. */
    nonce: bigint('nonce', { mode: 'number' }),
    /** Tx type as an integer (Arbitrum system types go up to 0x6a = 106). Hot tier only. */
    type: integer('type'),
    /** Hot tier only. */
    gas: numeric('gas', { precision: 78, scale: 0 }),
    /** Hot tier only. */
    gasPrice: numeric('gas_price', { precision: 78, scale: 0 }),
    /** Hot tier only. */
    maxFeePerGas: numeric('max_fee_per_gas', { precision: 78, scale: 0 }),
    /** Hot tier only. */
    maxPriorityFeePerGas: numeric('max_priority_fee_per_gas', {
      precision: 78,
      scale: 0,
    }),
    /** First 4 bytes of calldata, e.g. '0xa9059cbb'; null for plain transfers. */
    methodId: hexBytea('method_id'),
    /**
     * Full calldata. Hot tier only: NULL is the slim-tier marker (an empty
     * calldata hot tx stores 0-length bytes, not NULL) and triggers the API's
     * ephemeral RPC hydration for detail views.
     */
    input: hexBytea('input'),
    /** Receipt fields. 1 = success, 0 = reverted. */
    status: integer('status'),
    /** Hot tier only. */
    gasUsed: bigint('gas_used', { mode: 'number' }),
    /** Hot tier only. */
    effectiveGasPrice: numeric('effective_gas_price', { precision: 78, scale: 0 }),
    /** Arbitrum: portion of gasUsed covering L1 calldata posting. Hot tier only. */
    gasUsedForL1: bigint('gas_used_for_l1', { mode: 'number' }),
    /** Contract address when this tx is a deployment. */
    contractAddress: hexBytea('contract_address'),
  },
  (t) => [
    index('txs_block_idx').on(t.blockNumber.desc(), t.txIndex.desc()),
    index('txs_from_idx').on(t.from, t.blockNumber.desc(), t.txIndex.desc()),
    index('txs_to_idx').on(t.to, t.blockNumber.desc(), t.txIndex.desc()),
    index('txs_contract_address_idx')
      .on(t.contractAddress)
      .where(sql`contract_address is not null`),
    // Not-yet-demoted rows only; keeps retention scans off slim history.
    index('txs_hot_idx')
      .on(t.blockNumber)
      .where(sql`input is not null`),
  ],
);

/**
 * Range-partitioned by block_number (the CREATE TABLE ... PARTITION BY lives
 * in the hand-edited initial migration; drizzle-kit must never regenerate
 * this table). Partitions are created ahead by the writer and dropped whole
 * by the retention job — logs have no slim tier.
 */
export const logs = pgTable(
  'logs',
  {
    blockNumber: bigint('block_number', { mode: 'number' }).notNull(),
    logIndex: integer('log_index').notNull(),
    txHash: hexBytea('tx_hash').notNull(),
    txIndex: integer('tx_index').notNull(),
    address: hexBytea('address').notNull(),
    topic0: hexBytea('topic0'),
    topic1: hexBytea('topic1'),
    topic2: hexBytea('topic2'),
    topic3: hexBytea('topic3'),
    data: hexBytea('data').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.blockNumber, t.logIndex] }),
    index('logs_tx_idx').on(t.txHash),
    index('logs_address_idx').on(t.address, t.blockNumber.desc()),
  ],
);

export const tokenTransfers = pgTable(
  'token_transfers',
  {
    blockNumber: bigint('block_number', { mode: 'number' }).notNull(),
    logIndex: integer('log_index').notNull(),
    txHash: hexBytea('tx_hash').notNull(),
    timestamp: bigint('timestamp', { mode: 'number' }).notNull(),
    tokenAddress: hexBytea('token_address').notNull(),
    from: hexBytea('from').notNull(),
    to: hexBytea('to').notNull(),
    value: numeric('value', { precision: 78, scale: 0 }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.blockNumber, t.logIndex] }),
    index('transfers_tx_idx').on(t.txHash),
    index('transfers_token_idx').on(
      t.tokenAddress,
      t.blockNumber.desc(),
      t.logIndex.desc(),
    ),
    index('transfers_from_idx').on(t.from, t.blockNumber.desc(), t.logIndex.desc()),
    index('transfers_to_idx').on(t.to, t.blockNumber.desc(), t.logIndex.desc()),
  ],
);

/**
 * Forever-tier (holder, token) sightings — one row per pair, ever. Written by
 * every transfer writer (head follower, backfill, API cold persist) from the
 * *unfiltered* decoded transfers, so slim blocks — whose non-stock transfer
 * rows are never stored — still register the pair. Holdings discovery reads
 * this instead of token_transfers (which retention prunes past the hot
 * window), so a wallet's token set survives forever. Pairs only, no amounts:
 * balances come from live balanceOf. Never pruned. Sightings from orphaned
 * fork blocks are deliberately not rolled back — a stale pair just yields a
 * zero balance, which the holdings endpoint filters out.
 */
export const addressTokenSeen = pgTable(
  'address_token_seen',
  {
    address: hexBytea('address').notNull(),
    tokenAddress: hexBytea('token_address').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.address, t.tokenAddress] }),
    // PK leads with `address`, so a holder-count query filtering on
    // `tokenAddress` alone (COUNT(*) WHERE token_address = X — the PK
    // already guarantees one row per distinct holder, no DISTINCT needed)
    // would otherwise need a full-table scan. See M5's logs-query lesson:
    // add the index up front rather than discover the same pathology live.
    index('address_token_seen_token_idx').on(t.tokenAddress),
  ],
);

export const tokens = pgTable(
  'tokens',
  {
    address: hexBytea('address').primaryKey(),
    /** null until metadata fetch succeeds. */
    name: text('name'),
    symbol: text('symbol'),
    decimals: integer('decimals'),
    totalSupply: numeric('total_supply', { precision: 78, scale: 0 }),
    type: text('type').notNull().default('erc20'),
    isStockToken: boolean('is_stock_token').notNull().default(false),
    /** Whether the metadata fetch (name/symbol/decimals) has completed. */
    metadataFetched: boolean('metadata_fetched').notNull().default(false),
    firstSeenBlock: bigint('first_seen_block', { mode: 'number' }),
    lastSeenBlock: bigint('last_seen_block', { mode: 'number' }),
    metadata: jsonb('metadata'),
  },
  (t) => [
    index('tokens_symbol_idx').on(t.symbol),
    index('tokens_stock_idx').on(t.isStockToken),
  ],
);

/**
 * Stock Token registry. Populated from the canonical registry file and by the
 * discovery heuristic. Loosely joined to tokens (no FK: registry entries may
 * precede on-chain discovery).
 */
export const stockTokens = pgTable('stock_tokens', {
  tokenAddress: hexBytea('token_address').primaryKey(),
  ticker: text('ticker').notNull(),
  companyName: text('company_name'),
  issuerAddress: hexBytea('issuer_address'),
  /** 'registry' | 'heuristic' | 'manual' */
  source: text('source').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** Served path (e.g. '/token-logos/0xabc….webp'); null = not fetched or
   *  unavailable upstream. Self-hosted — never hotlinked. */
  logoPath: text('logo_path'),
  /** 'robinhood-rhj-assets' today; room for a fallback provider later. */
  logoSource: text('logo_source'),
  logoFetchedAt: timestamp('logo_fetched_at', { withTimezone: true }),
  /** 'stock' | 'etf' — best-effort from company-name keywords, not a
   *  certified classification (see logos.ts). */
  assetClass: text('asset_class'),
  /** Chainlink price-feed proxy address on this chain, when matched by
   *  ticker against Chainlink's own published Robinhood-chain feed list —
   *  null for the ~2/3 of stock tokens without one yet. */
  chainlinkFeed: hexBytea('chainlink_feed'),
});

export const addressLabels = pgTable('address_labels', {
  address: hexBytea('address').primaryKey(),
  label: text('label').notNull(),
  /** 'bridge' | 'sequencer' | 'issuer' | 'dex' | 'token' | 'system' | 'other' */
  category: text('category').notNull().default('other'),
  source: text('source'),
});

/**
 * Method selector → human signature cache. A row with null signature is a
 * negative cache entry (looked up upstream, not found).
 */
export const methodSignatures = pgTable('method_signatures', {
  selector: hexBytea('selector').primaryKey(),
  signature: text('signature'),
  name: text('name'),
  /** 'known' | 'openchain' | '4byte' */
  source: text('source'),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Verified contract source cache (Sourcify, then Blockscout as fallback),
 * keyed by address. verified=true rows are permanent: once a deployment is
 * verified its source never changes, so these are never re-checked or
 * pruned. verified=false is a negative cache entry — re-checked upstream
 * after CONTRACT_SOURCE_RECHECK_MS (short: verification commonly lands
 * within hours of deployment, unlike method-signature discovery).
 */
export const contractSources = pgTable('contract_sources', {
  address: hexBytea('address').primaryKey(),
  verified: boolean('verified').notNull(),
  name: text('name'),
  compilerVersion: text('compiler_version'),
  compilerSettings: jsonb('compiler_settings'),
  abi: jsonb('abi'),
  /** [{ path, content }] — multi-file aware. */
  sourceFiles: jsonb('source_files'),
  /** 'sourcify' | 'blockscout' */
  provider: text('provider'),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
});
export type ContractSourceRow = typeof contractSources.$inferSelect;
export type ContractSourceInsert = typeof contractSources.$inferInsert;

/**
 * Indexer checkpoints, keyed singleton rows:
 *   'head'      → { lastBlock: number, lastHash: string }
 *   'backfill'  → { cursor: number | null, floor: number, startedFrom: number,
 *                   gaps: { lo: number, hi: number }[] }
 *   'retention' → { transfersPrunedThrough: number }
 */
export const indexerState = pgTable('indexer_state', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Community token-info submissions (M7 charter; paid gate added M8). Nothing
 * here is ever surfaced publicly by address alone — a row existing is not
 * the same as it being shown anywhere. A row starts 'awaiting_payment' (the
 * free path was removed in M8); only a verified on-chain payment moves it to
 * 'pending', and only a human reviewer
 * (apps/api/src/review-submissions.ts, docs/ops.md) moves it from there to
 * 'approved' or 'rejected' — payment alone never publishes anything.
 * logoPath (if present) is always this app's own re-encoded copy, never the
 * submitter's raw upload/URL — see routes/submissions.ts.
 */
export const tokenSubmissions = pgTable(
  'token_submissions',
  {
    id: serial('id').primaryKey(),
    tokenAddress: hexBytea('token_address').notNull(),
    projectName: text('project_name').notNull(),
    logoPath: text('logo_path'),
    website: text('website'),
    socials: text('socials'),
    description: text('description'),
    contactEmail: text('contact_email').notNull(),
    /** 'awaiting_payment' | 'pending' | 'approved' | 'rejected' */
    status: text('status').notNull().default('awaiting_payment'),
    submitterIp: text('submitter_ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewNote: text('review_note'),
    /**
     * Opaque per-row secret (random, unrelated to the serial id) required
     * alongside :id on the payment-lookup/verify endpoints — without it,
     * enumerating ids would let a stranger read or pay toward someone else's
     * submission. See apps/api/src/services/payments.ts.
     */
    paymentToken: text('payment_token').notNull(),
    /** USD price frozen at form-submission time — never re-read live. */
    priceQuotedUsd: numeric('price_quoted_usd', { precision: 12, scale: 2 }).notNull(),
    quoteExpiresAt: timestamp('quote_expires_at', { withTimezone: true }).notNull(),
    /**
     * Set only once verification fully succeeds (see verifyPayment) — the
     * UNIQUE index below is what makes replaying a tx hash against a second
     * submission fail atomically at the DB layer, not just in application
     * logic.
     */
    paymentTxHash: hexBytea('payment_tx_hash'),
    /** Raw on-chain units actually received (may exceed priceQuotedUsd). */
    paidAmount: numeric('paid_amount', { precision: 78, scale: 0 }),
    paidAsset: text('paid_asset'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('token_submissions_payment_tx_hash_idx').on(t.paymentTxHash),
    uniqueIndex('token_submissions_payment_token_idx').on(t.paymentToken),
  ],
);

export type BlockRow = typeof blocks.$inferSelect;
export type BlockInsert = typeof blocks.$inferInsert;
export type TxRow = typeof transactions.$inferSelect;
export type TxInsert = typeof transactions.$inferInsert;
export type LogRow = typeof logs.$inferSelect;
export type LogInsert = typeof logs.$inferInsert;
export type TokenTransferRow = typeof tokenTransfers.$inferSelect;
export type TokenTransferInsert = typeof tokenTransfers.$inferInsert;
export type TokenRow = typeof tokens.$inferSelect;
export type TokenInsert = typeof tokens.$inferInsert;
export type StockTokenRow = typeof stockTokens.$inferSelect;
export type StockTokenInsert = typeof stockTokens.$inferInsert;
export type AddressLabelRow = typeof addressLabels.$inferSelect;
export type MethodSignatureRow = typeof methodSignatures.$inferSelect;
export type TokenSubmissionRow = typeof tokenSubmissions.$inferSelect;
export type TokenSubmissionInsert = typeof tokenSubmissions.$inferInsert;

CREATE TABLE "address_labels" (
	"address" "bytea" PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"source" text
);
--> statement-breakpoint
CREATE TABLE "blocks" (
	"number" bigint PRIMARY KEY NOT NULL,
	"hash" "bytea" NOT NULL,
	"parent_hash" "bytea",
	"timestamp" bigint NOT NULL,
	"tx_count" integer NOT NULL,
	"gas_used" bigint NOT NULL,
	"gas_limit" bigint NOT NULL,
	"base_fee_per_gas" numeric(78, 0),
	"miner" "bytea",
	"size" bigint,
	"l1_block_number" bigint
);
--> statement-breakpoint
CREATE TABLE "indexer_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "logs" (
	"block_number" bigint NOT NULL,
	"log_index" integer NOT NULL,
	"tx_hash" "bytea" NOT NULL,
	"tx_index" integer NOT NULL,
	"address" "bytea" NOT NULL,
	"topic0" "bytea",
	"topic1" "bytea",
	"topic2" "bytea",
	"topic3" "bytea",
	"data" "bytea" NOT NULL,
	CONSTRAINT "logs_block_number_log_index_pk" PRIMARY KEY("block_number","log_index")
) PARTITION BY RANGE ("block_number");
--> statement-breakpoint
CREATE TABLE "method_signatures" (
	"selector" "bytea" PRIMARY KEY NOT NULL,
	"signature" text,
	"name" text,
	"source" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_tokens" (
	"token_address" "bytea" PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"company_name" text,
	"issuer_address" "bytea",
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_transfers" (
	"block_number" bigint NOT NULL,
	"log_index" integer NOT NULL,
	"tx_hash" "bytea" NOT NULL,
	"timestamp" bigint NOT NULL,
	"token_address" "bytea" NOT NULL,
	"from" "bytea" NOT NULL,
	"to" "bytea" NOT NULL,
	"value" numeric(78, 0) NOT NULL,
	CONSTRAINT "token_transfers_block_number_log_index_pk" PRIMARY KEY("block_number","log_index")
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"address" "bytea" PRIMARY KEY NOT NULL,
	"name" text,
	"symbol" text,
	"decimals" integer,
	"total_supply" numeric(78, 0),
	"type" text DEFAULT 'erc20' NOT NULL,
	"is_stock_token" boolean DEFAULT false NOT NULL,
	"metadata_fetched" boolean DEFAULT false NOT NULL,
	"first_seen_block" bigint,
	"last_seen_block" bigint,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"hash" "bytea" PRIMARY KEY NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" "bytea",
	"tx_index" integer NOT NULL,
	"timestamp" bigint NOT NULL,
	"from" "bytea" NOT NULL,
	"to" "bytea",
	"value" numeric(78, 0) NOT NULL,
	"nonce" bigint,
	"type" integer,
	"gas" numeric(78, 0),
	"gas_price" numeric(78, 0),
	"max_fee_per_gas" numeric(78, 0),
	"max_priority_fee_per_gas" numeric(78, 0),
	"method_id" "bytea",
	"input" "bytea",
	"status" integer,
	"gas_used" bigint,
	"effective_gas_price" numeric(78, 0),
	"gas_used_for_l1" bigint,
	"contract_address" "bytea"
);
--> statement-breakpoint
CREATE UNIQUE INDEX "blocks_hash_idx" ON "blocks" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "blocks_timestamp_idx" ON "blocks" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "blocks_hot_idx" ON "blocks" USING btree ("number") WHERE parent_hash is not null;--> statement-breakpoint
CREATE INDEX "logs_tx_idx" ON "logs" USING btree ("tx_hash");--> statement-breakpoint
CREATE INDEX "logs_address_idx" ON "logs" USING btree ("address","block_number" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transfers_tx_idx" ON "token_transfers" USING btree ("tx_hash");--> statement-breakpoint
CREATE INDEX "transfers_token_idx" ON "token_transfers" USING btree ("token_address","block_number" DESC NULLS LAST,"log_index" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transfers_from_idx" ON "token_transfers" USING btree ("from","block_number" DESC NULLS LAST,"log_index" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transfers_to_idx" ON "token_transfers" USING btree ("to","block_number" DESC NULLS LAST,"log_index" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tokens_symbol_idx" ON "tokens" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "tokens_stock_idx" ON "tokens" USING btree ("is_stock_token");--> statement-breakpoint
CREATE INDEX "txs_block_idx" ON "transactions" USING btree ("block_number" DESC NULLS LAST,"tx_index" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "txs_from_idx" ON "transactions" USING btree ("from","block_number" DESC NULLS LAST,"tx_index" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "txs_to_idx" ON "transactions" USING btree ("to","block_number" DESC NULLS LAST,"tx_index" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "txs_contract_address_idx" ON "transactions" USING btree ("contract_address") WHERE contract_address is not null;--> statement-breakpoint
CREATE INDEX "txs_hot_idx" ON "transactions" USING btree ("block_number") WHERE input is not null;--> statement-breakpoint
-- Hand-written storage tuning (docs/architecture.md). Demotion NULLs only
-- unindexed columns, so fillfactor slack makes those UPDATEs HOT (heap-only);
-- tighter autovacuum keeps the churned block ranges compact.
ALTER TABLE "transactions" SET (fillfactor = 90, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);--> statement-breakpoint
ALTER TABLE "blocks" SET (fillfactor = 90, autovacuum_vacuum_scale_factor = 0.02);--> statement-breakpoint
ALTER TABLE "token_transfers" SET (autovacuum_vacuum_scale_factor = 0.02);
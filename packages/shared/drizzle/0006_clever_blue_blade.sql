ALTER TABLE "token_submissions" ALTER COLUMN "status" SET DEFAULT 'awaiting_payment';--> statement-breakpoint
ALTER TABLE "token_submissions" ADD COLUMN "payment_token" text NOT NULL;--> statement-breakpoint
ALTER TABLE "token_submissions" ADD COLUMN "price_quoted_usd" numeric(12, 2) NOT NULL;--> statement-breakpoint
ALTER TABLE "token_submissions" ADD COLUMN "quote_expires_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "token_submissions" ADD COLUMN "payment_tx_hash" "bytea";--> statement-breakpoint
ALTER TABLE "token_submissions" ADD COLUMN "paid_amount" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "token_submissions" ADD COLUMN "paid_asset" text;--> statement-breakpoint
ALTER TABLE "token_submissions" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "token_submissions_payment_tx_hash_idx" ON "token_submissions" USING btree ("payment_tx_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "token_submissions_payment_token_idx" ON "token_submissions" USING btree ("payment_token");
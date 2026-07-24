ALTER TABLE "stock_tokens" ADD COLUMN "logo_path" text;--> statement-breakpoint
ALTER TABLE "stock_tokens" ADD COLUMN "logo_source" text;--> statement-breakpoint
ALTER TABLE "stock_tokens" ADD COLUMN "logo_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stock_tokens" ADD COLUMN "asset_class" text;--> statement-breakpoint
ALTER TABLE "stock_tokens" ADD COLUMN "chainlink_feed" "bytea";
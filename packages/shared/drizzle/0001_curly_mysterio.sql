CREATE TABLE "address_token_seen" (
	"address" "bytea" NOT NULL,
	"token_address" "bytea" NOT NULL,
	CONSTRAINT "address_token_seen_address_token_address_pk" PRIMARY KEY("address","token_address")
);
--> statement-breakpoint
-- Hand-written seed (docs/architecture.md): capture every (holder, token)
-- pair already in token_transfers before retention can prune the rows.
-- Zero-address mint/burn counterparties are skipped, matching the writers.
-- Deploying to a LIVE stack: pre-pairs writers keep inserting transfers
-- between this migration and their restart — re-run this INSERT once after
-- the restart (idempotent) or those pairs are lost when retention passes.
INSERT INTO "address_token_seen" ("address", "token_address")
SELECT "from", "token_address" FROM "token_transfers"
WHERE "from" <> '\x0000000000000000000000000000000000000000'::bytea
UNION
SELECT "to", "token_address" FROM "token_transfers"
WHERE "to" <> '\x0000000000000000000000000000000000000000'::bytea
ON CONFLICT DO NOTHING;

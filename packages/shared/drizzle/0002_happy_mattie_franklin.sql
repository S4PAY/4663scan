CREATE TABLE "contract_sources" (
	"address" "bytea" PRIMARY KEY NOT NULL,
	"verified" boolean NOT NULL,
	"name" text,
	"compiler_version" text,
	"compiler_settings" jsonb,
	"abi" jsonb,
	"source_files" jsonb,
	"provider" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);

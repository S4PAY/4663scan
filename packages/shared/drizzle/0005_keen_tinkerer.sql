CREATE TABLE "token_submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_address" "bytea" NOT NULL,
	"project_name" text NOT NULL,
	"logo_path" text,
	"website" text,
	"socials" text,
	"description" text,
	"contact_email" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"submitter_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"review_note" text
);

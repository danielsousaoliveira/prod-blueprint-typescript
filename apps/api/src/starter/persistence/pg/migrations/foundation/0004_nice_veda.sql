CREATE TABLE "app"."identities" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text NOT NULL,
	"profile_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identities_email_unique" UNIQUE("email"),
	CONSTRAINT "identities_email_normalised" CHECK ("app"."identities"."email" = lower(btrim("app"."identities"."email"))),
	CONSTRAINT "identities_role_valid" CHECK ("app"."identities"."role" IN ('doctor', 'patient'))
);
--> statement-breakpoint
ALTER TABLE "app"."people" ADD COLUMN "identity_id" text;--> statement-breakpoint
ALTER TABLE "app"."people" ADD CONSTRAINT "people_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "app"."identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."people" ADD CONSTRAINT "people_organisation_id_identity_id_unique" UNIQUE("organisation_id","identity_id");
CREATE TABLE "app"."invitations" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_pkey" PRIMARY KEY("organisation_id","id"),
	CONSTRAINT "invitations_organisation_id_token_hash_unique" UNIQUE("organisation_id","token_hash"),
	CONSTRAINT "invitations_email_lowercase" CHECK ("app"."invitations"."email" = lower("app"."invitations"."email")),
	CONSTRAINT "invitations_role_valid" CHECK ("app"."invitations"."role" IN ('owner', 'admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE "app"."memberships" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_pkey" PRIMARY KEY("organisation_id","id"),
	CONSTRAINT "memberships_organisation_id_person_id_unique" UNIQUE("organisation_id","person_id"),
	CONSTRAINT "memberships_role_valid" CHECK ("app"."memberships"."role" IN ('owner', 'admin', 'member')),
	CONSTRAINT "memberships_status_valid" CHECK ("app"."memberships"."status" IN ('active', 'suspended'))
);
--> statement-breakpoint
CREATE TABLE "app"."organisations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organisations_slug_unique" UNIQUE("slug"),
	CONSTRAINT "organisations_slug_format" CHECK ("app"."organisations"."slug" ~ '^[a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9]$')
);
--> statement-breakpoint
CREATE TABLE "app"."people" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "people_pkey" PRIMARY KEY("organisation_id","id"),
	CONSTRAINT "people_organisation_id_email_unique" UNIQUE("organisation_id","email"),
	CONSTRAINT "people_email_lowercase" CHECK ("app"."people"."email" = lower("app"."people"."email"))
);
--> statement-breakpoint
ALTER TABLE "app"."invitations" ADD CONSTRAINT "invitations_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "app"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."memberships" ADD CONSTRAINT "memberships_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "app"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."memberships" ADD CONSTRAINT "memberships_person_fk" FOREIGN KEY ("organisation_id","person_id") REFERENCES "app"."people"("organisation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."people" ADD CONSTRAINT "people_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "app"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invitations_organisation_id_email_idx" ON "app"."invitations" USING btree ("organisation_id","email");--> statement-breakpoint
CREATE INDEX "memberships_organisation_id_role_idx" ON "app"."memberships" USING btree ("organisation_id","role");
--> statement-breakpoint
DROP TABLE "app"."tenants" CASCADE;

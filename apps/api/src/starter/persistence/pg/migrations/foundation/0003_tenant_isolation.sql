CREATE FUNCTION "app"."current_organisation_id"() RETURNS uuid
  LANGUAGE plpgsql
  STABLE
AS $$
DECLARE
  raw text := current_setting('app.current_organisation', true);
BEGIN
  IF raw IS NULL OR raw = '' THEN
    RAISE EXCEPTION 'tenant context is not set'
      USING ERRCODE = 'TF001',
            HINT = 'Run the query inside a tenant transaction.';
  END IF;

  BEGIN
    RETURN raw::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'tenant context is not a valid organisation id'
      USING ERRCODE = 'TF002';
  END;
END
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "app"."current_organisation_id"() TO "tenantforge_app", "tenantforge_crosstenant";
--> statement-breakpoint
ALTER TABLE "app"."people" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."people" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "organisation_isolation" ON "app"."people"
  AS PERMISSIVE FOR ALL
  USING ("organisation_id" = (SELECT "app"."current_organisation_id"()))
  WITH CHECK ("organisation_id" = (SELECT "app"."current_organisation_id"()));
--> statement-breakpoint
ALTER TABLE "app"."memberships" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."memberships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "organisation_isolation" ON "app"."memberships"
  AS PERMISSIVE FOR ALL
  USING ("organisation_id" = (SELECT "app"."current_organisation_id"()))
  WITH CHECK ("organisation_id" = (SELECT "app"."current_organisation_id"()));
--> statement-breakpoint
ALTER TABLE "app"."invitations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."invitations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "organisation_isolation" ON "app"."invitations"
  AS PERMISSIVE FOR ALL
  USING ("organisation_id" = (SELECT "app"."current_organisation_id"()))
  WITH CHECK ("organisation_id" = (SELECT "app"."current_organisation_id"()));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON "app"."organisations" FROM "tenantforge_app";
--> statement-breakpoint
REVOKE DELETE ON "app"."organisations" FROM "tenantforge_crosstenant";

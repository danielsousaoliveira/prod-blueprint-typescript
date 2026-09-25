-- Custom migration (not schema-generated): privileges for the three-role separation the
-- tenant-isolation model depends on. A schema differ cannot express grants, default
-- privileges or REVOKEs, so this is hand-written and interleaved into the same ordered
-- sequence as the generated files.
--
-- Runs as the migration (owner) role. Idempotent — GRANT / REVOKE / ALTER DEFAULT
-- PRIVILEGES all restate cleanly, so re-running the sequence is a no-op.
--
-- The roles themselves are created by deploy/postgres/init/01-roles.sql, applied
-- identically by local infrastructure, the test harness and the deployment.

GRANT USAGE ON SCHEMA "app" TO "tenantforge_app", "tenantforge_crosstenant";
--> statement-breakpoint

-- The runtime and cross-tenant roles must never own objects in this schema: an object's
-- owner bypasses a row-level-security policy unless it is FORCEd, so ownership alone
-- would make the isolation added next phase silently decorative.
REVOKE CREATE ON SCHEMA "app" FROM "tenantforge_app", "tenantforge_crosstenant";
--> statement-breakpoint
REVOKE CREATE ON SCHEMA "app" FROM PUBLIC;
--> statement-breakpoint

-- Existing objects.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "app"
  TO "tenantforge_app", "tenantforge_crosstenant";
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "app"
  TO "tenantforge_app", "tenantforge_crosstenant";
--> statement-breakpoint

-- Future objects. Without these, every table a LATER migration adds is unreadable by the
-- runtime role, and the failure surfaces in that deployment rather than this one. Keyed
-- to the owner role because that is what every migration creates objects as.
ALTER DEFAULT PRIVILEGES IN SCHEMA "app"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES
  TO "tenantforge_app", "tenantforge_crosstenant";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "app"
  GRANT USAGE, SELECT ON SEQUENCES
  TO "tenantforge_app", "tenantforge_crosstenant";

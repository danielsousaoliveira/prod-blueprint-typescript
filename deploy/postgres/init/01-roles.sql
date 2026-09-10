-- Three-role separation the tenant-isolation model depends on.
--
-- Applied identically by local infrastructure (mounted into
-- /docker-entrypoint-initdb.d), the integration test harness, and the deployment — if
-- these three diverge, a test proves something the deployment does not do.
--
--   tenantforge_owner        owns the `app` schema and every object in it, and may
--                            bypass row-level security (BYPASSRLS). Used ONLY by the
--                            migration runner.
--   tenantforge_app          the runtime role. Owns nothing, cannot create objects,
--                            cannot bypass row-level security. If isolation is ever
--                            merely decorative, this is the role that reveals it.
--   tenantforge_crosstenant  narrowly privileged: BYPASSRLS for the two operations that
--                            legitimately span tenants — relaying the outbox for all
--                            tenants in one poll, and resolving which tenant a billing
--                            webhook belongs to before any tenant context exists. Owns
--                            nothing.
--
-- Grants and default privileges are NOT here — they belong to the migration that
-- creates the schema (see src/persistence/pg/migrations/foundation/0001_roles_grants.sql).
-- This file only provisions the roles.
--
-- Passwords are local/test values. The deployment injects real secrets and provisions
-- the roles the same way.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tenantforge_owner') THEN
    CREATE ROLE tenantforge_owner LOGIN PASSWORD 'owner' BYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tenantforge_app') THEN
    CREATE ROLE tenantforge_app LOGIN PASSWORD 'app';
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tenantforge_crosstenant') THEN
    CREATE ROLE tenantforge_crosstenant LOGIN PASSWORD 'crosstenant' BYPASSRLS;
  END IF;
END
$$;

-- The migration role owns unqualified objects it creates, and resolves `app` first.
ALTER ROLE tenantforge_owner SET search_path TO app, public;

-- The migration role must be able to CREATE SCHEMA in this database (the `app` schema
-- and the `drizzle` bookkeeping schema). Scoped to the current database so the file is
-- environment-agnostic. The runtime and cross-tenant roles get no such privilege.
DO $$
BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO tenantforge_owner', current_database());
END
$$;

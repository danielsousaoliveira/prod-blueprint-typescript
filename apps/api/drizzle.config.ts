import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit is used for schema-driven migration GENERATION only — `db:generate:pg`.
 * Applying migrations is the runner's job (src/persistence/pg/migrator.ts); drizzle-kit
 * never touches a deployed database, so `push` and `studio` are not used here.
 *
 * Generation is offline: it diffs schema.ts against the snapshot under
 * migrations/foundation/meta. The credentials below exist only to satisfy the config
 * shape.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/persistence/pg/schema.ts',
  out: './src/persistence/pg/migrations/foundation',
  migrations: {
    // Bookkeeping table lives in its own `drizzle` schema, not in `app` — the
    // application schema is created by migration 0000 and must not pre-exist. Each
    // sequence gets its own table so the runner can apply several in order.
    schema: 'drizzle',
    table: '__drizzle_migrations_foundation',
  },
  dbCredentials: {
    url: process.env.POSTGRES_MIGRATION_URL ?? 'postgres://localhost:5432/tenantforge',
  },
});

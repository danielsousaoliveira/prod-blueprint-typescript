import { pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Typed schema for the relational database.
 *
 * `drizzle-kit generate` diffs this against the snapshot in migrations/foundation/meta
 * and writes the SQL, so the schema and the database cannot silently disagree — the
 * failure this project cares most about avoiding. The generated files are applied by the
 * runner in migrator.ts, never by drizzle-kit against a live database.
 *
 * Everything lives in the `app` schema, which is owned by the migration role. Nothing
 * reads from any of this yet: the phase stands Postgres up beside MongoDB with no
 * behaviour change.
 */
export const appSchema = pgSchema('app');

/**
 * The tenant registry — the row every other table is partitioned by once isolation
 * lands in the next phase. Defined now so the migration workflow and the role grants
 * operate on a real table rather than an empty schema.
 */
export const tenants = appSchema.table('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';

/**
 * Ordered, forward-only Postgres migrations — the same discipline as the hand-rolled
 * MongoDB runner it takes after:
 *
 *   - a SEPARATE DEPLOY STEP, never on application boot. Several instances starting at
 *     once would race, an index build would block the boot it is attached to, and a
 *     deploy that silently mutates schema leaves no record of when or whether it ran.
 *   - forward-only and idempotent: re-running applies nothing, because a deploy step
 *     gets retried.
 *   - every migration BACKWARDS COMPATIBLE with the currently-running code, because both
 *     versions serve traffic during a rolling deploy. Additive only — add a column or
 *     index in release N, drop it in release N+1 once nothing running depends on it.
 *
 * What changes from the MongoDB version: the migrations are GENERATED from
 * schema.ts by `drizzle-kit generate` rather than written by hand, so the schema and the
 * database cannot drift apart. Hand-written SQL — roles, grants, RLS policies,
 * functions, exclusion constraints, none of which are schema differences — is
 * interleaved into the same numbered sequence as `--custom` files (see 0001).
 *
 * The runner applies an ORDERED LIST of sequences rather than assuming one: the
 * foundation and its later demonstration will split into separate sequences, each with
 * its own journal table. It connects as the migration (owner) role — never the runtime
 * role, which cannot create objects.
 */
export interface MigrationSequence {
  readonly name: string;
  readonly folder: string;
  readonly journalTable: string;
}

const MIGRATIONS_ROOT = join(__dirname, 'migrations');

export const SEQUENCES: readonly MigrationSequence[] = [
  {
    name: 'foundation',
    folder: join(MIGRATIONS_ROOT, 'foundation'),
    journalTable: '__drizzle_migrations_foundation',
  },
];

export async function runPgMigrations(
  connectionString: string,
  sequences: readonly MigrationSequence[] = SEQUENCES,
  log: (message: string) => void = () => {},
): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    const db = drizzle(client);

    for (const sequence of sequences) {
      log(`applying sequence ${sequence.name}`);
      await migrate(db, {
        migrationsFolder: sequence.folder,
        migrationsSchema: 'drizzle',
        migrationsTable: sequence.journalTable,
      });
    }
  } finally {
    await client.end();
  }
}

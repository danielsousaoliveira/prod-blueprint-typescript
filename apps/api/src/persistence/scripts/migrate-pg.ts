import 'dotenv/config';
import { z } from 'zod';
import { runPgMigrations } from '../pg/migrator';

/**
 * `npm run db:migrate:pg`
 *
 * The Postgres deploy step. Runs before the new application version serves traffic and
 * separately from it, using the migration (owner) connection — never the runtime one.
 * Exits non-zero on failure so a deploy pipeline halts rather than rolling out code
 * against a schema that was never migrated.
 *
 * Parses only the one variable it needs rather than the whole application env: a
 * migration job has no business failing because the notification provider URL is unset.
 */
async function main(): Promise<void> {
  const { POSTGRES_MIGRATION_URL } = z
    .object({ POSTGRES_MIGRATION_URL: z.string().url() })
    .parse(process.env);

  await runPgMigrations(POSTGRES_MIGRATION_URL, undefined, (message) =>
    console.log(message),
  );
  console.log('Postgres migrations up to date.');
}

main().catch((error: unknown) => {
  console.error('Postgres migration failed:', error);
  process.exitCode = 1;
});

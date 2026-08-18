import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { loadEnv } from '../../config/env';
import { runMigrations } from '../migrations';

/**
 * `npm run db:migrate`
 *
 * The deploy step. Runs before the new application version starts serving, and
 * separately from it — see the note in `migrations/index.ts` for why boot-time index
 * creation is the wrong shape.
 *
 * Exits non-zero on failure so a deploy pipeline halts rather than rolling out code
 * against a schema that was never migrated.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const client = new MongoClient(env.MONGO_URL);
  await client.connect();

  try {
    const applied = await runMigrations(client.db(env.MONGO_DB_NAME), (message) =>
      console.log(message),
    );

    console.log(
      applied.length === 0
        ? 'No pending migrations — database is up to date.'
        : `Applied ${applied.length} migration(s): ${applied.join(', ')}`,
    );
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error('Migration failed:', error);
  process.exitCode = 1;
});

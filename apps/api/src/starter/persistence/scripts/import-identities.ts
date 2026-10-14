import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { Client } from 'pg';
import { z } from 'zod';
import { normaliseEmail } from '../../modules/auth/domain/user.repository';

const legacyUser = z.object({
  _id: z.string(),
  email: z.string().email(),
  passwordHash: z.string(),
  role: z.enum(['doctor', 'patient']),
  profileId: z.string(),
  createdAt: z.number(),
});

/** One-time cutover: copy hashes verbatim, keep session identity ids, never overwrite. */
async function main(): Promise<void> {
  const env = z
    .object({
      MONGO_URL: z.string().url(),
      MONGO_DB_NAME: z.string(),
      POSTGRES_MIGRATION_URL: z.string().url(),
    })
    .parse(process.env);
  const mongo = new MongoClient(env.MONGO_URL);
  const postgres = new Client({ connectionString: env.POSTGRES_MIGRATION_URL });
  try {
    await mongo.connect();
    await postgres.connect();
    await postgres.query('BEGIN');
    try {
      let count = 0;
      for await (const document of mongo
        .db(env.MONGO_DB_NAME)
        .collection('users')
        .find()) {
        const user = legacyUser.parse(document);
        const email = normaliseEmail(user.email);
        // A retry succeeds only when the exact account was already imported. A
        // collision must stop cutover rather than silently change someone's password.
        const result = await postgres.query(
          `INSERT INTO app.identities (id, email, password_hash, role, profile_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
           WHERE identities.email = EXCLUDED.email
             AND identities.password_hash = EXCLUDED.password_hash
             AND identities.role = EXCLUDED.role
             AND identities.profile_id = EXCLUDED.profile_id
             AND identities.created_at = EXCLUDED.created_at`,
          [
            user._id,
            email,
            user.passwordHash,
            user.role,
            user.profileId,
            new Date(user.createdAt),
          ],
        );
        if (result.rowCount !== 1)
          throw new Error('Identity import conflicts with an existing account');
        count++;
      }
      await postgres.query('COMMIT');
      console.log(`Imported ${count} identity records.`);
    } catch (error) {
      await postgres.query('ROLLBACK');
      throw error;
    }
  } finally {
    await postgres.end();
    await mongo.close();
  }
}

main().catch((error: unknown) => {
  // Validation errors can include input values; never print legacy credential records.
  console.error(
    'Identity import failed:',
    error instanceof z.ZodError
      ? 'Invalid legacy account'
      : error instanceof Error
        ? error.message
        : 'Unknown import failure',
  );
  process.exitCode = 1;
});

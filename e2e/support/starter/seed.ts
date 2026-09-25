import { MongoClient } from 'mongodb';
import { hashPassword } from '../../../apps/api/src/starter/modules/auth/domain/password';

/**
 * Generic account seeding shared by every e2e project.
 *
 * This is the foundation layer: it knows about `users` and nothing about doctors,
 * patients, or appointments. The demonstration project's seeding composes on top of this
 * rather than duplicating the password-hashing and user-document logic — a foundation-only
 * test never needs to import anything from `support/demonstration`.
 */

export const MONGO_URL =
  process.env.E2E_MONGO_URL ??
  'mongodb://localhost:27017/?replicaSet=rs0&directConnection=true';
export const DB_NAME = process.env.E2E_MONGO_DB ?? 'scheduler_e2e';

/**
 * The password every seeded account shares.
 *
 * A constant, because these are throwaway accounts in a throwaway database and varying it
 * per test would buy nothing except slower runs — argon2 is deliberately expensive, and
 * each unique password is one more hash to compute at seed time.
 */
export const E2E_PASSWORD = 'e2e-password-123';

export interface SeededUser {
  readonly userId: string;
  readonly email: string;
  readonly password: string;
}

/**
 * A unique suffix for one test's fixtures, so tests can run in parallel without their
 * data colliding — see the note in `support/demonstration/seed.ts` for the full argument.
 */
export function uniqueSuffix(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Seeds a single user account, directly in MongoDB, hashed the same way the application
 * hashes passwords.
 *
 * Seeded directly rather than through the registration endpoint — that endpoint does not
 * exist yet (see DAN-91), and setup should not depend on the endpoints under test even
 * once it does. The hash is produced by importing the APPLICATION's `hashPassword` so
 * there is one definition of the password format, not two that can drift apart.
 */
/**
 * `role` must be `'doctor'` or `'patient'` — the only two the session store recognises
 * (`apps/api/src/starter/modules/auth/application/session.store.ts`). Anything else signs
 * in successfully but is treated as an invalid session on the very next request.
 */
export async function seedUser(
  role: 'doctor' | 'patient',
  suffix: string,
  profileId?: string,
): Promise<SeededUser> {
  const client = new MongoClient(MONGO_URL);
  await client.connect();

  try {
    const userId = `user-${role}-${suffix}`;
    const email = `${role}-${suffix}@e2e.test`;
    const passwordHash = await hashPassword(E2E_PASSWORD);

    await client
      .db(DB_NAME)
      .collection('users')
      .replaceOne(
        { _id: userId as never },
        {
          email,
          passwordHash,
          role,
          profileId: profileId ?? userId,
          createdAt: Date.now(),
        },
        { upsert: true },
      );

    return { userId, email, password: E2E_PASSWORD };
  } finally {
    await client.close();
  }
}

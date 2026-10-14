import type { User } from './user';

/**
 * The port. Postgres and in-memory adapters implement the same interface; authentication
 * services never depend on either storage mechanism.
 */
export interface UserRepository {
  /**
   * Look a user up by email.
   *
   * Callers pass whatever the user typed; normalising to lowercase is the adapter's job,
   * not the caller's. Leaving it to callers means one forgotten `.toLowerCase()` creates
   * an account that can never log in, or — worse — a second account for an address that
   * already exists, which the unique index would then reject in a way that surfaces as a
   * confusing 500 during signup.
   */
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  save(user: User): Promise<void>;
}

export const USER_REPOSITORY = Symbol('USER_REPOSITORY');

/** Normalisation lives here so all repository adapters use one definition. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

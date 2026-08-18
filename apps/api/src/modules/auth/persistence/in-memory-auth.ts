import type { SessionStore } from '../application/session.store';
import type { Session } from '../domain/session';
import type { User } from '../domain/user';
import { normaliseEmail, type UserRepository } from '../domain/user.repository';

/**
 * In-memory adapters for the auth ports.
 *
 * Same arrangement as `InMemoryAppointmentRepository`: the port has two implementations,
 * and swapping them is a one-line DI change with no edit to the code under test. That is
 * what lets the HTTP integration suite exercise the REAL `AuthGuard` and the REAL
 * `AuthService` — including the timing-equalised login path and every authorization rule
 * — against one MongoDB container and no Redis at all.
 *
 * The alternative would have been stubbing the guard in tests. That is the version that
 * passes while production is wide open, because the thing most likely to be wrong is the
 * guard itself.
 */
export class InMemoryUserRepository implements UserRepository {
  private readonly byId = new Map<string, User>();

  findByEmail(email: string): Promise<User | null> {
    const target = normaliseEmail(email);
    for (const user of this.byId.values()) {
      // Normalising BOTH sides, exactly as the Mongo adapter does. A test double that
      // skipped this would pass while production failed for anyone who typed a capital
      // letter — the classic way an in-memory adapter lies.
      if (normaliseEmail(user.email) === target) return Promise.resolve(user);
    }
    return Promise.resolve(null);
  }

  findById(id: string): Promise<User | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }

  save(user: User): Promise<void> {
    this.byId.set(user.id, { ...user, email: normaliseEmail(user.email) });
    return Promise.resolve();
  }

  clear(): void {
    this.byId.clear();
  }
}

/**
 * Sessions in a Map, with the same key-hashing and expiry semantics as the Redis store.
 *
 * `expiresAt` is tracked explicitly rather than relying on a timer, so a test can assert
 * expiry by advancing a clock rather than by sleeping.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, { session: Session; expiresAt: number }>();

  constructor(
    private readonly ttlSeconds = 3600,
    private now: () => number = () => Date.now(),
  ) {}

  create(sessionId: string, session: Session): Promise<void> {
    this.sessions.set(sessionId, {
      session,
      expiresAt: this.now() + this.ttlSeconds * 1000,
    });
    return Promise.resolve();
  }

  resolve(sessionId: string): Promise<Session | null> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return Promise.resolve(null);

    if (entry.expiresAt <= this.now()) {
      this.sessions.delete(sessionId);
      return Promise.resolve(null);
    }

    // Sliding expiry, matching RedisSessionStore.
    entry.expiresAt = this.now() + this.ttlSeconds * 1000;
    return Promise.resolve(entry.session);
  }

  destroy(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    return Promise.resolve();
  }

  /** Test hook: force a session to look expired without waiting for real time. */
  expire(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.expiresAt = this.now() - 1;
  }

  clear(): void {
    this.sessions.clear();
  }
}

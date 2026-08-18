import { APP_GUARD, Reflector } from '@nestjs/core';
import type { Provider } from '@nestjs/common';
import type { RedisService } from '../src/infra/redis.service';
import { ENV, type Env } from '../src/config/env';
import { AuthService } from '../src/modules/auth/application/auth.service';
import { LoginRateLimiter } from '../src/modules/auth/application/login-rate-limiter';
import { SESSION_STORE } from '../src/modules/auth/application/session.store';
import { AuthGuard } from '../src/modules/auth/auth.guard';
import { hashPassword } from '../src/modules/auth/domain/password';
import type { Role } from '../src/modules/auth/domain/user';
import { USER_REPOSITORY } from '../src/modules/auth/domain/user.repository';
import {
  InMemorySessionStore,
  InMemoryUserRepository,
} from '../src/modules/auth/persistence/in-memory-auth';

export const TEST_COOKIE_NAME = 'sid';
export const TEST_PASSWORD = 'test-password-123';

/**
 * Auth wiring for integration suites.
 *
 * The guard registered here is the REAL `AuthGuard`, bound the same way production binds
 * it (`APP_GUARD`), so these suites test the actual authentication path rather than a
 * stub. Only the two ports — users and sessions — are swapped for in-memory adapters, and
 * both mirror the real ones' semantics (see in-memory-auth.ts).
 *
 * Registering a *fake* guard that always allows would make every authorization test in
 * the codebase meaningless while looking identical from the outside. That is the specific
 * failure this harness exists to avoid.
 */
export interface AuthHarness {
  readonly providers: Provider[];
  readonly users: InMemoryUserRepository;
  readonly sessions: InMemorySessionStore;
  /** Create a user and return a ready-to-use cookie header value. */
  signIn(id: string, role: Role, profileId: string): Promise<string>;
  /** Create a user without signing in. */
  createUser(id: string, email: string, role: Role, profileId: string): Promise<void>;
}

export function createAuthHarness(env?: Partial<Env>): AuthHarness {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionStore();

  const testEnv = {
    NODE_ENV: 'test',
    SESSION_COOKIE_NAME: TEST_COOKIE_NAME,
    SESSION_COOKIE_SECURE: false,
    SESSION_TTL_SECONDS: 3600,
    AUTH_MAX_ATTEMPTS_PER_EMAIL: 5,
    AUTH_MAX_ATTEMPTS_PER_IP: 30,
    AUTH_ATTEMPT_WINDOW_SECONDS: 900,
    ALLOWED_ORIGINS: ['http://localhost:5173'],
    ...env,
  } as Env;

  /**
   * A Redis stub for the rate limiter only.
   *
   * Counters live in a Map. The rate limiter's own behaviour has a dedicated suite; here
   * it must simply not reject anything, because a test that trips a shared counter would
   * fail its neighbours in a way that looks like a flaky authorization bug.
   */
  const counters = new Map<string, number>();
  const redisStub = {
    client: {
      get: (key: string) => Promise.resolve(String(counters.get(key) ?? 0)),
      del: (...keys: string[]) => {
        for (const key of keys) counters.delete(key);
        return Promise.resolve(keys.length);
      },
      multi: () => {
        const ops: (() => void)[] = [];
        const chain = {
          incr: (key: string) => {
            ops.push(() => counters.set(key, (counters.get(key) ?? 0) + 1));
            return chain;
          },
          expire: () => chain,
          exec: () => {
            for (const op of ops) op();
            return Promise.resolve([]);
          },
        };
        return chain;
      },
    },
  } as unknown as RedisService;

  const rateLimiter = new LoginRateLimiter(redisStub, testEnv);
  const authService = new AuthService(users, sessions, rateLimiter);

  const providers: Provider[] = [
    { provide: ENV, useValue: testEnv },
    { provide: USER_REPOSITORY, useValue: users },
    { provide: SESSION_STORE, useValue: sessions },
    { provide: LoginRateLimiter, useValue: rateLimiter },
    { provide: AuthService, useValue: authService },
    {
      provide: APP_GUARD,
      inject: [Reflector],
      useFactory: (reflector: Reflector) =>
        new AuthGuard(reflector, authService, TEST_COOKIE_NAME),
    },
  ];

  return {
    providers,
    users,
    sessions,

    async createUser(id, email, role, profileId) {
      await users.save({
        id,
        email,
        passwordHash: await hashPassword(TEST_PASSWORD),
        role,
        profileId,
        createdAt: Date.now(),
      });
    },

    async signIn(id, role, profileId) {
      await this.createUser(id, `${id}@test.local`, role, profileId);

      // Through the real login path, so the cookie a test carries is one the production
      // code actually issued — not a hand-made session id inserted into the store.
      const result = await authService.login(
        `${id}@test.local`,
        TEST_PASSWORD,
        '1.2.3.4',
      );
      if (!result.ok) throw new Error(`Test sign-in failed: ${result.reason}`);

      return `${TEST_COOKIE_NAME}=${result.sessionId}`;
    },
  };
}

import { z } from 'zod';

/**
 * Environment configuration, validated at boot.
 *
 * The pattern here is "parse, don't validate": the raw `process.env` (all strings,
 * everything possibly undefined) is parsed exactly once into a typed object, and the
 * rest of the application only ever sees the typed result. Nothing downstream reads
 * `process.env` directly, so there is no second place where a missing variable can
 * surface as `undefined` three hours into a deployment.
 *
 * It fails fast and loudly. A service that boots successfully with a bad database URL
 * and only discovers it on the first request is strictly worse than one that refuses
 * to start — the second is a failed deploy, the first is an incident.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  MONGO_URL: z.string().url(),
  MONGO_DB_NAME: z.string().min(1).default('tenantforge'),

  REDIS_URL: z.string().url(),

  /** External notification provider. Mocked at the network boundary in tests (Phase 8). */
  NOTIFICATION_PROVIDER_URL: z.string().url().default('https://notifications.example'),
  NOTIFICATION_API_KEY: z.string().default('dev-key'),

  /**
   * How long the process is given to drain in-flight requests on SIGTERM before it
   * exits anyway. Cloud Run sends SIGTERM and then hard-kills after 10s, so this must
   * stay comfortably below that.
   */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),

  /**
   * Session lifetime, and how long inactivity is tolerated — the store slides this on
   * every authenticated request, so it is an idle timeout rather than an absolute one.
   * See the trade-off discussed in `session.store.ts`.
   */
  SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24 * 7),
  SESSION_COOKIE_NAME: z.string().min(1).default('sid'),

  /**
   * Whether to mark the session cookie `Secure`.
   *
   * ============================================================================
   * WHY THIS IS A SEPARATE FLAG RATHER THAN `NODE_ENV === 'production'`
   * ============================================================================
   *
   * It was derived from NODE_ENV, which is right almost always: production is HTTPS,
   * development is not, and a `Secure` cookie over plain HTTP is silently discarded by
   * the browser — login returns 200 and every subsequent request is 401, with no error
   * anywhere explaining why.
   *
   * The e2e suite broke that assumption. It runs the API with `NODE_ENV=production` on
   * purpose, so the PRODUCTION code paths are the ones under test, but serves it over
   * http://localhost. Derived from NODE_ENV, the cookie was marked `Secure`, Chromium
   * dropped it, and every authenticated e2e test failed with a 401 while the API was
   * behaving exactly as designed.
   *
   * So the flag is explicit, and it DEFAULTS to secure — the safe direction. An
   * environment that needs it off has to say so, which is one line in the Playwright
   * config with a comment next to it, rather than an invariant nobody notices is wrong.
   * Defaulting the other way would mean a production deployment that forgot to set it
   * ships sessions over cleartext.
   * ============================================================================
   */
  SESSION_COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  /**
   * Login brute-force limits. Two counters, because email-only enables lockout attacks
   * and IP-only misses password spraying (see `login-rate-limiter.ts`). The per-IP limit
   * is deliberately looser: offices and mobile carriers share addresses, so a tight one
   * would lock out real users.
   */
  AUTH_MAX_ATTEMPTS_PER_EMAIL: z.coerce.number().int().positive().default(5),
  AUTH_MAX_ATTEMPTS_PER_IP: z.coerce.number().int().positive().default(30),
  AUTH_ATTEMPT_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),

  /**
   * Origins permitted to make state-changing requests. The CSRF defence-in-depth check
   * (`csrf.middleware.ts`) rejects a POST whose `Origin` is present and not on this list.
   *
   * Comma-separated. The default covers the Vite dev server; production sets it to the
   * real origin. Deliberately NOT defaulting to "allow anything" — a permissive default
   * is a security control that is off until someone remembers to turn it on.
   */
  ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://localhost:3000')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),

  /**
   * Seeds demo accounts in migration 005. Refused in production by the migration itself
   * — a known-password account is a backdoor, and "it is only for the demo" is exactly
   * how one reaches production.
   */
  SEED_DEMO_PASSWORD: z.string().min(8).default('demo-password-123'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return result.data;
}

/** DI token. Injected rather than imported so tests can supply their own config. */
export const ENV = Symbol('ENV');

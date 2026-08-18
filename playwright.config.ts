import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * `webServer` starts BOTH the API and the Vite dev server, and Playwright waits for each
 * to answer before running anything. Starting them by hand in CI is the usual source of
 * flake — a test that begins before the API is listening fails in a way that looks like a
 * product bug rather than a race in the harness.
 */
export default defineConfig({
  testDir: './e2e',
  // A real timeout rather than the 30s default: the first test pays for Nest booting and
  // Vite's first transform.
  timeout: 60_000,
  expect: { timeout: 10_000 },

  // Serial locally for readable output; parallel in CI where wall time matters. Safe in
  // both because every test creates its OWN doctor — see the note in the spec file.
  fullyParallel: !!process.env.CI,
  workers: process.env.CI ? 2 : 1,

  // `forbidOnly` stops a stray `test.only` silently reducing CI to one test — a green run
  // that verified almost nothing.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,

  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: 'http://localhost:5173',
    // Artefacts only for failures — traces are large, and keeping them for passing tests
    // makes the useful ones hard to find.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        /**
         * A FIXED timezone for every run.
         *
         * Without this the suite passes on a laptop in Europe/Lisbon and fails in CI
         * (UTC), because the rendered times differ. Pinning it to a zone that is NOT the
         * clinic's is deliberate: it means the cross-timezone rendering path is what runs
         * in every e2e test, rather than the trivial same-zone case.
         */
        timezoneId: 'America/New_York',
        locale: 'en-GB',
      },
    },
  ],

  webServer: [
    {
      command: 'npm run start --workspace=apps/api',
      port: 3000,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
        MONGO_URL: 'mongodb://localhost:27017/?replicaSet=rs0&directConnection=true',
        MONGO_DB_NAME: 'scheduler_e2e',
        REDIS_URL: 'redis://localhost:6379',
        // Turns on MSW inside the API process AND registers the test-support route.
        // Explicit rather than keyed on NODE_ENV, which is 'production' here on purpose so
        // the production code paths are the ones under test.
        MOCK_NOTIFICATIONS: '1',
        // The suite serves the API over http://localhost while running the PRODUCTION
        // code paths. A Secure cookie would be silently dropped by Chromium, and every
        // authenticated test would fail with a 401 while the API behaved correctly.
        // See the note on SESSION_COOKIE_SECURE in apps/api/src/config/env.ts.
        SESSION_COOKIE_SECURE: 'false',
        SEED_DEMO_PASSWORD: 'e2e-password-123',
        NOTIFICATION_PROVIDER_URL: 'https://notifications.example',
        NOTIFICATION_API_KEY: 'e2e-key',
        LOG_LEVEL: 'warn',
      },
    },
    {
      command: 'npm run dev --workspace=apps/web',
      port: 5173,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});

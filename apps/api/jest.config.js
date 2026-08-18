/**
 * NOTE ON TYPE CHECKING: with `isolatedModules: true` (required for the node16 module
 * kind) ts-jest transpiles without type checking. Tests are therefore type-checked by
 * `npm run typecheck`, which runs tsc over BOTH tsconfig.json (app) and
 * tsconfig.spec.json (tests) — not by Jest.
 *
 * That split is deliberate and faster, but it means a type error in a test surfaces in
 * the typecheck job rather than the test job. It also means the `@ts-expect-error`
 * assertions in *.types.spec.ts are enforced by tsc; they prove nothing under Jest alone.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  testEnvironment: 'node',
  rootDir: 'src',
  // Unit tests only: everything ending `.spec.ts` EXCEPT `.integration.spec.ts`.
  // Integration tests start Docker containers and take tens of seconds, so they must not
  // sit in the fast feedback loop — `npm test` has to stay quick enough to run on save.
  // `npm run test:integration` uses jest.integration.config.js.
  testRegex: '.*(?<!\\.integration)\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.spec.json' }],
  },
  // Coverage is measured over the PURE DOMAIN only: the interval algebra, the timezone
  // expansion, the state machine and the availability engine. Those have no I/O and no
  // excuse for being untested.
  //
  // Infrastructure (config, infra, health) is deliberately excluded rather than counted
  // at 0%. Its correctness is not something unit tests can establish — "does the health
  // endpoint really return 503 when Mongo dies" is an integration question, and Phase 3
  // covers it with Testcontainers. Including it here would either drag the threshold
  // down to a number that permits untested domain logic, or invite mock-heavy tests that
  // assert the mocks rather than the behaviour.
  collectCoverageFrom: ['shared/**/*.ts', 'modules/**/domain/**/*.ts', '!**/*.spec.ts'],
  // A ratchet, not a target: it exists to make a regression fail the build.
  coverageThreshold: {
    global: { statements: 95, branches: 85, functions: 90, lines: 95 },
  },
};

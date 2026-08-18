/**
 * Integration tests: real MongoDB (and later Redis) via Testcontainers.
 *
 * Split from the unit config because these are a different kind of test with different
 * economics — seconds rather than milliseconds, and a Docker daemon required. Keeping
 * them out of `npm test` is what keeps the fast loop fast; running them in their own CI
 * job is what keeps them from being skipped.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.integration\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.spec.json' }],
  },
  // Each file starts its own container, so running files in parallel would start several
  // MongoDB instances at once. Serial is slower but far more predictable, and there are
  // few enough files for it not to matter.
  maxWorkers: 1,
  testTimeout: 180_000,
};

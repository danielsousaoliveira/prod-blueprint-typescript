// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'],
  },
  js.configs.recommended,

  // Type-aware linting. Slower than the syntactic rules, but it is what catches
  // floating promises and unsafe `any` flow — the two classes of bug that actually
  // reach production in a Node service.
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Explicit project list rather than `projectService: true`. The service resolves
        // a file to the NEAREST tsconfig.json, and spec files are deliberately excluded
        // from the build config — so they would resolve to a project that does not
        // contain them and fail to parse. Listing both projects covers app and test code.
        project: [
          './apps/api/tsconfig.json',
          './apps/api/tsconfig.spec.json',
          './apps/web/tsconfig.json',
          './e2e/tsconfig.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // ARCHITECTURAL BOUNDARY, enforced by the linter rather than by code review.
  //
  // The domain and application layers must not depend on HTTP or on the database
  // driver. That constraint is what lets one service layer back both REST and GraphQL,
  // and what lets services be unit-tested with no framework and no database.
  //
  // A convention that relies on someone noticing in review is a convention that erodes
  // the first time a deadline arrives — one `import type { Request } from 'express'`
  // for convenience, and the layering is gone. This makes it a build failure.
  // ---------------------------------------------------------------------------
  {
    files: ['**/src/modules/**/domain/**/*.ts', '**/src/modules/**/application/**/*.ts'],
    ignores: ['**/*.spec.ts', '**/*.contract.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'express',
              message:
                'The domain and application layers must not know about HTTP. Keep Request/Response in the api/ layer.',
            },
            {
              name: 'mongodb',
              message:
                'The domain and application layers must not import the MongoDB driver. Depend on the repository port instead; the adapter lives in persistence/.',
            },
            {
              name: 'ioredis',
              message:
                'Depend on the DistributedLock or IdempotencyStore port, not on Redis directly.',
            },
          ],
          patterns: [
            {
              group: ['**/persistence/*', '!**/persistence/*.contract'],
              message:
                'Depend on the repository INTERFACE in domain/, not on a concrete adapter in persistence/.',
            },
          ],
        },
      ],
    },
  },

  // Test files: relax the `any`-propagation rules only.
  //
  // Supertest types `response.body` as `any` by design — it cannot know the shape of an
  // arbitrary HTTP response. The alternatives are worse than the relaxation: casting
  // every assertion adds ceremony that obscures what is being asserted, and declaring a
  // response interface per endpoint duplicates the DTO types the tests exist to verify.
  //
  // Scoped to `*.spec.ts` and to these four rules specifically — everything else,
  // including the architectural import boundaries above, still applies to tests.
  {
    files: ['**/*.spec.ts', '**/*.contract.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },

  // React workspace.
  //
  // The hooks rules are not style preferences — `rules-of-hooks` catches conditional hook
  // calls, which corrupt React's internal hook ordering and produce bugs that look like
  // state randomly belonging to the wrong component. `exhaustive-deps` catches stale
  // closures in effects, the other classic React bug that no type system sees.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // Config files are plain JS and are not part of any tsconfig project.
  {
    files: ['**/*.mjs', '**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  // CommonJS config files (jest.config.js) use `module.exports`, so they need Node's
  // CJS globals — which the default browser-ish globals do not include.
  {
    files: ['**/*.config.js', '**/.*rc.js'],
    languageOptions: {
      globals: { module: 'writable', require: 'readonly', __dirname: 'readonly' },
    },
  },

  // Must come last: turns off every stylistic rule that would fight Prettier.
  prettier,
);

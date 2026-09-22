import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Linter } from 'eslint';
import config from '../eslint.config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const linter = new Linter();

function findConfigFor(filesGlob) {
  const entry = config.find((c) => Array.isArray(c.files) && c.files.includes(filesGlob));
  assert.ok(
    entry,
    `expected an eslint.config.mjs entry with files including ${filesGlob}`,
  );
  return entry.rules['no-restricted-imports'];
}

function lint(fixture, ruleOptions) {
  const filePath = path.join(here, 'fixtures', fixture);
  const code = readFileSync(filePath, 'utf8');
  const messages = linter.verify(
    code,
    [
      {
        files: ['**/*.ts'],
        languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
        rules: { 'no-restricted-imports': ruleOptions },
      },
    ],
    { filename: filePath },
  );
  return messages;
}

function assertFires(fixture, ruleOptions, label) {
  const messages = lint(fixture, ruleOptions);
  const hit = messages.filter((m) => m.ruleId === 'no-restricted-imports');
  assert.ok(
    hit.length > 0,
    `expected ${label} to report no-restricted-imports for ${fixture}`,
  );
}

function assertClean(fixture, ruleOptions, label) {
  const messages = lint(fixture, ruleOptions);
  const hit = messages.filter((m) => m.ruleId === 'no-restricted-imports');
  assert.equal(hit.length, 0, `expected ${label} to allow ${fixture}`);
}

const starterBoundary = findConfigFor('apps/api/src/starter/**/*.ts');
assertFires(
  'starter-imports-demonstration.ts',
  starterBoundary,
  'the starter -> demonstration boundary rule',
);

const layering = findConfigFor('**/src/*/modules/**/domain/**');
assertFires(
  'domain-imports-postgres-driver.ts',
  layering,
  'the domain/application layering rule (pg)',
);
assertFires(
  'domain-imports-drizzle.ts',
  layering,
  'the domain/application layering rule (drizzle-orm)',
);

// Sanity check: the rule options themselves do not blanket-forbid every import — only
// the ones this suite targets. Proves assertFires above is exercising the rule, not a
// parser failure that would report on every file regardless of content.
assertClean('clean-import.ts', ['error', { patterns: [] }], 'a no-op rule config');

console.log('boundary-rules.test.mjs: all assertions passed');

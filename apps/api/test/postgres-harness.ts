import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { runPgMigrations } from '../src/persistence/pg/migrator';

/**
 * A real Postgres, started in a container for the duration of a test file.
 *
 * It provisions the SAME three roles the deployment and local infrastructure use — by
 * running deploy/postgres/init/01-roles.sql, not a test-only copy — then applies the
 * real migration sequence as the owner role. A test that ran against roles invented in
 * the harness would prove something the deployment does not do.
 *
 * Testcontainers picks a random host port, so parallel files cannot collide with each
 * other or with local infrastructure.
 */
const ROLES_SQL = join(
  __dirname,
  '..',
  '..',
  '..',
  'deploy',
  'postgres',
  'init',
  '01-roles.sql',
);

export type PgRole = 'owner' | 'app' | 'crosstenant';

export interface PostgresHarness {
  readonly url: Record<PgRole, string>;
  /** A lazily created pool for the given role; reused across calls. */
  pool(role: PgRole): Pool;
  stop(): Promise<void>;
}

export async function startPostgresHarness(): Promise<PostgresHarness> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:16',
  )
    .withDatabase('tenantforge')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();

  const admin = new Pool({ connectionString: container.getConnectionUri() });
  try {
    await admin.query(readFileSync(ROLES_SQL, 'utf8'));
  } finally {
    await admin.end();
  }

  const host = container.getHost();
  const port = container.getPort();
  const connString = (role: string, password: string): string =>
    `postgres://${role}:${password}@${host}:${port}/tenantforge`;

  const url: Record<PgRole, string> = {
    owner: connString('tenantforge_owner', 'owner'),
    app: connString('tenantforge_app', 'app'),
    crosstenant: connString('tenantforge_crosstenant', 'crosstenant'),
  };

  await runPgMigrations(url.owner);

  const pools = new Map<PgRole, Pool>();

  return {
    url,

    pool(role) {
      const existing = pools.get(role);
      if (existing) return existing;
      const created = new Pool({ connectionString: url[role] });
      pools.set(role, created);
      return created;
    },

    async stop() {
      await Promise.all([...pools.values()].map((pool) => pool.end()));
      await container.stop();
    },
  };
}

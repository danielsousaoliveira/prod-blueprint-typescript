import type { Env } from '../../config/env';
import { PostgresService } from '../postgres.service';
import {
  startPostgresHarness,
  type PostgresHarness,
} from '../../../../test/postgres-harness';
import { PrivilegedDatabase } from './privileged-database';
import {
  NoTenantTransactionError,
  TenantDb,
  TenantTransactionRunner,
} from './tenant-transaction';

jest.setTimeout(180_000);

let harness: PostgresHarness;
let postgres: PostgresService;
let runner: TenantTransactionRunner;
let db: TenantDb;
let acme: string;
let globex: string;

beforeAll(async () => {
  harness = await startPostgresHarness();
  postgres = new PostgresService({
    POSTGRES_URL: harness.url.app,
    POSTGRES_POOL_MAX: 1,
  } as Env);
  runner = new TenantTransactionRunner(postgres);
  db = new TenantDb();

  const owner = harness.pool('owner');
  const orgs = await owner.query<{ id: string; slug: string }>(
    "INSERT INTO app.organisations (slug, name) VALUES ('acme', 'Acme'), ('globex', 'Globex') RETURNING id, slug",
  );
  acme = orgs.rows.find((row) => row.slug === 'acme')!.id;
  globex = orgs.rows.find((row) => row.slug === 'globex')!.id;
  await owner.query(
    `INSERT INTO app.people (organisation_id, email, display_name)
     VALUES ($1, 'a@example.test', 'A'), ($2, 'g@example.test', 'G')`,
    [acme, globex],
  );
});

afterAll(async () => {
  await postgres?.onApplicationShutdown();
  await harness?.stop();
});

describe('TenantTransactionRunner against a real database', () => {
  it('shows a repository only the organisation of its transaction', async () => {
    const emails = await runner.run(acme, async () => {
      const { rows } = await db.query<{ email: string }>('SELECT email FROM app.people');
      return rows.map((row) => row.email);
    });

    expect(emails).toEqual(['a@example.test']);
  });

  it('commits work done inside the transaction', async () => {
    await runner.run(acme, () =>
      db.query(
        "INSERT INTO app.people (organisation_id, email, display_name) VALUES ($1, 'new@example.test', 'N')",
        [acme],
      ),
    );

    const { rows } = await harness
      .pool('owner')
      .query("SELECT 1 FROM app.people WHERE email = 'new@example.test'");
    expect(rows).toHaveLength(1);
  });

  it('rolls back work when the handler throws', async () => {
    await expect(
      runner.run(acme, async () => {
        await db.query(
          "INSERT INTO app.people (organisation_id, email, display_name) VALUES ($1, 'gone@example.test', 'G')",
          [acme],
        );
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');

    const { rows } = await harness
      .pool('owner')
      .query("SELECT 1 FROM app.people WHERE email = 'gone@example.test'");
    expect(rows).toHaveLength(0);
  });

  it('refuses a write naming another organisation', async () => {
    await expect(
      runner.run(acme, () =>
        db.query(
          "INSERT INTO app.people (organisation_id, email, display_name) VALUES ($1, 'x@example.test', 'X')",
          [globex],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('does not carry the context to the next borrower of the same connection', async () => {
    await runner.run(acme, () => db.query('SELECT 1'));

    const client = await postgres.connect();
    try {
      const { rows } = await client.query<{ value: string | null }>(
        "SELECT current_setting('app.current_organisation', true) AS value",
      );
      expect(rows[0]?.value ?? '').toBe('');
      await expect(client.query('SELECT * FROM app.people')).rejects.toMatchObject({
        code: 'TF001',
      });
    } finally {
      client.release();
    }
  });

  it('runs concurrent transactions for different organisations without mixing them', async () => {
    const seen = await Promise.all(
      [acme, globex, acme, globex].map((organisation) =>
        runner.run(organisation, async () => {
          const { rows } = await db.query<{ organisation_id: string }>(
            'SELECT DISTINCT organisation_id FROM app.people',
          );
          return rows.map((row) => row.organisation_id);
        }),
      ),
    );

    expect(seen).toEqual([[acme], [globex], [acme], [globex]]);
  });

  it('throws from the handle once the transaction has finished', async () => {
    await runner.run(acme, () => Promise.resolve());

    expect(() => db.query('SELECT 1')).toThrow(NoTenantTransactionError);
  });
});

describe('PrivilegedDatabase', () => {
  it('sees rows across organisations', async () => {
    const privileged = new PrivilegedDatabase({
      POSTGRES_CROSS_TENANT_URL: harness.url.crosstenant,
    } as Env);

    try {
      const { rows } = await privileged.query<{ n: string }>(
        'SELECT count(DISTINCT organisation_id)::text AS n FROM app.people',
      );
      expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(2);
    } finally {
      await privileged.onApplicationShutdown();
    }
  });

  it('refuses to be used when no cross-tenant connection is configured', async () => {
    const privileged = new PrivilegedDatabase({} as Env);

    await expect(privileged.query('SELECT 1')).rejects.toThrow(
      /POSTGRES_CROSS_TENANT_URL/,
    );
  });
});

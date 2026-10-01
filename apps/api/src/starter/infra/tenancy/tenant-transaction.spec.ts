import type { PoolClient } from 'pg';
import type { PostgresService } from '../postgres.service';
import {
  InvalidOrganisationIdError,
  NestedTenantTransactionError,
  NoTenantTransactionError,
  TenantDb,
  TenantTransactionRunner,
} from './tenant-transaction';

const ACME = '11111111-1111-4111-8111-111111111111';
const GLOBEX = '22222222-2222-4222-8222-222222222222';

interface FakeClient {
  readonly statements: { text: string; values?: unknown[] }[];
  readonly released: (boolean | undefined)[];
  failOn?: string;
}

const setup = (): {
  runner: TenantTransactionRunner;
  db: TenantDb;
  client: FakeClient;
} => {
  const client: FakeClient = { statements: [], released: [] };
  const pgClient = {
    query: (text: string, values?: unknown[]) => {
      client.statements.push({ text, ...(values ? { values } : {}) });
      if (client.failOn === text) return Promise.reject(new Error(`${text} failed`));
      return Promise.resolve({ rows: [] });
    },
    release: (destroy?: boolean) => {
      client.released.push(destroy);
    },
  } as unknown as PoolClient;
  const postgres = {
    connect: () => Promise.resolve(pgClient),
  } as unknown as PostgresService;
  return { runner: new TenantTransactionRunner(postgres), db: new TenantDb(), client };
};

describe('TenantTransactionRunner', () => {
  it('sets the organisation as a bound parameter, transaction-locally, inside BEGIN/COMMIT', async () => {
    const { runner, client } = setup();

    await runner.run(ACME, () => Promise.resolve());

    expect(client.statements.map((s) => s.text)).toEqual([
      'BEGIN',
      'SELECT set_config($1, $2, true)',
      'COMMIT',
    ]);
    expect(client.statements[1]?.values).toEqual(['app.current_organisation', ACME]);
  });

  it('rolls back and releases when the work throws', async () => {
    const { runner, client } = setup();

    await expect(
      runner.run(ACME, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    expect(client.statements.map((s) => s.text)).toEqual([
      'BEGIN',
      'SELECT set_config($1, $2, true)',
      'ROLLBACK',
    ]);
    expect(client.released).toEqual([undefined]);
  });

  it('destroys the connection instead of returning it when rollback fails', async () => {
    const { runner, client } = setup();
    client.failOn = 'ROLLBACK';

    await expect(
      runner.run(ACME, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    expect(client.released).toEqual([true]);
  });

  it.each(['', 'acme', "x'; DROP TABLE app.people; --", '1234'])(
    'refuses %p as an organisation id before touching the database',
    async (value) => {
      const { runner, client } = setup();

      await expect(runner.run(value, () => Promise.resolve())).rejects.toBeInstanceOf(
        InvalidOrganisationIdError,
      );
      expect(client.statements).toEqual([]);
    },
  );

  it('reuses the open transaction for a nested call to the same organisation', async () => {
    const { runner, client } = setup();

    await runner.run(ACME, () => runner.run(ACME, () => Promise.resolve()));

    expect(client.statements.filter((s) => s.text === 'BEGIN')).toHaveLength(1);
  });

  it('refuses a nested call for a different organisation', async () => {
    const { runner } = setup();

    await expect(
      runner.run(ACME, () => runner.run(GLOBEX, () => Promise.resolve())),
    ).rejects.toBeInstanceOf(NestedTenantTransactionError);
  });
});

describe('TenantDb', () => {
  it('throws when used outside a tenant transaction', () => {
    const { db } = setup();

    expect(() => db.query('SELECT 1')).toThrow(NoTenantTransactionError);
    expect(() => db.organisationId).toThrow(NoTenantTransactionError);
  });

  it('runs queries on the transaction client and reports the organisation', async () => {
    const { runner, db, client } = setup();

    await runner.run(ACME, async () => {
      expect(db.organisationId).toBe(ACME);
      await db.query('SELECT $1', [1]);
    });

    expect(client.statements.map((s) => s.text)).toContain('SELECT $1');
  });

  it('throws when a promise outlives its transaction', async () => {
    const { runner, db } = setup();
    let leaked: (() => unknown) | undefined;

    await runner.run(ACME, () => {
      leaked = () => db.query('SELECT 1');
      return Promise.resolve();
    });

    expect(leaked).toBeDefined();
    expect(() => leaked!()).toThrow(NoTenantTransactionError);
  });
});

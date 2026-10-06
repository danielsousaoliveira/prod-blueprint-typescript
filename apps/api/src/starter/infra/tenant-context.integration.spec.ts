import type { Pool, PoolClient } from 'pg';
import {
  startPostgresHarness,
  type PostgresHarness,
} from '../../../test/postgres-harness';

jest.setTimeout(180_000);

const MISSING_CONTEXT = 'TF001';
const MALFORMED_CONTEXT = 'TF002';

let harness: PostgresHarness;
let appPool: Pool;
let acme: string;
let globex: string;

const inTransaction = async <T>(
  work: (client: PoolClient) => Promise<T>,
  organisationId?: string,
): Promise<T> => {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    if (organisationId !== undefined) {
      await client.query("SELECT set_config('app.current_organisation', $1, true)", [
        organisationId,
      ]);
    }
    return await work(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
};

beforeAll(async () => {
  harness = await startPostgresHarness();
  appPool = harness.pool('app');

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

  const people = await owner.query<{ id: string; organisation_id: string }>(
    'SELECT id, organisation_id FROM app.people',
  );
  for (const person of people.rows) {
    await owner.query(
      'INSERT INTO app.memberships (organisation_id, person_id) VALUES ($1, $2)',
      [person.organisation_id, person.id],
    );
    await owner.query(
      `INSERT INTO app.invitations (organisation_id, email, token_hash, expires_at)
       VALUES ($1, 'invitee@example.test', $2, now() + interval '1 day')`,
      [person.organisation_id, `hash-${person.id}`],
    );
  }
});

afterAll(async () => {
  await harness?.stop();
});

describe('app.current_organisation_id()', () => {
  it('returns the organisation set for the transaction', async () => {
    const result = await inTransaction(
      (client) => client.query('SELECT app.current_organisation_id() AS id'),
      acme,
    );

    expect(result.rows[0]).toEqual({ id: acme });
  });

  it('raises a recognisable error when no context has ever been set', async () => {
    await expect(
      inTransaction((client) => client.query('SELECT app.current_organisation_id()')),
    ).rejects.toMatchObject({ code: MISSING_CONTEXT });
  });

  it('raises when the context is the empty string', async () => {
    await expect(
      inTransaction((client) => client.query('SELECT app.current_organisation_id()'), ''),
    ).rejects.toMatchObject({ code: MISSING_CONTEXT });
  });

  it('raises a distinct error when the context is not a uuid', async () => {
    await expect(
      inTransaction(
        (client) => client.query('SELECT app.current_organisation_id()'),
        "not-a-uuid'; DROP TABLE app.people; --",
      ),
    ).rejects.toMatchObject({ code: MALFORMED_CONTEXT });

    const { rows } = await harness
      .pool('owner')
      .query<{ n: string }>('SELECT count(*)::text AS n FROM app.people');
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(2);
  });

  it('is unset again once the transaction that set it has ended', async () => {
    await inTransaction((client) => client.query('SELECT 1'), acme);

    await expect(
      inTransaction((client) => client.query('SELECT app.current_organisation_id()')),
    ).rejects.toMatchObject({ code: MISSING_CONTEXT });
  });
});

describe.each(['people', 'memberships', 'invitations'])(
  'the %s table without a tenant context',
  (table) => {
    it('raises on read', async () => {
      await expect(
        inTransaction((client) => client.query(`SELECT * FROM app.${table}`)),
      ).rejects.toMatchObject({ code: MISSING_CONTEXT });
    });

    it('raises on update', async () => {
      await expect(
        inTransaction((client) =>
          client.query(`UPDATE app.${table} SET created_at = created_at`),
        ),
      ).rejects.toMatchObject({ code: MISSING_CONTEXT });
    });

    it('raises on delete', async () => {
      await expect(
        inTransaction((client) => client.query(`DELETE FROM app.${table}`)),
      ).rejects.toMatchObject({ code: MISSING_CONTEXT });
    });
  },
);

describe('writes without or against the wrong context', () => {
  it('raises on insert with no context', async () => {
    await expect(
      inTransaction((client) =>
        client.query(
          `INSERT INTO app.people (organisation_id, email, display_name)
           VALUES ($1, 'nocontext@example.test', 'N')`,
          [acme],
        ),
      ),
    ).rejects.toMatchObject({ code: MISSING_CONTEXT });
  });

  it('refuses an insert naming a different organisation', async () => {
    await expect(
      inTransaction(
        (client) =>
          client.query(
            `INSERT INTO app.people (organisation_id, email, display_name)
             VALUES ($1, 'planted@example.test', 'P')`,
            [globex],
          ),
        acme,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('refuses an update that moves a row into another organisation', async () => {
    await expect(
      inTransaction(
        (client) =>
          client.query('UPDATE app.people SET organisation_id = $1 WHERE email = $2', [
            globex,
            'a@example.test',
          ]),
        acme,
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

import { Pool, type PoolClient } from 'pg';
import {
  startPostgresHarness,
  type PostgresHarness,
} from '../../../test/postgres-harness';

jest.setTimeout(180_000);

const MISSING_CONTEXT = 'TF001';
const SETTING = 'app.current_organisation';

let harness: PostgresHarness;
let runtime: Pool;
let singleConnection: Pool;

interface Fixture {
  organisationId: string;
  personId: string;
  membershipId: string;
  invitationId: string;
}

let acme: Fixture;
let globex: Fixture;

const seed = async (slug: string): Promise<Fixture> => {
  const owner = harness.pool('owner');
  const org = await owner.query<{ id: string }>(
    'INSERT INTO app.organisations (slug, name) VALUES ($1, $1) RETURNING id',
    [slug],
  );
  const organisationId = org.rows[0]!.id;
  const person = await owner.query<{ id: string }>(
    `INSERT INTO app.people (organisation_id, email, display_name)
     VALUES ($1, $2, $2) RETURNING id`,
    [organisationId, `staff@${slug}.test`],
  );
  const personId = person.rows[0]!.id;
  const membership = await owner.query<{ id: string }>(
    'INSERT INTO app.memberships (organisation_id, person_id) VALUES ($1, $2) RETURNING id',
    [organisationId, personId],
  );
  const invitation = await owner.query<{ id: string }>(
    `INSERT INTO app.invitations (organisation_id, email, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '1 day') RETURNING id`,
    [organisationId, `invitee@${slug}.test`, `hash-${slug}`],
  );
  return {
    organisationId,
    personId,
    membershipId: membership.rows[0]!.id,
    invitationId: invitation.rows[0]!.id,
  };
};

const asTenant = async <T>(
  organisationId: string | undefined,
  work: (client: PoolClient) => Promise<T>,
  pool: Pool = runtime,
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (organisationId !== undefined) {
      await client.query('SELECT set_config($1, $2, true)', [SETTING, organisationId]);
    }
    return await work(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
};

const ownerCount = async (table: string, id: string): Promise<number> => {
  const { rows } = await harness
    .pool('owner')
    .query<{ n: string }>(`SELECT count(*)::text AS n FROM app.${table} WHERE id = $1`, [
      id,
    ]);
  return Number(rows[0]!.n);
};

beforeAll(async () => {
  harness = await startPostgresHarness();
  runtime = new Pool({ connectionString: harness.url.app });
  singleConnection = new Pool({ connectionString: harness.url.app, max: 1 });
  acme = await seed('acme');
  globex = await seed('globex');
});

afterAll(async () => {
  await runtime?.end();
  await singleConnection?.end();
  await harness?.stop();
});

const tables: readonly {
  table: string;
  idOf: (fixture: Fixture) => string;
  update: string;
}[] = [
  { table: 'people', idOf: (f) => f.personId, update: "display_name = 'changed'" },
  { table: 'memberships', idOf: (f) => f.membershipId, update: "role = 'admin'" },
  {
    table: 'invitations',
    idOf: (f) => f.invitationId,
    update: "email = 'changed@x.test'",
  },
];

describe('the connection under test', () => {
  it('is the runtime role, which owns nothing and cannot bypass row-level security', async () => {
    const { rows } = await runtime.query<{
      current_user: string;
      rolbypassrls: boolean;
      rolsuper: boolean;
    }>(
      `SELECT current_user, r.rolbypassrls, r.rolsuper
         FROM pg_roles r WHERE r.rolname = current_user`,
    );

    expect(rows[0]).toEqual({
      current_user: 'tenantforge_app',
      rolbypassrls: false,
      rolsuper: false,
    });
  });

  it('is not the pool the fixtures were seeded through', () => {
    expect(runtime).not.toBe(harness.pool('owner'));
    expect(runtime).not.toBe(harness.pool('app'));
  });
});

describe.each(tables)('reads of $table, issued as raw SQL', ({ table, idOf }) => {
  it("return only the context organisation's rows", async () => {
    const rows = await asTenant(acme.organisationId, async (client) => {
      const result = await client.query<{ organisation_id: string }>(
        `SELECT organisation_id FROM app.${table}`,
      );
      return result.rows;
    });

    expect(rows).toHaveLength(1);
    expect(rows.every((row) => row.organisation_id === acme.organisationId)).toBe(true);
  });

  it("return nothing when another organisation's rows are asked for by id and by organisation", async () => {
    const result = await asTenant(acme.organisationId, async (client) => {
      const byId = await client.query(`SELECT * FROM app.${table} WHERE id = $1`, [
        idOf(globex),
      ]);
      const byOrganisation = await client.query(
        `SELECT * FROM app.${table} WHERE organisation_id = $1`,
        [globex.organisationId],
      );
      return { byId: byId.rowCount, byOrganisation: byOrganisation.rowCount };
    });

    expect(result).toEqual({ byId: 0, byOrganisation: 0 });
  });

  it('see the other organisation once the context is switched, proving the filter is the context', async () => {
    const count = await asTenant(globex.organisationId, async (client) => {
      const result = await client.query(`SELECT * FROM app.${table} WHERE id = $1`, [
        idOf(globex),
      ]);
      return result.rowCount;
    });

    expect(count).toBe(1);
  });
});

describe('writes against another organisation', () => {
  it('refuses an insert into people naming another organisation', async () => {
    await expect(
      asTenant(acme.organisationId, (client) =>
        client.query(
          `INSERT INTO app.people (organisation_id, email, display_name)
           VALUES ($1, 'planted@example.test', 'P')`,
          [globex.organisationId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('refuses an insert into invitations naming another organisation', async () => {
    await expect(
      asTenant(acme.organisationId, (client) =>
        client.query(
          `INSERT INTO app.invitations (organisation_id, email, token_hash, expires_at)
           VALUES ($1, 'x@example.test', 'planted', now() + interval '1 day')`,
          [globex.organisationId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('refuses an insert into memberships naming another organisation', async () => {
    await expect(
      asTenant(acme.organisationId, (client) =>
        client.query(
          'INSERT INTO app.memberships (organisation_id, person_id) VALUES ($1, $2)',
          [globex.organisationId, globex.personId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it.each(tables)(
    'affects no rows when updating $table that belongs to another organisation',
    async ({ table, idOf, update }) => {
      const result = await asTenant(acme.organisationId, (client) =>
        client.query(`UPDATE app.${table} SET ${update} WHERE id = $1`, [idOf(globex)]),
      );

      expect(result.rowCount).toBe(0);
      const { rows } = await harness
        .pool('owner')
        .query(
          `SELECT * FROM app.${table} WHERE id = $1 AND ${update.replace('=', 'IS NOT DISTINCT FROM')}`,
          [idOf(globex)],
        );
      expect(rows).toHaveLength(0);
    },
  );

  it.each(tables)(
    'affects no rows when deleting from $table a row of another organisation',
    async ({ table, idOf }) => {
      const result = await asTenant(acme.organisationId, (client) =>
        client.query(`DELETE FROM app.${table} WHERE id = $1`, [idOf(globex)]),
      );

      expect(result.rowCount).toBe(0);
      expect(await ownerCount(table, idOf(globex))).toBe(1);
    },
  );

  it('does let an organisation delete its own row, so the zero above is the policy and not a broken statement', async () => {
    const result = await asTenant(acme.organisationId, (client) =>
      client.query('DELETE FROM app.invitations WHERE id = $1', [acme.invitationId]),
    );

    expect(result.rowCount).toBe(1);
  });
});

describe.each(tables)(
  'any statement against $table with no context',
  ({ table, update }) => {
    it('raises on select', async () => {
      await expect(
        asTenant(undefined, (client) => client.query(`SELECT * FROM app.${table}`)),
      ).rejects.toMatchObject({ code: MISSING_CONTEXT });
    });

    it('raises on update', async () => {
      await expect(
        asTenant(undefined, (client) =>
          client.query(`UPDATE app.${table} SET ${update}`),
        ),
      ).rejects.toMatchObject({ code: MISSING_CONTEXT });
    });

    it('raises on delete', async () => {
      await expect(
        asTenant(undefined, (client) => client.query(`DELETE FROM app.${table}`)),
      ).rejects.toMatchObject({ code: MISSING_CONTEXT });
    });
  },
);

describe('an insert with no context', () => {
  it('raises', async () => {
    await expect(
      asTenant(undefined, (client) =>
        client.query(
          `INSERT INTO app.people (organisation_id, email, display_name)
           VALUES ($1, 'nocontext@example.test', 'N')`,
          [acme.organisationId],
        ),
      ),
    ).rejects.toMatchObject({ code: MISSING_CONTEXT });
  });
});

describe('a connection returning to the pool', () => {
  const backendPid = async (client: PoolClient): Promise<number> => {
    const { rows } = await client.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    );
    return rows[0]!.pid;
  };

  it('carries no context to the next borrower', async () => {
    const first = await singleConnection.connect();
    await first.query('BEGIN');
    await first.query('SELECT set_config($1, $2, true)', [SETTING, acme.organisationId]);
    const pidBefore = await backendPid(first);
    await first.query('COMMIT');
    first.release();

    const second = await singleConnection.connect();
    try {
      expect(await backendPid(second)).toBe(pidBefore);
      const { rows } = await second.query<{ value: string | null }>(
        'SELECT current_setting($1, true) AS value',
        [SETTING],
      );
      expect(rows[0]?.value ?? '').toBe('');
      await expect(second.query('SELECT * FROM app.people')).rejects.toMatchObject({
        code: MISSING_CONTEXT,
      });
    } finally {
      second.release();
    }
  });

  it('carries no context after a rolled-back transaction either', async () => {
    const first = await singleConnection.connect();
    await first.query('BEGIN');
    await first.query('SELECT set_config($1, $2, true)', [SETTING, acme.organisationId]);
    await first.query('ROLLBACK');
    first.release();

    const second = await singleConnection.connect();
    try {
      await expect(second.query('SELECT * FROM app.people')).rejects.toMatchObject({
        code: MISSING_CONTEXT,
      });
    } finally {
      second.release();
    }
  });

  it('WOULD leak with a session-scoped setting, which is what the two tests above guard against', async () => {
    const first = await singleConnection.connect();
    await first.query('SELECT set_config($1, $2, false)', [SETTING, acme.organisationId]);
    const pidBefore = await backendPid(first);
    first.release();

    const second = await singleConnection.connect();
    try {
      expect(await backendPid(second)).toBe(pidBefore);
      const { rows } = await second.query<{ organisation_id: string }>(
        'SELECT organisation_id FROM app.people',
      );
      expect(rows.map((row) => row.organisation_id)).toEqual([acme.organisationId]);
      await second.query('RESET ALL');
    } finally {
      second.release();
    }
  });
});

describe('the same assertions through a role that bypasses isolation (proves they can fail)', () => {
  it('shows every organisation to the owner role, so the filtering above is not a property of the data', async () => {
    const { rows } = await harness
      .pool('owner')
      .query<{ n: string }>(
        'SELECT count(DISTINCT organisation_id)::text AS n FROM app.people',
      );

    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(2);
  });

  it('lets the cross-tenant role read across organisations with no context', async () => {
    const { rows } = await harness
      .pool('crosstenant')
      .query<{ n: string }>(
        'SELECT count(DISTINCT organisation_id)::text AS n FROM app.people',
      );

    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(2);
  });
});

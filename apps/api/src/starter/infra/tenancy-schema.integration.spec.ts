import {
  startPostgresHarness,
  type PostgresHarness,
} from '../../../test/postgres-harness';

jest.setTimeout(180_000);

let harness: PostgresHarness;

const owner = () => harness.pool('owner');

const createOrganisation = async (slug: string): Promise<string> => {
  const { rows } = await owner().query<{ id: string }>(
    'INSERT INTO app.organisations (slug, name) VALUES ($1, $1) RETURNING id',
    [slug],
  );
  return rows[0]!.id;
};

const createPerson = async (organisationId: string, email: string): Promise<string> => {
  const { rows } = await owner().query<{ id: string }>(
    'INSERT INTO app.people (organisation_id, email, display_name) VALUES ($1, $2, $2) RETURNING id',
    [organisationId, email],
  );
  return rows[0]!.id;
};

const count = async (table: string, organisationId: string): Promise<number> => {
  const { rows } = await owner().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM app.${table} WHERE organisation_id = $1`,
    [organisationId],
  );
  return Number(rows[0]!.n);
};

beforeAll(async () => {
  harness = await startPostgresHarness();
});

afterAll(async () => {
  await harness?.stop();
});

describe('the tenancy schema', () => {
  it('lets the same email address exist in two organisations', async () => {
    const first = await createOrganisation('same-email-one');
    const second = await createOrganisation('same-email-two');

    await expect(createPerson(first, 'shared@example.test')).resolves.toBeDefined();
    await expect(createPerson(second, 'shared@example.test')).resolves.toBeDefined();
  });

  it('refuses the same email twice within one organisation', async () => {
    const organisation = await createOrganisation('dup-email');
    await createPerson(organisation, 'dup@example.test');

    await expect(createPerson(organisation, 'dup@example.test')).rejects.toThrow(
      /people_organisation_id_email_unique/,
    );
  });

  it('refuses an email that is not lowercase', async () => {
    const organisation = await createOrganisation('mixed-case');

    await expect(createPerson(organisation, 'Mixed@Example.test')).rejects.toThrow(
      /people_email_lowercase/,
    );
  });

  it('refuses a duplicate organisation slug', async () => {
    await createOrganisation('taken-slug');

    await expect(createOrganisation('taken-slug')).rejects.toThrow(
      /organisations_slug_unique/,
    );
  });

  it.each(['ab', 'Upper', 'has space', '-leading', 'trailing-', 'under_score', 'a.b.c'])(
    'refuses the malformed slug %p',
    async (slug) => {
      await expect(createOrganisation(slug)).rejects.toThrow(/organisations_slug_format/);
    },
  );

  it('accepts a slug at the 63 character label limit and refuses 64', async () => {
    await expect(createOrganisation('a'.repeat(63))).resolves.toBeDefined();
    await expect(createOrganisation('b'.repeat(64))).rejects.toThrow(
      /organisations_slug_format/,
    );
  });

  it('refuses a membership that points at a person from another organisation', async () => {
    const first = await createOrganisation('cross-fk-one');
    const second = await createOrganisation('cross-fk-two');
    const outsider = await createPerson(second, 'outsider@example.test');

    await expect(
      owner().query(
        'INSERT INTO app.memberships (organisation_id, person_id) VALUES ($1, $2)',
        [first, outsider],
      ),
    ).rejects.toThrow(/memberships_person_fk/);
  });

  it('refuses a second membership for the same person in one organisation', async () => {
    const organisation = await createOrganisation('dup-membership');
    const person = await createPerson(organisation, 'member@example.test');
    const insert = () =>
      owner().query(
        'INSERT INTO app.memberships (organisation_id, person_id) VALUES ($1, $2)',
        [organisation, person],
      );

    await insert();
    await expect(insert()).rejects.toThrow(
      /memberships_organisation_id_person_id_unique/,
    );
  });

  it('refuses an unknown membership role', async () => {
    const organisation = await createOrganisation('bad-role');
    const person = await createPerson(organisation, 'role@example.test');

    await expect(
      owner().query(
        "INSERT INTO app.memberships (organisation_id, person_id, role) VALUES ($1, $2, 'root')",
        [organisation, person],
      ),
    ).rejects.toThrow(/memberships_role_valid/);
  });

  it('scopes invitation token uniqueness to the organisation', async () => {
    const first = await createOrganisation('invite-one');
    const second = await createOrganisation('invite-two');
    const insert = (organisation: string) =>
      owner().query(
        `INSERT INTO app.invitations (organisation_id, email, token_hash, expires_at)
         VALUES ($1, 'invitee@example.test', 'same-hash', now() + interval '1 day')`,
        [organisation],
      );

    await insert(first);
    await expect(insert(second)).resolves.toBeDefined();
    await expect(insert(first)).rejects.toThrow(
      /invitations_organisation_id_token_hash_unique/,
    );
  });

  it('deletes every dependent record when an organisation is deleted', async () => {
    const doomed = await createOrganisation('doomed');
    const survivor = await createOrganisation('survivor');

    for (const organisation of [doomed, survivor]) {
      const person = await createPerson(organisation, 'staff@example.test');
      await owner().query(
        'INSERT INTO app.memberships (organisation_id, person_id) VALUES ($1, $2)',
        [organisation, person],
      );
      await owner().query(
        `INSERT INTO app.invitations (organisation_id, email, token_hash, expires_at)
         VALUES ($1, 'invitee@example.test', 'hash', now() + interval '1 day')`,
        [organisation],
      );
    }

    await owner().query('DELETE FROM app.organisations WHERE id = $1', [doomed]);

    for (const table of ['people', 'memberships', 'invitations']) {
      expect(await count(table, doomed)).toBe(0);
      expect(await count(table, survivor)).toBe(1);
    }
  });
});

describe('the tenant column convention', () => {
  const tenantTables = ['people', 'memberships', 'invitations'];

  it('is spelled organisation_id on every table that is not organisations', async () => {
    const { rows } = await owner().query<{ table_name: string }>(
      `SELECT t.table_name
         FROM information_schema.tables t
        WHERE t.table_schema = 'app'
          AND t.table_type = 'BASE TABLE'
          AND t.table_name <> 'organisations'
          AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns c
             WHERE c.table_schema = 'app'
               AND c.table_name = t.table_name
               AND c.column_name = 'organisation_id')`,
    );

    expect(rows).toEqual([]);
  });

  it('leads every index, unique constraint and primary key on a tenant-scoped table', async () => {
    const { rows } = await owner().query<{ table_name: string; index_name: string }>(
      `SELECT c.relname AS table_name, i.relname AS index_name
         FROM pg_index x
         JOIN pg_class c ON c.oid = x.indrelid
         JOIN pg_class i ON i.oid = x.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app'
          AND c.relname = ANY($1)
          AND (SELECT a.attname FROM pg_attribute a
                WHERE a.attrelid = c.oid AND a.attnum = x.indkey[0]) <> 'organisation_id'`,
      [tenantTables],
    );

    expect(rows).toEqual([]);
  });

  it('keys each tenant table by (organisation_id, id)', async () => {
    const { rows } = await owner().query<{ table_name: string; columns: string[] }>(
      `SELECT c.relname AS table_name,
              array_agg(a.attname::text ORDER BY k.ord) AS columns
         FROM pg_index x
         JOIN pg_class c ON c.oid = x.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
        WHERE n.nspname = 'app' AND x.indisprimary AND c.relname = ANY($1)
        GROUP BY c.relname ORDER BY c.relname`,
      [tenantTables],
    );

    expect(rows).toEqual(
      [...tenantTables].sort().map((table_name) => ({
        table_name,
        columns: ['organisation_id', 'id'],
      })),
    );
  });

  it('would notice an index that does not lead with organisation_id', async () => {
    await owner().query('CREATE INDEX temp_probe_idx ON app.people (email)');
    try {
      const { rows } = await owner().query<{ index_name: string }>(
        `SELECT i.relname AS index_name
           FROM pg_index x
           JOIN pg_class c ON c.oid = x.indrelid
           JOIN pg_class i ON i.oid = x.indexrelid
          WHERE c.relname = 'people'
              AND (SELECT a.attname FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attnum = x.indkey[0]) <> 'organisation_id'`,
      );
      expect(rows.map((row) => row.index_name)).toContain('temp_probe_idx');
    } finally {
      await owner().query('DROP INDEX app.temp_probe_idx');
    }
  });
});

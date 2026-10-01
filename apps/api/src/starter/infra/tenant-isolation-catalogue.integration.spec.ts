import {
  startPostgresHarness,
  type PostgresHarness,
} from '../../../test/postgres-harness';
import {
  ISOLATION_ALLOWLIST,
  findUnprotectedTables,
} from '../../../test/unprotected-tables';

jest.setTimeout(180_000);

let harness: PostgresHarness;

beforeAll(async () => {
  harness = await startPostgresHarness();
});

afterAll(async () => {
  await harness?.stop();
});

describe('every table in the database', () => {
  it('has forced row-level security and policies covering every command, except the allowlist', async () => {
    const unprotected = await findUnprotectedTables(harness.pool('owner'));

    expect(unprotected).toEqual([]);
  });

  it('keeps the allowlist short, named and justified', () => {
    expect(ISOLATION_ALLOWLIST.map((entry) => entry.table)).toEqual([
      'app.organisations',
      'drizzle.__drizzle_migrations_foundation',
    ]);
    for (const entry of ISOLATION_ALLOWLIST) {
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });

  it('actually finds every allowlisted table, so a rename cannot leave a stale exemption', async () => {
    const { rows } = await harness.pool('owner').query<{ table: string }>(
      `SELECT n.nspname || '.' || c.relname AS "table"
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p')`,
    );
    const existing = new Set(rows.map((row) => row.table));

    for (const entry of ISOLATION_ALLOWLIST) {
      expect(existing.has(entry.table)).toBe(true);
    }
  });
});

describe('the enumeration (proves it can fail)', () => {
  const probe = 'app.isolation_probe';

  const reportFor = async (): Promise<string[] | undefined> => {
    const unprotected = await findUnprotectedTables(harness.pool('owner'));
    return unprotected.find((entry) => entry.table === probe)?.problems;
  };

  const owner = () => harness.pool('owner');

  afterEach(async () => {
    await owner().query(`DROP TABLE IF EXISTS ${probe}`);
  });

  it('reports a table added with no isolation at all', async () => {
    await owner().query(`CREATE TABLE ${probe} (id int, organisation_id uuid)`);

    expect(await reportFor()).toEqual(
      expect.arrayContaining(['row-level security is not enabled', 'no policy']),
    );
  });

  it('reports a table whose isolation is enabled but not forced', async () => {
    await owner().query(`CREATE TABLE ${probe} (id int, organisation_id uuid)`);
    await owner().query(`ALTER TABLE ${probe} ENABLE ROW LEVEL SECURITY`);
    await owner().query(
      `CREATE POLICY p ON ${probe} USING (organisation_id = (SELECT app.current_organisation_id()))
         WITH CHECK (organisation_id = (SELECT app.current_organisation_id()))`,
    );

    expect(await reportFor()).toEqual(['row-level security is not forced']);
  });

  it('reports a table that is forced but has no policy', async () => {
    await owner().query(`CREATE TABLE ${probe} (id int, organisation_id uuid)`);
    await owner().query(`ALTER TABLE ${probe} ENABLE ROW LEVEL SECURITY`);
    await owner().query(`ALTER TABLE ${probe} FORCE ROW LEVEL SECURITY`);

    expect(await reportFor()).toEqual(expect.arrayContaining(['no policy']));
  });

  it('reports a policy that filters reads but does not check writes', async () => {
    await owner().query(`CREATE TABLE ${probe} (id int, organisation_id uuid)`);
    await owner().query(`ALTER TABLE ${probe} ENABLE ROW LEVEL SECURITY`);
    await owner().query(`ALTER TABLE ${probe} FORCE ROW LEVEL SECURITY`);
    await owner().query(
      `CREATE POLICY p ON ${probe} FOR SELECT USING (organisation_id = (SELECT app.current_organisation_id()))`,
    );

    expect(await reportFor()).toEqual(
      expect.arrayContaining([
        'no policy covers INSERT',
        'no policy covers UPDATE',
        'no policy covers DELETE',
      ]),
    );
  });

  it('reports a policy that does not use the context function', async () => {
    await owner().query(`CREATE TABLE ${probe} (id int, organisation_id uuid)`);
    await owner().query(`ALTER TABLE ${probe} ENABLE ROW LEVEL SECURITY`);
    await owner().query(`ALTER TABLE ${probe} FORCE ROW LEVEL SECURITY`);
    await owner().query(`CREATE POLICY p ON ${probe} USING (true) WITH CHECK (true)`);

    expect(await reportFor()).toEqual([
      'a policy does not filter on current_organisation_id()',
    ]);
  });

  it('reports a policy whose write check does not use the context function', async () => {
    await owner().query(`CREATE TABLE ${probe} (id int, organisation_id uuid)`);
    await owner().query(`ALTER TABLE ${probe} ENABLE ROW LEVEL SECURITY`);
    await owner().query(`ALTER TABLE ${probe} FORCE ROW LEVEL SECURITY`);
    await owner().query(
      `CREATE POLICY p ON ${probe} USING (organisation_id = (SELECT app.current_organisation_id()))
         WITH CHECK (true)`,
    );

    expect(await reportFor()).toEqual([
      'a policy does not filter on current_organisation_id()',
    ]);
  });

  it('reports nothing for a table that is properly isolated', async () => {
    await owner().query(`CREATE TABLE ${probe} (id int, organisation_id uuid)`);
    await owner().query(`ALTER TABLE ${probe} ENABLE ROW LEVEL SECURITY`);
    await owner().query(`ALTER TABLE ${probe} FORCE ROW LEVEL SECURITY`);
    await owner().query(
      `CREATE POLICY p ON ${probe} USING (organisation_id = (SELECT app.current_organisation_id()))
         WITH CHECK (organisation_id = (SELECT app.current_organisation_id()))`,
    );

    expect(await reportFor()).toBeUndefined();
  });
});

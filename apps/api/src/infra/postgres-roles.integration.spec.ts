import { startPostgresHarness, type PostgresHarness } from '../../test/postgres-harness';

/**
 * The role separation is the part of this phase most likely to be rushed into something
 * that looks configured and enforces nothing. These assertions exist to fail loudly if
 * that ever happens — see the "can actually fail" block at the bottom, which proves the
 * checks have teeth by pointing them at the roles that SHOULD pass.
 */
jest.setTimeout(180_000);

let harness: PostgresHarness;

const bypassFlags = async (
  role: 'owner' | 'app' | 'crosstenant',
): Promise<{ rolsuper: boolean; rolbypassrls: boolean }> => {
  const { rows } = await harness
    .pool(role)
    .query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
  if (!rows[0]) throw new Error('current_user not found in pg_roles');
  return rows[0];
};

const ownedTables = async (role: 'owner' | 'app' | 'crosstenant'): Promise<string[]> => {
  const { rows } = await harness.pool(role).query<{ relname: string }>(
    `SELECT c.relname
       FROM pg_class c
       JOIN pg_roles r ON r.oid = c.relowner
      WHERE r.rolname = current_user
        AND c.relkind IN ('r', 'p')`,
  );
  return rows.map((row) => row.relname);
};

beforeAll(async () => {
  harness = await startPostgresHarness();
});

afterAll(async () => {
  await harness?.stop();
});

describe('the runtime Postgres role', () => {
  it('cannot bypass row-level security and is not a superuser', async () => {
    expect(await bypassFlags('app')).toEqual({
      rolsuper: false,
      rolbypassrls: false,
    });
  });

  it('is not a member of any role that can bypass row-level security', async () => {
    const { rows } = await harness.pool('app').query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_auth_members m
         JOIN pg_roles granted ON granted.oid = m.roleid
        WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
          AND (granted.rolbypassrls OR granted.rolsuper)`,
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('owns no tables', async () => {
    expect(await ownedTables('app')).toEqual([]);
  });

  it('cannot create a table in the app schema', async () => {
    await expect(
      harness.pool('app').query('CREATE TABLE app.should_not_exist (id int)'),
    ).rejects.toThrow(/permission denied/i);
  });

  it('can read and write rows it has been granted', async () => {
    await harness
      .pool('owner')
      .query(
        "INSERT INTO app.tenants (slug, name) VALUES ('acme', 'Acme Inc') ON CONFLICT (slug) DO NOTHING",
      );

    await harness
      .pool('app')
      .query("UPDATE app.tenants SET name = 'Acme' WHERE slug = 'acme'");

    const { rows } = await harness
      .pool('app')
      .query<{ name: string }>("SELECT name FROM app.tenants WHERE slug = 'acme'");
    expect(rows[0]?.name).toBe('Acme');
  });
});

describe('the privileged roles (proves the checks above can fail)', () => {
  it('the owner role CAN bypass row-level security', async () => {
    expect((await bypassFlags('owner')).rolbypassrls).toBe(true);
  });

  it('the cross-tenant role CAN bypass row-level security but still owns nothing', async () => {
    expect((await bypassFlags('crosstenant')).rolbypassrls).toBe(true);
    expect(await ownedTables('crosstenant')).toEqual([]);
  });
});

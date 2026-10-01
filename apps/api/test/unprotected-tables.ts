import type { Pool } from 'pg';

export interface IsolationAllowlistEntry {
  readonly table: string;
  readonly reason: string;
}

export const ISOLATION_ALLOWLIST: readonly IsolationAllowlistEntry[] = [
  {
    table: 'app.organisations',
    reason:
      'The subdomain is resolved to an organisation before any tenant context exists, so this table sits above the isolation boundary.',
  },
  {
    table: 'drizzle.__drizzle_migrations_foundation',
    reason: 'Migration bookkeeping. Owned and written only by the migration role.',
  },
];

export interface UnprotectedTable {
  readonly table: string;
  readonly problems: string[];
}

interface TableRow {
  table: string;
  enabled: boolean;
  forced: boolean;
  commands: string[] | null;
  checked_commands: string[] | null;
  filters_on_context: boolean;
}

const CATALOGUE_QUERY = `
  SELECT n.nspname || '.' || c.relname AS "table",
         c.relrowsecurity AS enabled,
         c.relforcerowsecurity AS forced,
         (SELECT array_agg(p.polcmd::text) FROM pg_policy p WHERE p.polrelid = c.oid) AS commands,
         (SELECT array_agg(p.polcmd::text) FROM pg_policy p
           WHERE p.polrelid = c.oid AND p.polwithcheck IS NOT NULL) AS checked_commands,
         COALESCE((SELECT bool_and(
                     COALESCE(pg_get_expr(p.polqual, p.polrelid) LIKE '%current_organisation_id%', true)
                 AND COALESCE(pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%current_organisation_id%', true)
                 ) FROM pg_policy p WHERE p.polrelid = c.oid), false) AS filters_on_context
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p')
     AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
   ORDER BY 1`;

const covers = (commands: readonly string[] | null, needed: string): boolean =>
  (commands ?? []).some((command) => command === '*' || command === needed);

export async function findUnprotectedTables(
  pool: Pool,
  allowlist: readonly IsolationAllowlistEntry[] = ISOLATION_ALLOWLIST,
): Promise<UnprotectedTable[]> {
  const allowed = new Set(allowlist.map((entry) => entry.table));
  const { rows } = await pool.query<TableRow>(CATALOGUE_QUERY);

  return rows
    .filter((row) => !allowed.has(row.table))
    .map((row) => {
      const problems: string[] = [];
      if (!row.enabled) problems.push('row-level security is not enabled');
      if (!row.forced) problems.push('row-level security is not forced');
      if (!row.commands || row.commands.length === 0) problems.push('no policy');
      for (const [needed, label] of [
        ['r', 'SELECT'],
        ['a', 'INSERT'],
        ['w', 'UPDATE'],
        ['d', 'DELETE'],
      ] as const) {
        if (row.commands?.length && !covers(row.commands, needed)) {
          problems.push(`no policy covers ${label}`);
        }
      }
      if (row.commands?.length && !covers(row.checked_commands, 'a')) {
        problems.push('no policy checks INSERT');
      }
      if (row.commands?.length && !covers(row.checked_commands, 'w')) {
        problems.push('no policy checks UPDATE');
      }
      if (row.commands?.length && !row.filters_on_context) {
        problems.push('a policy does not filter on current_organisation_id()');
      }
      return { table: row.table, problems };
    })
    .filter((entry) => entry.problems.length > 0);
}

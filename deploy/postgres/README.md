# Postgres role provisioning

The three-role separation the tenant-isolation model depends on is defined once, in
[`init/01-roles.sql`](init/01-roles.sql), and applied the same way in every environment.
`init/00-extensions.sql` enables `btree_gist` alongside it.

| Role                      | Owns    | `BYPASSRLS` | `CREATE` on db | Used by                                  |
| ------------------------- | ------- | ----------- | -------------- | ---------------------------------------- |
| `tenantforge_owner`       | schema  | yes         | yes            | `db:migrate:pg` only                     |
| `tenantforge_app`         | nothing | no          | no             | the running application (`POSTGRES_URL`) |
| `tenantforge_crosstenant` | nothing | yes         | no             | outbox relay + billing webhook resolver  |

The split is load-bearing: a table's owner bypasses a row-level-security policy unless it
is `FORCE`d, and any `BYPASSRLS` role ignores policies entirely. If the runtime role
owned its tables or could bypass, the isolation added next phase would pass every test
and enforce nothing. `apps/api/src/infra/postgres-roles.integration.spec.ts` asserts the
runtime role owns no tables and cannot bypass.

## Local development

`docker-compose.yml` mounts `deploy/postgres/init/` into the Postgres container's
`/docker-entrypoint-initdb.d`, so both files run automatically the first time the data
volume is created. `npm run infra:down -v` drops the volume; the next `infra:up` re-runs
them.

## Integration tests

`apps/api/test/postgres-harness.ts` starts a throwaway container and executes the **same**
`01-roles.sql` — not a test-only copy — before applying migrations, so a green test
cannot prove something the deployment does not do.

## Deployment (managed Postgres, e.g. Cloud SQL)

A managed instance has no `docker-entrypoint-initdb.d`. Provisioning is a **one-time
bootstrap**, run once per database by an admin/superuser connection **before the first
`db:migrate:pg`**:

```bash
psql "$ADMIN_URL" -f deploy/postgres/init/00-extensions.sql
psql "$ADMIN_URL" -f deploy/postgres/init/01-roles.sql
```

or the equivalent in whatever provisions the database (Terraform
`postgresql_role` / a Cloud SQL bootstrap job). The passwords in `01-roles.sql` are
local/test values — set real ones and store them in Secret Manager:

- `tenantforge-postgres-url` → `tenantforge_app` connection string → the Cloud Run
  service (`deploy/cloudrun/service.yaml`).
- the `tenantforge_owner` connection string → `POSTGRES_MIGRATION_URL` on the migration
  job only, never the service.
- the `tenantforge_crosstenant` connection string → the relay/worker, once it reads
  Postgres.

After the bootstrap, every subsequent deploy only runs `db:migrate:pg` (owner role) —
grants for new tables come from the `ALTER DEFAULT PRIVILEGES` in
`0001_roles_grants.sql`, so roles are never re-provisioned.

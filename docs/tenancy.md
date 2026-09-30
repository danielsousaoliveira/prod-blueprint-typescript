# Tenancy

How organisations are modelled, how isolation is enforced, and the decisions behind both.
Each section is added by the change that introduces the mechanism it describes.

## Schema

Four tables in the `app` schema, all in `apps/api/src/starter/persistence/pg/schema.ts`:

| Table           | Scoped by `organisation_id` | Purpose                                             |
| --------------- | --------------------------- | --------------------------------------------------- |
| `organisations` | no (see below)              | One row per customer; the subdomain slug lives here |
| `people`        | yes                         | Identity within one organisation                    |
| `memberships`   | yes                         | A person's role and standing in the organisation    |
| `invitations`   | yes                         | Pending invitations, keyed by a hashed token        |

### One column name, leading every index

Every tenant-scoped table spells its organisation reference `organisation_id`. Isolation
policies are written against that name, so a table that spells it differently would
silently receive no policy. The column also leads every index, unique constraint and primary key, which
is what makes uniqueness per organisation rather than global. That includes primary keys:
`people`, `memberships` and `invitations` are keyed by `(organisation_id, id)`, and the
membership foreign key to `people` references that composite key.

### Email is unique per organisation, not globally

`people` has `UNIQUE (organisation_id, email)`. A globally unique email would let one
customer probe whether another customer's staff have accounts, by attempting to invite an
address and reading the error. The cost is that the same human appearing in two
organisations has two `people` rows; linking them across organisations is a later concern
and would sit above this table, not inside it.

Emails are stored lowercase and the database refuses anything else, so uniqueness cannot be
sidestepped by case.

### Memberships carry the standing

`memberships` holds `role` and `status`, separate from `people`, so suspending someone or
changing their role never touches their identity row. Its foreign key to `people` is the
composite `(organisation_id, person_id)`, so a membership cannot point at a person from a
different organisation even if application code tries.

### Slugs

`organisations.slug` is unique and constrained to a DNS label: lowercase letters, digits and
inner hyphens, 3 to 63 characters, never starting or ending with a hyphen.

### Deleting an organisation

Every foreign key to `organisations` is `ON DELETE CASCADE`, and so is the membership to
person key. Deleting an organisation removes its people, memberships and invitations in
one statement. This is covered in `tenancy-schema.integration.spec.ts`.

### `organisations` is the deliberate exception to isolation

A request carries a subdomain. Turning that into an organisation id has to happen before
any tenant context exists, so the table it is read from cannot itself require one. The
runtime role can read and write `organisations`; nothing else is exempt.

## Row-level isolation

`0003_tenant_isolation.sql` installs `app.current_organisation_id()` and, for each
tenant-scoped table, enables **and forces** row-level security with one policy
(`organisation_isolation`) that covers every command.

### Forced, not just enabled

A table's owner bypasses its policies unless the table is `FORCE`d. The runtime role owns
nothing, so enabling alone would work today; forcing means it keeps working if ownership
ever changes, and it makes the `pg_class.relforcerowsecurity` flag something a test can
assert on.

### The policy has a check clause, not only a filter

`USING` filters what a statement can see and touch. Without `WITH CHECK`, an `INSERT`
naming another organisation would be accepted, because no existing row is being filtered.
Both clauses are identical and both call the context function.

### The context function raises

`app.current_organisation_id()` reads `app.current_organisation` with
`current_setting(name, true)`, so an unset setting yields NULL instead of an error the
function cannot classify. It then decides:

| State                 | Result                  |
| --------------------- | ----------------------- |
| unset or empty        | raises SQLSTATE `TF001` |
| set, not a valid uuid | raises SQLSTATE `TF002` |
| set to a valid uuid   | returns it              |

An unset context returning NULL would make `organisation_id = NULL` match nothing, and an
empty result set reads as data loss. Raising turns a forgotten context into an immediate,
attributable failure.

The setting is written with `set_config($1, $2, true)`, which takes the value as a bound
parameter. `SET LOCAL` cannot take a parameter, so building it from a request-derived
string would be an injection site.

The policy calls the function as `(SELECT app.current_organisation_id())`, which lets
PostgreSQL evaluate it as an InitPlan: once, when its value is first needed, and reused for
the rest of the statement rather than recomputed per row. That is a planner behaviour, not
a guarantee. A scan that never needs the value, such as one over an empty table, may return
zero rows without calling the function and so without raising `TF001`. The tests therefore
run against tables that hold rows.

### Ordering

drizzle's migrator applies every pending migration inside one transaction, so a table
created in `0002` and its policy in `0003` become visible together. No committed state has
a tenant table without its policy.

### Excluded on purpose

`organisations` has no policy. See the exception under Schema.

## Running code as a tenant

All tenant data access goes through `TenantTransactionRunner.run(organisationId, work)` in
`apps/api/src/starter/infra/tenancy/tenant-transaction.ts`.

It checks out a connection, opens a transaction, sets `app.current_organisation` with
`set_config($1, $2, true)` (the third argument makes it transaction-local, the values are
bound parameters), runs `work`, then commits or rolls back and releases. The organisation id
is validated as a uuid before any connection is taken.

### Why transaction scope and not connection scope

A pooled connection is reused by the next request. A session-level setting written for one
organisation is still there when a different request borrows the connection, so under load
one customer can read another's rows, intermittently and unreproducibly. `set_config(...,
true)` is discarded at commit or rollback, so it cannot outlive the transaction.

This is also the only mode that is safe behind a transaction-pooling proxy such as
PgBouncer. In that mode consecutive statements of one session can land on different backend
connections, so any session-level setting is silently unreliable. Nothing here uses one; if
someone adds `SET`, `set_config(..., false)` or a session-level advisory lock, it will work
in development and break behind a pooler.

The pool is small on purpose (`POSTGRES_POOL_MAX`): a tenant transaction holds a connection
for its whole duration, so that number is the real request concurrency ceiling.

### The handle repositories receive

Repositories depend on `TenantDb`, never on the pool. `TenantDb.query` looks up the
transaction the runner opened for the current async call chain and throws
`NoTenantTransactionError` if there is none, or if the transaction has already finished. A
forgotten transaction is an error at the call site, not an empty result at the API.

`PostgresService` no longer exposes its pool. Importing it outside `starter/infra` and the
health probe fails linting.

A nested `run` for the same organisation joins the open transaction; for a different
organisation it throws.

### Background work

A job has no request to inherit an organisation from, so the payload carries it.
`createTenantWorker` is the one sanctioned way to build a worker: it rejects a payload
without a valid `organisationId` and runs the handler inside `run`. A worker built directly
with BullMQ's `Worker` has no tenant transaction, so `TenantDb` would throw in it.

### The privileged handle

`PrivilegedDatabase` connects as `tenantforge_crosstenant`, which bypasses row-level
security, for work that spans organisations (relaying the outbox in one poll). It is a
separate injectable, and importing it outside `starter/infra`, the outbox persistence
adapter and the jobs module fails linting. `eslint-tests/boundary-rules.test.mjs` proves
both the restriction and the allowlist, and runs in CI.

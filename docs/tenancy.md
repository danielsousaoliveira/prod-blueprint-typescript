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

## Resolving the organisation from the request host

`TenantResolutionMiddleware` (registered by `TenancyModule`) runs on every route before any
guard, so by the time `AuthGuard` runs the request already carries `request.organisation`.
Handlers read it with `@CurrentOrganisation()` (404 if absent) or `@OptionalOrganisation()`.

The host is parsed, not string-matched: `acme.<APP_BASE_DOMAIN>` is organisation `acme`.

| Host                                       | Result                             |
| ------------------------------------------ | ---------------------------------- |
| `acme.localtest.me`, known slug            | organisation resolved              |
| `nobody.localtest.me`, unknown slug        | 404 problem+json                   |
| `a.b.localtest.me`, or an invalid label    | 404 problem+json, no lookup        |
| `app.localtest.me` (reserved name)         | no organisation, request continues |
| `localtest.me`, `localhost`, an IP address | no organisation, request continues |

Hosts outside the base domain resolve no organisation rather than failing, so health probes
addressed by IP and local tooling keep working. Anything that needs an organisation fails on
its own when it finds none.

### Reserved names

`www`, `app`, `api`, `web`, `ui`, `admin`, `administration`, `status`, `mail`, `docs`,
`documentation` and `marketing` (see `modules/tenancy/slug.ts`) cannot be claimed:
`OrganisationDirectory.create` and `renameSlug` refuse them (and report a duplicate as
`SlugTakenError`, from the unique-violation `23505`, so a caller can answer 409), and a request to one of those
hosts is treated as infrastructure rather than a lookup.

### Caching

Slug to organisation lookups are cached in Redis for 60 seconds. `renameSlug` deletes the
old and new keys. A miss is never cached, so a newly created organisation is reachable
immediately. If Redis is unavailable the lookup falls through to Postgres.

### The GraphQL surfaces

The HTTP GraphQL context copies `organisation` from the request. The WebSocket upgrade
never passes through Express, so `onConnect` resolves it from the upgrade request's `Host`
header with the same resolver and rejects the connection for an unknown organisation. The
context factory still builds loaders per request; none is shared across organisations.

### Local development without host files

`APP_BASE_DOMAIN` defaults to `localtest.me`, a public domain whose wildcard resolves to
127.0.0.1, so `http://acme.localtest.me:5173` works in any browser and in Playwright with no
`/etc/hosts` entry. `*.localhost` was not used: browsers, Node's HTTP client and Playwright
disagree on whether it resolves. The trade-off is that local development needs DNS access.

Vite lists `.localtest.me` in `server.allowedHosts`, listens on `127.0.0.1`, and its proxy uses
`changeOrigin: false`, so the browser's `Host` header reaches the API unchanged. With `changeOrigin: true` the API
would see `localhost:3000` and never find the organisation. The explicit `127.0.0.1` bind
matters because `localtest.me` resolves to an IPv4 address and Vite's default `localhost` bind can
be IPv6-only, which gave `ERR_CONNECTION_REFUSED` in the e2e run.

### The override header

`X-Organisation-Slug` names an organisation when the host names none, for offline use and
tools that cannot use subdomains. Anyone who can set a header can impersonate any
organisation with it, so it is honoured only when `ALLOW_ORGANISATION_OVERRIDE=true`, which
defaults to false and is set in `.env.example` for local development only. It is an explicit
flag rather than a check on `NODE_ENV` because `NODE_ENV` defaults to `development` when
unset, so a deployment that forgot it would ship the impersonation primitive enabled. The
HTTP and WebSocket paths share the one resolver and so the same flag. The refusal is covered
by `organisation-resolver.spec.ts` and `tenancy.integration.spec.ts`, each of which also
shows the header working when enabled so the disabled case is not vacuous.

## Cross-site request protection per organisation

`CsrfMiddleware` rejects a state-changing request whose `Origin` is present and not allowed.
An origin is allowed if it is in `ALLOWED_ORIGINS` (the marketing site, the dev server) or
if it is `https://<slug>.<APP_BASE_DOMAIN>` for a valid slug (`modules/auth/origin-policy.ts`).

The second rule parses the origin as a URL and matches the hostname's labels. It does not
compare strings, because a suffix comparison accepts `evilexample.com` for `example.com`
and `acme-example.com` for `acme.example.com`. Specifically it requires:

- the origin to round-trip through `URL` unchanged, so paths, credentials and trailing
  slashes are rejected;
- the hostname to end in `.` plus the base domain, so a look-alike that merely shares the
  trailing characters is not a subdomain;
- exactly one label before that, and that label to be a valid organisation slug, so
  `a.b.example.com` and `-x.example.com` are rejected;
- `https`, when `SESSION_COOKIE_SECURE` is on. Plain `http` is accepted only for
  development.

The slug does not have to exist. The check is about whether the origin could be one of
ours, and a database lookup on every mutating request would cost more than it protects:
every organisation subdomain resolves to the same application, and the session cookie
decides what the request can do.

### Requests with no `Origin` are allowed, on purpose

The payment provider's webhook sends no `Origin`, as do `curl` and server-to-server calls,
and rejecting those would break the webhook. That is the reason the check allows it.

A missing `Origin` does not prove the client is not a browser or holds no cookie. Browsers
omit `Origin` on some requests, notably same-origin `GET` and `HEAD`, and an older browser
or embedded webview may omit it elsewhere. So the allowance is a trade-off, not a proof, and
the protection for a state-changing request that arrives without one comes from the other
layers:

- `SameSite=Lax` on the session cookie, so a browser does not attach it to a cross-site
  `POST`;
- `Sec-Fetch-Site: cross-site`, which the middleware still rejects and which a page cannot
  forge.

The contract that makes this safe:

- **Safe methods change nothing.** `GET`, `HEAD` and `OPTIONS` skip the check entirely, so
  no handler reachable by them may change state. That includes GraphQL queries, which can be
  sent with `GET`; mutations are accepted only over `POST`, where the check applies.
- **State changes use non-safe methods**, which the middleware covers.
- **Webhooks authenticate by signature, not by session cookie.** A route that accepts
  originless requests must never rely on a cookie to identify the caller.

`csrf.middleware.spec.ts` names the webhook as the reason in the test that covers the
originless case.

### The session cookie and the parent domain

By default the session cookie is host-only: only the exact host that set it receives it, so
a session on `acme.example.com` is not sent to `globex.example.com`.

Setting `SESSION_COOKIE_DOMAIN=example.com` scopes it to the parent domain, so one sign-in
works across every organisation a person belongs to. That is an opt-in with a real cost:

- **Any subdomain can act as the user everywhere.** If one organisation's subdomain is
  compromised (an XSS in tenant-controlled content, a subdomain takeover after a slug is
  released), script running there can send authenticated requests to every other
  organisation the user belongs to.
- The cookie is sent to every subdomain, including reserved ones such as `status` and
  `docs`, so those must not run untrusted content.

Mitigations in place:

- The cookie is `HttpOnly`, so script cannot read it, only use it from the page.
- `SameSite=Lax` and the origin check above stop another site from forging requests with it.
- Slugs are validated and reserved names cannot be claimed, so a customer cannot register
  an infrastructure host.
- The domain is opt-in; the default is the narrower host-only scope.

Not in place yet, and worth doing before enabling it in production: serve tenant-controlled
content from a separate registrable domain, and release slugs only after a quarantine
period so a deleted organisation's name cannot be re-registered by someone else.

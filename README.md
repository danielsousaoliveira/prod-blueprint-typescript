# TenantForge

A multi-tenant SaaS starter focused on tenant isolation, subscription billing, subdomains,
and role-based access. Its first domain slice lets patients browse a doctor's availability and request a slot;
the doctor accepts, declines, or proposes a new time; the patient accepts or declines that
counter-proposal. Both sides can cancel. Everyone gets notified.

Two properties drive the entire design:

1. **No double-booking, ever** — even for two requests at the same millisecond. The
   guarantee lives in the database, not in application code.
2. **Correct timezone handling** — doctors and patients in different zones, and recurring
   availability that survives daylight-saving transitions without silently shifting.

Sessions are server-side and authorization is a domain rule: the appointment state machine
decides not just which transitions are legal but **who may make them**, checked over both
the REST and GraphQL surfaces.

TenantForge is intentionally narrow: its first workflow demonstrates how a multi-tenant
product can protect identity, scheduling, and authorization boundaries.

## Running it

```bash
npm install && npm run infra:up && cp apps/api/.env.example apps/api/.env && npm run dev
```

That is API plus infrastructure. Then apply migrations and start the frontend in a second
terminal:

```bash
npm run db:migrate && npm run dev:web
```

Migration 005 seeds two demo accounts — **outside production only**:

| Account | Email                  | Password            |
| ------- | ---------------------- | ------------------- |
| Doctor  | `doctor@clinic.test`   | `demo-password-123` |
| Patient | `patient@example.test` | `demo-password-123` |

The session decides which view you get: patients see the booking calendar, doctors see the
request inbox. There is no view switcher, because one session is one identity.

Two commands rather than one, deliberately: making it one means adding `concurrently` as a
dependency purely to avoid opening a terminal, and interleaved output from two servers is
harder to read than two windows.

`infra:up` uses `--wait`, so it returns only once MongoDB and Redis report healthy — the
API never races a replica set that is still electing a primary.

Verify:

```bash
curl -s localhost:3000/health | jq
```

`/health` is a readiness check — it pings MongoDB and Redis and returns **503** if either
is down, so an orchestrator stops routing traffic to a broken instance. `/health/live` is
liveness and deliberately checks nothing external. Both are `VERSION_NEUTRAL`: URI
versioning would otherwise move them to `/v1/health`, which is a probe path silently
breaking on a routing change (it did, for two phases).

Tear down (`-v` also drops the data volumes):

```bash
npm run infra:down
```

## Testing

Four tiers, fastest first. Each one exists because the tier below it cannot answer the
question.

| Tier            | Command                    | Needs Docker | What only it can tell you                                                                               |
| --------------- | -------------------------- | ------------ | ------------------------------------------------------------------------------------------------------- |
| **Unit**        | `npm test`                 | no           | The domain logic is right — interval algebra, DST, the state machine. Zero I/O.                         |
| **Integration** | `npm run test:integration` | yes          | The database actually enforces what the code assumes. The unique index, transactions, the outbox relay. |
| **Component**   | `npm test -w apps/web`     | no           | The UI renders and behaves, with the network mocked.                                                    |
| **E2E**         | `npm run test:e2e`         | yes          | The pieces agree with each other. Real browser, real API, real Mongo and Redis.                         |

Roughly: **165 API unit + 117 integration + 32 web + 8 e2e**. The shape is deliberate — the
e2e tier is eight tests, not eighty, because e2e tests are the slowest to run, the flakiest,
and the least specific about what broke. They cover journeys nothing else can:
patient→doctor→patient counter-proposal, slot release on decline, a genuine booking
conflict between two clients, and the authentication boundary.

The lifecycle tests run in **two browser contexts** — one per party, each with its own
cookie jar — because one session is one identity. That is a better test than the old
single-page version: it proves two different people can transact, not merely that two views
render.

The e2e suite pins the **browser** timezone to `America/New_York` while the clinic is in
`Europe/Lisbon`, so every test exercises the cross-timezone path rather than the trivial
same-zone case.

Other useful commands:

| Command                           | What it does                                      |
| --------------------------------- | ------------------------------------------------- |
| `npm run build`                   | Compile all workspaces                            |
| `npm run lint`                    | ESLint across the monorepo (incl. layering rules) |
| `npm run typecheck`               | `tsc --noEmit` per workspace, tests included      |
| `npm run db:migrate`              | Ordered migrations — a deploy step, never on boot |
| `npm run db:explain`              | `explain()` output for every indexed query        |
| `npm run test:e2e:ui`             | Playwright in watch/inspect mode                  |
| `npm run infra:up` / `infra:down` | MongoDB + Redis                                   |

## Architecture

```
apps/
  api/                        NestJS — REST and GraphQL over ONE service layer
    src/
      config/                 Zod-validated environment, parsed once at boot
      infra/                  MongoClient and Redis connection lifecycles
      shared/
        intervals/            timezone-free interval algebra on epoch millis
        time/                 the ONLY place a timezone is applied
        http/                 RFC 7807 problem+json
      persistence/            ordered migrations, explain scripts
      modules/                feature folders, not layer folders
        appointments/           domain state machine, service, REST controller
        availability/           derivation engine + Redis cache
        auth/                   sessions, guard, actor decorator, CSRF middleware
        doctors/  notifications/  outbox/  jobs/  graphql/  health/
  web/                        React 19 + Vite + TanStack Query + Tailwind v4
e2e/                          Playwright — roles and labels only, never CSS
deploy/cloudrun/              service.yaml
```

Layering is strict, one-directional, and **enforced by an ESLint rule** rather than by
convention:

```
controller / resolver  ->  service  ->  repository interface  ->  adapter
                                                                 ├─ MongoDB
                                                                 └─ in-memory (tests)
```

The service layer imports no HTTP types and no database driver. That is what lets the same
services back both APIs, and lets unit tests run against an in-memory adapter with no I/O.
Both adapters are held to **one shared contract suite**, so "it works in tests" and "it
works in production" are the same claim.

### Where authorization lives

`apps/api/src/modules/appointments/domain/state-machine.ts` — the transition table gained an
actor dimension:

```text
REQUESTED:        doctor: accept | decline | propose | cancel
                  patient: cancel
COUNTER_PROPOSED: doctor: cancel
                  patient: patientAccept | patientDecline | cancel
CONFIRMED:        doctor: cancel | complete
                  patient: cancel
```

`transition(appointment, event, actor)` is pure, so the whole rule set is enumerated rather
than sampled: 6 statuses × 2 roles × 7 events = **84 combinations**, all asserted. Two
distinct failures — not a party at all (**404**, so ids stay unenumerable) and a party
whose role may not do this (**403**). See [design rationale](design rationale).

### Where the double-booking guarantee lives

One line, in `apps/api/src/persistence/migrations/index.ts`:

```text
{ doctorId: 1, startsAt: 1 }
  unique: true
  partialFilterExpression: { status: { $in: [...ACTIVE_STATUSES] } }
```

A **partial** unique index on `(doctorId, startsAt)`. Unique, so two documents cannot claim
one slot. Partial, so cancelled appointments become invisible to the constraint and release
their time instead of burning it forever. Everything else — the service checks, the Redis
lock, the optimistic-concurrency branch — is contention management. See
[design rationale](design rationale).

## Local infrastructure note

MongoDB runs as a **single-node replica set**, not a standalone server. Multi-document
transactions require one, and both the booking write path and the transactional outbox
depend on them. Connecting from outside Docker needs `directConnection=true` in the URL —
otherwise the driver reads the replica set config, sees the member advertised under its
in-container hostname, and tries to reconnect through that instead of the published port.

## Deployment

Multi-stage Dockerfile, non-root, dev dependencies pruned; `deploy/cloudrun/service.yaml`
for Cloud Run. [`docs/cloud-mapping.md`](docs/cloud-mapping.md) maps every GCP service used
to its AWS and Azure equivalent and names where the analogy breaks.

Migrations run as a **separate job before** the new revision rolls out, never at startup —
several instances booting at once would race, and every migration is backwards-compatible
with the currently-running code because both versions serve traffic during a rollout.

## Known limitations

Named here rather than left to be discovered — the full list is at the end of
[`design rationale`](design rationale).

- **No self-service registration, password reset, email verification or MFA.** Accounts are
  seeded. Password reset in particular is where many auth systems are actually broken, and
  building it badly would be worse than not building it.
- **A counter-proposed slot is not reserved** while the patient decides. Documented, tested,
  and a genuine limit of a single-field unique index (design rationale).
- **Per-IP login rate limiting will misbehave behind a load balancer** — `request.ip` becomes
  the balancer's. Flagged in `auth.controller.ts` rather than guessed at.
- **No Content-Security-Policy.** The httpOnly cookie limits what an XSS can steal; a CSP is
  what would stop the XSS.
- `npm audit` reports four high-severity findings, all one transitive chain
  (`brace-expansion` DoS) reachable only through `@nestjs/cli`. Dev-only, and absent from
  the runtime container image.

import type { RedisService } from '../../infra/redis.service';
import { AvailabilityCache } from '../availability/application/availability.cache';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLModule as NestGraphQLModule } from '@nestjs/graphql';
import request from 'supertest';
import { DateTime } from 'luxon';
import {
  IDEMPOTENCY_STORE,
  InMemoryIdempotencyStore,
} from '../../shared/idempotency/idempotency.store';
import {
  DISTRIBUTED_LOCK,
  InMemoryDistributedLock,
} from '../../shared/locking/distributed-lock';
import { type MongoHarness, startMongoHarness } from '../../../test/mongo-harness';
import { AppointmentService } from '../appointments/application/appointment.service';
import { APPOINTMENT_REPOSITORY } from '../appointments/domain/appointment.repository';
import { MongoAppointmentRepository } from '../appointments/persistence/mongo-appointment.repository';
import { AvailabilityService } from '../availability/application/availability.service';
import {
  AVAILABILITY_REPOSITORY,
  type DoctorSchedule,
} from '../availability/domain/availability.repository';
import { MongoAvailabilityRepository } from '../availability/persistence/mongo-availability.repository';
import {
  DOCTOR_REPOSITORY,
  PATIENT_REPOSITORY,
} from '../doctors/domain/doctor.repository';
import {
  MongoDoctorRepository,
  MongoPatientRepository,
} from '../doctors/persistence/mongo-doctor.repository';
import {
  APPOINTMENT_UPDATED,
  AppointmentsResolver,
  DoctorResolver,
  pubSub,
} from './appointments.resolver';
import { ComplexityPlugin } from './complexity.plugin';
import cookieParser from 'cookie-parser';
import { createAuthHarness, type AuthHarness } from '../../../test/auth-harness';
import { createLoaders, type GraphQLContext, type Loaders } from './dataloaders';
import { MAX_DEPTH, depthLimit } from './query-guards';

jest.setTimeout(180_000);

let harness: MongoHarness;
let app: INestApplication;
let doctorRepo: MongoDoctorRepository;
let patientRepo: MongoPatientRepository;

/**
 * Switch used by one test to share a single set of loaders across requests, reproducing
 * what a module-scoped DataLoader would do. Default is per-request, as in production.
 */
let useSharedLoaders = false;
let sharedLoaders: Loaders | null = null;

const SLOT_BASE = DateTime.fromISO('2027-06-01T08:00', { zone: 'utc' });

const schedule: DoctorSchedule = {
  doctorId: 'doctor-1',
  timezone: 'Europe/Lisbon',
  slotDurationMinutes: 30,
  rules: [
    {
      id: 'rule-1',
      doctorId: 'doctor-1',
      weekday: 2,
      startTime: { hour: 9, minute: 0 },
      endTime: { hour: 13, minute: 0 },
      timezone: 'Europe/Lisbon',
    },
  ],
  exceptions: [],
};

beforeAll(async () => {
  harness = await startMongoHarness();
  doctorRepo = new MongoDoctorRepository(harness.mongoService);
  patientRepo = new MongoPatientRepository(harness.mongoService);
  auth = createAuthHarness();

  const moduleRef = await Test.createTestingModule({
    imports: [
      NestGraphQLModule.forRoot<ApolloDriverConfig>({
        driver: ApolloDriver,
        autoSchemaFile: true,
        sortSchema: true,
        validationRules: [depthLimit(MAX_DEPTH)],
        // `req` is threaded through so the global AuthGuard and @CurrentActor() can
        // reach it — exactly as graphql.module.ts does in production. Omitting it here
        // would make every GraphQL authorization test in this file fail for an
        // uninteresting reason.
        context: (ctx: { req?: unknown }): GraphQLContext => {
          if (useSharedLoaders) {
            sharedLoaders ??= createLoaders(doctorRepo, patientRepo);
            return { loaders: sharedLoaders, req: ctx.req };
          }
          return { loaders: createLoaders(doctorRepo, patientRepo), req: ctx.req };
        },
        formatError: (error) => ({
          message: error.message,
          extensions: { code: error.extensions?.code ?? 'INTERNAL_ERROR' },
        }),
      }),
    ],
    providers: [
      ...auth.providers,
      AppointmentsResolver,
      DoctorResolver,
      ComplexityPlugin,
      AppointmentService,
      AvailabilityService,
      {
        provide: APPOINTMENT_REPOSITORY,
        useValue: new MongoAppointmentRepository(harness.mongoService),
      },
      {
        provide: AVAILABILITY_REPOSITORY,
        useValue: new MongoAvailabilityRepository(harness.mongoService),
      },
      { provide: DOCTOR_REPOSITORY, useValue: () => doctorRepo },
      { provide: PATIENT_REPOSITORY, useValue: () => patientRepo },
      {
        // A pass-through cache. These suites assert HTTP and GraphQL behaviour; caching
        // has its own dedicated Redis-backed suite. A no-op keeps every read hitting the
        // real computation, so a caching bug can never make these tests pass falsely.
        provide: AvailabilityCache,
        useValue: new AvailabilityCache({
          client: {
            get: () => Promise.resolve(null),
            set: () => Promise.resolve('OK'),
            incr: () => Promise.resolve(1),
          },
        } as unknown as RedisService),
      },
      { provide: DISTRIBUTED_LOCK, useClass: InMemoryDistributedLock },
      { provide: IDEMPOTENCY_STORE, useClass: InMemoryIdempotencyStore },
    ],
  })
    .overrideProvider(DOCTOR_REPOSITORY)
    .useValue(doctorRepo)
    .overrideProvider(PATIENT_REPOSITORY)
    .useValue(patientRepo)
    .compile();

  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.listen(0);
});

afterAll(async () => {
  await app?.close();
  await harness?.stop();
});

beforeEach(async () => {
  await harness.reset();
  useSharedLoaders = false;
  sharedLoaders = null;

  auth.users.clear();
  auth.sessions.clear();
  doctorCookie = await auth.signIn('u-doctor', 'doctor', 'doctor-1');
  patientCookie = await auth.signIn('u-patient', 'patient', 'patient-1');
  doctorRepo.queries.reset();
  patientRepo.queries.reset();

  await new MongoAvailabilityRepository(harness.mongoService).saveSchedule(schedule);
  await doctorRepo.save({
    id: 'doctor-1',
    name: 'Dr Alice Reis',
    specialty: 'Cardiology',
    timezone: 'Europe/Lisbon',
  });
  await patientRepo.save({
    id: 'patient-1',
    name: 'Bruno Costa',
    timezone: 'Europe/Lisbon',
  });
});

let auth: AuthHarness;
let doctorCookie: string;
let patientCookie: string;

/**
 * Every GraphQL request is authenticated as the PATIENT by default, since that is who
 * reads the calendar. `gqlAs` overrides it, and `gqlAnonymous` sends no cookie at all —
 * used by the test asserting the guard covers the GraphQL surface.
 */
const gql = (query: string, variables?: Record<string, unknown>) =>
  gqlAs(patientCookie, query, variables);

const gqlAs = (cookie: string, query: string, variables?: Record<string, unknown>) =>
  request(app.getHttpServer())
    .post('/graphql')
    .set('Cookie', cookie)
    .send({ query, ...(variables ? { variables } : {}) });

/**
 * No cookie at all. The dedicated assertion that the guard covers GraphQL lives in
 * `auth.integration.spec.ts`; this stays here because these suites are where a future
 * "why is this query 401ing?" investigation starts.
 */
export const gqlAnonymous = (query: string, variables?: Record<string, unknown>) =>
  request(app.getHttpServer())
    .post('/graphql')
    .send({ query, ...(variables ? { variables } : {}) });

/** Seed N appointments on consecutive slots, all for the same doctor and patient. */
async function seedAppointments(count: number): Promise<void> {
  const repo = new MongoAppointmentRepository(harness.mongoService);
  for (let i = 0; i < count; i++) {
    const start = SLOT_BASE.plus({ minutes: 30 * i });
    await repo.create({
      id: `appt-${i}`,
      doctorId: 'doctor-1',
      patientId: 'patient-1',
      slot: { start: start.toMillis(), end: start.plus({ minutes: 30 }).toMillis() },
      createdAt: Date.now(),
      status: 'REQUESTED',
    });
  }
}

// ---------------------------------------------------------------------------
// THE N+1 PROOF
// ---------------------------------------------------------------------------
describe('DataLoader and the N+1 problem', () => {
  it('resolves 50 appointments with ONE doctor query, not 50', async () => {
    // The proof is a COUNT OF DATABASE QUERIES, not a timing measurement or a snapshot.
    // Timing is noisy and would pass for the wrong reason on a fast machine; counting
    // round trips measures the actual property.
    await seedAppointments(50);
    doctorRepo.queries.reset();
    patientRepo.queries.reset();

    const response = await gql(`
      query {
        appointments {
          id
          doctor { id name specialty }
          patient { id name }
        }
      }
    `);

    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.appointments).toHaveLength(50);
    // Every appointment resolved its doctor and patient...
    expect(response.body.data.appointments[0].doctor.name).toBe('Dr Alice Reis');
    expect(response.body.data.appointments[0].patient.name).toBe('Bruno Costa');

    // ...via exactly one batched query each. Without DataLoader this would be 50 and 50.
    expect(doctorRepo.queries.value).toBe(1);
    expect(patientRepo.queries.value).toBe(1);
  });

  it('costs ZERO doctor queries when only the id is requested', async () => {
    // GraphQL's actual selling point, and why the id stays on the type alongside the
    // resolved object: a client that does not need the doctor does not pay for one.
    await seedAppointments(50);
    doctorRepo.queries.reset();

    const response = await gql(`
      query { appointments { id doctorId } }
    `);

    expect(response.body.data.appointments).toHaveLength(50);
    expect(doctorRepo.queries.value).toBe(0);
  });

  it('FAILS the same way a naive resolver would if the loader is bypassed', async () => {
    // The control case. Calling the repository directly per appointment — which is what
    // a resolver without DataLoader does — costs one query each. This is the behaviour
    // the test above proves is absent.
    await seedAppointments(50);
    doctorRepo.queries.reset();

    const repo = new MongoAppointmentRepository(harness.mongoService);
    const appointments = await repo.find({ doctorId: 'doctor-1' });
    for (const appointment of appointments) {
      await doctorRepo.findById(appointment.doctorId);
    }

    expect(doctorRepo.queries.value).toBe(50);
  });

  it('deduplicates repeated ids within one request', async () => {
    // All 50 appointments share one doctor, so the batch contains 50 load() calls but
    // only 1 distinct key. DataLoader's cache collapses them before the batch function
    // is even called.
    await seedAppointments(50);
    doctorRepo.queries.reset();

    await gql(`query { appointments { doctor { name } } }`);

    expect(doctorRepo.queries.value).toBe(1);
  });
});

describe('per-request loader lifetime', () => {
  it('does NOT reuse cached records across separate requests', async () => {
    // The security property. Each request builds its own loaders, so a record cached
    // while serving one user is never served to another — which is what makes
    // field-level authorisation meaningful.
    await seedAppointments(5);
    doctorRepo.queries.reset();

    const query = `query { appointments { doctor { name } } }`;
    await gql(query);
    await gql(query);

    // One query per request. If the loaders were shared, the second request would be 0 —
    // serving the first request's cached data.
    expect(doctorRepo.queries.value).toBe(2);
  });

  it('a SHARED loader serves the second request from the first request cache', async () => {
    // Demonstrating the bug rather than only describing it. With module-scoped loaders
    // the second request costs zero queries because it is reading data fetched while
    // serving someone else — undetectable from the response, and a disclosure bug the
    // moment visibility depends on who is asking.
    await seedAppointments(5);
    useSharedLoaders = true;
    doctorRepo.queries.reset();

    const query = `query { appointments { doctor { name } } }`;
    await gql(query);
    const queriesAfterFirst = doctorRepo.queries.value;
    await gql(query);

    expect(queriesAfterFirst).toBe(1);
    // Zero additional queries: the second request never touched the database.
    expect(doctorRepo.queries.value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('query guards', () => {
  it('accepts a query within the depth limit', async () => {
    await seedAppointments(1);
    // Depth 3: appointments -> doctor -> id
    const response = await gql(`query { appointments { doctor { id } } }`);
    expect(response.body.errors).toBeUndefined();
  });

  it('REJECTS a query nested beyond the limit, and does no database work', async () => {
    await seedAppointments(1);
    doctorRepo.queries.reset();

    // The cyclic abuse case, made possible by Doctor.appointments. Depth 9, over the
    // limit of 7. Without a limit each level multiplies the resolver count and one
    // anonymous request becomes a denial of service.
    const response = await gql(`
      query {
        appointments {
          doctor {
            appointments {
              doctor {
                appointments {
                  doctor {
                    appointments { id }
                  }
                }
              }
            }
          }
        }
      }
    `);

    expect(response.body.errors).toBeDefined();
    // Apollo normalises EVERY validation-rule failure to GRAPHQL_VALIDATION_FAILED,
    // overriding the rule's own extensions. That is correct — depth limiting really is a
    // validation failure — so the assertion is on the message the rule produced.
    expect(response.body.errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
    expect(response.body.errors[0].message).toMatch(/too deep: \d+ exceeds/);

    // The critical assertion: validation runs BEFORE execution, so a rejected query
    // costs one parse and zero database round trips. Rejecting mid-execution would mean
    // the abuse had already partly succeeded.
    expect(doctorRepo.queries.value).toBe(0);
  });

  it('counts depth through FRAGMENTS rather than being evaded by them', async () => {
    // A limiter that only walks inline selections is trivially bypassed: hide the depth
    // behind a chain of named fragments and the query looks two levels deep.
    await seedAppointments(1);
    doctorRepo.queries.reset();

    const response = await gql(`
      query { appointments { doctor { ...deep } } }
      fragment deep on Doctor {
        appointments { doctor { appointments { doctor { appointments { id } } } } }
      }
    `);

    expect(response.body.errors).toBeDefined();
    expect(response.body.errors[0].message).toMatch(/too deep: \d+ exceeds/);
    expect(doctorRepo.queries.value).toBe(0);
  });

  it('REJECTS a shallow but wide query on complexity, which depth would allow', async () => {
    // The case depth limiting cannot catch. This query is only 4 levels deep — well
    // within MAX_DEPTH — but it requests a large number of fields via repeated aliases,
    // which is exactly the shallow-and-wide abuse shape.
    await seedAppointments(1);
    doctorRepo.queries.reset();

    const aliases = Array.from(
      { length: 300 },
      (_, i) => `a${i}: appointments { id status startsAt doctor { id name specialty } }`,
    ).join('\n');

    const response = await gql(`query { ${aliases} }`);

    expect(response.body.errors).toBeDefined();
    expect(response.body.errors[0].message).toMatch(/too complex: \d+ exceeds/);
    // Rejected at didResolveOperation, before any resolver ran.
    expect(doctorRepo.queries.value).toBe(0);
  });

  it('allows a query within the complexity budget', async () => {
    await seedAppointments(1);
    const response = await gql(`query { appointments { id doctor { name } } }`);
    expect(response.body.errors).toBeUndefined();
  });

  it('does not hang on a cyclic fragment', async () => {
    // The limiter must not become the denial of service it exists to prevent. A
    // self-referencing fragment is invalid GraphQL and is rejected — the point is that
    // it terminates rather than recursing forever.
    await seedAppointments(1);
    const response = await gql(`
      query { appointments { doctor { ...a } } }
      fragment a on Doctor { appointments { doctor { ...a } } }
    `);
    expect(response.body.errors).toBeDefined();
  });
});

describe('REST and GraphQL parity', () => {
  it('produces the same appointment state through both surfaces', async () => {
    // The premise of building both: identical behaviour, because both delegate to one
    // service layer. Any divergence here would mean the REST-vs-GraphQL comparison is
    // measuring my inconsistency instead of the technologies.
    const created = await gql(
      `mutation ($input: RequestAppointmentInputGql!) {
         requestAppointment(input: $input) { id status startsAt }
       }`,
      {
        input: {
          doctorId: 'doctor-1',
          startsAt: SLOT_BASE.toISO(),
          endsAt: SLOT_BASE.plus({ minutes: 30 }).toISO(),
        },
      },
    );

    expect(created.body.errors).toBeUndefined();
    const id = created.body.data.requestAppointment.id as string;
    expect(created.body.data.requestAppointment.status).toBe('REQUESTED');

    const viaGraphql = await gql(
      `query { appointment(id: "${id}") { status startsAt } }`,
    );
    expect(viaGraphql.body.data.appointment.startsAt).toBe('2027-06-01T08:00:00.000Z');
  });

  it('rejects a double booking with the same error vocabulary as REST', async () => {
    const input = {
      doctorId: 'doctor-1',
      startsAt: SLOT_BASE.toISO(),
      endsAt: SLOT_BASE.plus({ minutes: 30 }).toISO(),
    };
    const mutation = `mutation ($input: RequestAppointmentInputGql!) {
      requestAppointment(input: $input) { id }
    }`;

    await gql(mutation, { input });
    const second = await gql(mutation, { input });

    expect(second.body.errors).toBeDefined();
    // SLOT_UNAVAILABLE from the pre-check or SLOT_TAKEN from the index — the same two
    // outcomes REST produces, with the same names.
    expect(['SLOT_TAKEN', 'SLOT_UNAVAILABLE']).toContain(
      second.body.errors[0].extensions.code,
    );
  });

  it('reports an illegal transition with the shared code', async () => {
    const created = await gql(
      `mutation ($input: RequestAppointmentInputGql!) {
         requestAppointment(input: $input) { id }
       }`,
      {
        input: {
          doctorId: 'doctor-1',
          startsAt: SLOT_BASE.toISO(),
          endsAt: SLOT_BASE.plus({ minutes: 30 }).toISO(),
        },
      },
    );
    const id = created.body.data.requestAppointment.id as string;

    const completed = await gqlAs(
      doctorCookie,
      `mutation { completeAppointment(id: "${id}") { id status } }`,
    );

    expect(completed.body.errors[0].extensions.code).toBe('ILLEGAL_TRANSITION');
  });
});

describe('subscription publishing', () => {
  it('publishes an event when an appointment changes state', async () => {
    // Tests the publish PATH, not the WebSocket transport. That is a deliberate scope
    // choice: the transport is Apollo's and graphql-ws's code, already tested by them,
    // and driving a real WS client here would mostly exercise the test harness. What is
    // MINE and worth asserting is that every mutation publishes, and that the payload is
    // the mapped GraphQL type rather than a raw domain object.
    const received: { id: string; status: string }[] = [];
    // Cast because graphql-subscriptions types its iterator's `throw()` in a way
    // `for await` cannot narrow; the runtime shape is correct.
    const iterator = pubSub.asyncIterableIterator(
      APPOINTMENT_UPDATED,
    ) as AsyncIterableIterator<{ appointmentUpdated: { id: string; status: string } }>;

    const collecting = (async () => {
      for await (const event of iterator) {
        received.push(event.appointmentUpdated);
        if (received.length === 2) break;
      }
    })();

    const created = await gql(
      `mutation ($input: RequestAppointmentInputGql!) {
         requestAppointment(input: $input) { id }
       }`,
      {
        input: {
          doctorId: 'doctor-1',
          startsAt: SLOT_BASE.toISO(),
          endsAt: SLOT_BASE.plus({ minutes: 30 }).toISO(),
        },
      },
    );
    const id = created.body.data.requestAppointment.id as string;

    await gqlAs(
      doctorCookie,
      `mutation { acceptAppointment(id: "${id}") { id status } }`,
    );

    await collecting;

    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ id, status: 'REQUESTED' });
    expect(received[1]).toMatchObject({ id, status: 'CONFIRMED' });
  });

  // NOT COVERED HERE: the server-side subscription `filter`, which restricts events to
  // the appointment a client subscribed to. Asserting it meaningfully needs a real
  // WebSocket client — a locally re-declared copy of the predicate would only test
  // itself. Flagged as a gap rather than papered over; Phase 8's Playwright suite drives
  // a real client and is where it belongs.
});

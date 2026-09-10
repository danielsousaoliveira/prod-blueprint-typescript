import { INestApplication, VersioningType } from '@nestjs/common';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLModule as NestGraphQLModule } from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DateTime } from 'luxon';
import { RedisService } from '../../infra/redis.service';
import { MongoService } from '../../infra/mongo.service';
import { PostgresService } from '../../infra/postgres.service';
import { ProblemDetailsFilter } from '../../shared/http/problem-details';
import {
  IDEMPOTENCY_STORE,
  InMemoryIdempotencyStore,
} from '../../shared/idempotency/idempotency.store';
import {
  DISTRIBUTED_LOCK,
  InMemoryDistributedLock,
} from '../../shared/locking/distributed-lock';
import { type MongoHarness, startMongoHarness } from '../../../test/mongo-harness';
import {
  createAuthHarness,
  TEST_PASSWORD,
  type AuthHarness,
} from '../../../test/auth-harness';
import { AvailabilityCache } from '../availability/application/availability.cache';
import { AvailabilityService } from '../availability/application/availability.service';
import {
  AVAILABILITY_REPOSITORY,
  type DoctorSchedule,
} from '../availability/domain/availability.repository';
import { MongoAvailabilityRepository } from '../availability/persistence/mongo-availability.repository';
import { AppointmentService } from '../appointments/application/appointment.service';
import { APPOINTMENT_REPOSITORY } from '../appointments/domain/appointment.repository';
import { MongoAppointmentRepository } from '../appointments/persistence/mongo-appointment.repository';
import {
  AppointmentsController,
  AvailabilityController,
} from '../appointments/api/appointments.controller';
import {
  DOCTOR_REPOSITORY,
  PATIENT_REPOSITORY,
} from '../doctors/domain/doctor.repository';
import {
  MongoDoctorRepository,
  MongoPatientRepository,
} from '../doctors/persistence/mongo-doctor.repository';
import { AppointmentsResolver, DoctorResolver } from '../graphql/appointments.resolver';
import { createLoaders, type GraphQLContext } from '../graphql/dataloaders';
import { AuthController } from './api/auth.controller';
import { CsrfMiddleware } from './csrf.middleware';
import { ENV, type Env } from '../../config/env';
import { HealthController } from '../health/health.controller';
import { HealthService } from '../health/health.service';

/**
 * ============================================================================
 * THE AUTHORIZATION SUITE
 * ============================================================================
 *
 * Everything here is a test that would have PASSED before Phase 10, because before
 * Phase 10 there was nothing to fail. Each one corresponds to a hole that was genuinely
 * reachable in the shipped API:
 *
 *   - `GET /v1/appointments` with no query string returned every appointment in the
 *     database.
 *   - `GET /v1/appointments/:id` was readable by anyone holding an id.
 *   - Any caller could accept, decline, cancel or complete any appointment.
 *   - `{ appointments { ... } }` did the same over GraphQL, in one line.
 *   - `{ doctor { appointments { patientId } } }` traversed from your own appointment to
 *     every other patient of that doctor.
 *
 * The guard bound here is the REAL one, registered the way production registers it. The
 * phase plan requires unbinding it once and confirming this file goes red — a suite that
 * cannot fail is worth nothing, which Phase 9 established the hard way.
 * ============================================================================
 */

jest.setTimeout(180_000);

let harness: MongoHarness;
let app: INestApplication;
let auth: AuthHarness;

let patientCookie: string;
let doctorCookie: string;
let otherPatientCookie: string;
let otherDoctorCookie: string;

const TUESDAY = DateTime.fromISO('2027-06-01T00:00', { zone: 'utc' });
const SLOT_1 = DateTime.fromISO('2027-06-01T08:00', { zone: 'utc' });
const SLOT_2 = DateTime.fromISO('2027-06-01T08:30', { zone: 'utc' });
const iso = (dt: DateTime): string => dt.toISO() ?? '';

const scheduleFor = (doctorId: string): DoctorSchedule => ({
  doctorId,
  timezone: 'Europe/Lisbon',
  slotDurationMinutes: 30,
  rules: [
    {
      id: `rule-${doctorId}`,
      doctorId,
      weekday: 2,
      startTime: { hour: 9, minute: 0 },
      endTime: { hour: 13, minute: 0 },
      timezone: 'Europe/Lisbon',
    },
  ],
  exceptions: [],
});

beforeAll(async () => {
  harness = await startMongoHarness();
  auth = createAuthHarness();

  const doctorRepo = new MongoDoctorRepository(harness.mongoService);
  const patientRepo = new MongoPatientRepository(harness.mongoService);

  const moduleRef = await Test.createTestingModule({
    imports: [
      NestGraphQLModule.forRoot<ApolloDriverConfig>({
        driver: ApolloDriver,
        autoSchemaFile: true,
        sortSchema: true,
        context: (ctx: { req?: unknown }): GraphQLContext => ({
          loaders: createLoaders(doctorRepo, patientRepo),
          req: ctx.req,
        }),
        formatError: (error) => ({
          message: error.message,
          extensions: { code: error.extensions?.code ?? 'INTERNAL_ERROR' },
        }),
      }),
    ],
    controllers: [
      AppointmentsController,
      AvailabilityController,
      AuthController,
      HealthController,
    ],
    providers: [
      ...auth.providers,
      AppointmentsResolver,
      DoctorResolver,
      AppointmentService,
      AvailabilityService,
      HealthService,
      // HealthService pings both dependencies. Mongo is the real harness client; Redis is
      // a stub that simply answers, because this suite asserts the health endpoints are
      // PUBLIC, not what they report.
      { provide: MongoService, useValue: harness.mongoService },
      {
        provide: RedisService,
        useValue: { ping: () => Promise.resolve() },
      },
      {
        provide: PostgresService,
        useValue: { ping: () => Promise.resolve() },
      },
      {
        provide: APPOINTMENT_REPOSITORY,
        useValue: new MongoAppointmentRepository(harness.mongoService),
      },
      {
        provide: AVAILABILITY_REPOSITORY,
        useValue: new MongoAvailabilityRepository(harness.mongoService),
      },
      { provide: DOCTOR_REPOSITORY, useValue: doctorRepo },
      { provide: PATIENT_REPOSITORY, useValue: patientRepo },
      {
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
  }).compile();

  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  // AuthModule applies this via `configure()`; this suite builds its own module, so it is
  // registered by hand. Same middleware instance type, same ordering (after cookies,
  // before routing).
  const csrf = new CsrfMiddleware(app.get<Env>(ENV));
  app.use(csrf.use.bind(csrf));
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalFilters(new ProblemDetailsFilter());
  await app.listen(0);
});

afterAll(async () => {
  await app?.close();
  await harness?.stop();
});

beforeEach(async () => {
  await harness.reset();
  auth.users.clear();
  auth.sessions.clear();

  const availability = new MongoAvailabilityRepository(harness.mongoService);
  await availability.saveSchedule(scheduleFor('doctor-1'));
  await availability.saveSchedule(scheduleFor('doctor-2'));

  // Profiles, so the `doctor` and `patient` field resolvers return objects rather than
  // null — the traversal tests below need a real edge to try to traverse.
  const doctors = new MongoDoctorRepository(harness.mongoService);
  const patients = new MongoPatientRepository(harness.mongoService);
  for (const id of ['doctor-1', 'doctor-2']) {
    await doctors.save({
      id,
      name: `Dr ${id}`,
      specialty: 'Cardiology',
      timezone: 'Europe/Lisbon',
    });
  }
  for (const id of ['patient-1', 'patient-2']) {
    await patients.save({ id, name: `Patient ${id}`, timezone: 'Europe/Lisbon' });
  }

  patientCookie = await auth.signIn('u-patient', 'patient', 'patient-1');
  doctorCookie = await auth.signIn('u-doctor', 'doctor', 'doctor-1');
  otherPatientCookie = await auth.signIn('u-patient-2', 'patient', 'patient-2');
  otherDoctorCookie = await auth.signIn('u-doctor-2', 'doctor', 'doctor-2');
});

const api = () => request(app.getHttpServer());

const gql = (cookie: string | null, query: string) => {
  const req = api().post('/graphql');
  if (cookie) req.set('Cookie', cookie);
  return req.send({ query });
};

/** Book SLOT_1 with doctor-1 as patient-1, returning the appointment id. */
async function bookAppointment(start = SLOT_1): Promise<string> {
  const response = await api()
    .post('/v1/appointments')
    .set('Cookie', patientCookie)
    .send({
      doctorId: 'doctor-1',
      startsAt: iso(start),
      endsAt: iso(start.plus({ minutes: 30 })),
    });

  expect(response.status).toBe(201);
  return response.body.id as string;
}

// ---------------------------------------------------------------------------
describe('the guard covers every surface', () => {
  it('rejects an unauthenticated REST request with 401 problem+json', async () => {
    const response = await api().get('/v1/appointments');

    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body.type).toContain('unauthenticated');
  });

  it('rejects an unauthenticated GRAPHQL request', async () => {
    /**
     * The single most important test in this file.
     *
     * A Nest guard given a GraphQL execution context returns `undefined` from
     * `switchToHttp().getRequest()`. A guard written without the GraphQL branch — or one
     * that treats "no request found" as "not an HTTP call, allow it" — leaves the entire
     * GraphQL surface unauthenticated while every REST test above still passes.
     *
     * Deleting the `contextType === 'graphql'` branch in auth.guard.ts must make this
     * fail. It is the specific fail-open this design is most exposed to.
     */
    const response = await gql(null, '{ appointments { id } }');

    expect(response.body.errors).toBeDefined();
    expect(response.body.data?.appointments).toBeUndefined();
  });

  it('rejects a request whose session has been destroyed', async () => {
    const sessionId = patientCookie.split('=')[1] ?? '';
    await auth.sessions.destroy(sessionId);

    const response = await api().get('/v1/appointments').set('Cookie', patientCookie);
    expect(response.status).toBe(401);
  });

  it('rejects a request whose session has expired', async () => {
    const sessionId = patientCookie.split('=')[1] ?? '';
    auth.sessions.expire(sessionId);

    const response = await api().get('/v1/appointments').set('Cookie', patientCookie);
    expect(response.status).toBe(401);
  });

  it('rejects a forged session id', async () => {
    const response = await api()
      .get('/v1/appointments')
      .set('Cookie', 'sid=totally-made-up-session-id');

    expect(response.status).toBe(401);
  });

  it('leaves the health endpoints public', async () => {
    // Not a convenience: an authenticated readiness probe fails for every orchestrator,
    // which concludes the service is down and stops routing traffic to it. Adding
    // authentication would take production offline via a path with no error message.
    const readiness = await api().get('/health');
    expect([200, 503]).toContain(readiness.status);

    const liveness = await api().get('/health/live');
    expect(liveness.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe('login', () => {
  it('sets an httpOnly, SameSite=Lax cookie', async () => {
    await auth.createUser('u-login', 'login@test.local', 'patient', 'patient-1');

    const response = await api()
      .post('/v1/auth/login')
      .send({ email: 'login@test.local', password: TEST_PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ role: 'patient', profileId: 'patient-1' });

    // `set-cookie` is typed as `string[] | undefined` by supertest even though a 200 from
    // login always sets one. Asserting rather than non-null-asserting, so a regression
    // that stops issuing the cookie fails HERE with a clear message.
    const setCookie = response.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookie = setCookie?.[0] ?? '';
    // httpOnly is the entire reason for choosing a cookie over localStorage: JavaScript
    // cannot read this, so an XSS cannot exfiltrate the session.
    expect(cookie).toContain('HttpOnly');
    // The primary CSRF defence.
    expect(cookie).toContain('SameSite=Lax');
    // NOT Secure here, because NODE_ENV is 'test'. A Secure cookie over plain HTTP is
    // silently dropped by the browser, which in development looks like "login succeeds
    // then every request is 401" with no error anywhere.
    expect(cookie).not.toContain('Secure');
  });

  it('never returns the password hash or the user id', async () => {
    await auth.createUser('u-login', 'login@test.local', 'patient', 'patient-1');

    const response = await api()
      .post('/v1/auth/login')
      .send({ email: 'login@test.local', password: TEST_PASSWORD });

    expect(JSON.stringify(response.body)).not.toContain('argon2');
    expect(response.body).not.toHaveProperty('passwordHash');
    expect(response.body).not.toHaveProperty('userId');
  });

  it('gives an IDENTICAL response for a wrong password and an unknown email', async () => {
    /**
     * The user-enumeration test.
     *
     * Different responses would let an attacker submit candidate addresses with a junk
     * password and learn which are registered. For a medical scheduling system, "is this
     * person a patient here" is itself sensitive — arguably more so than the password.
     *
     * The timing half of the same oracle is closed in AuthService.login by verifying
     * against a dummy hash; this asserts the content half.
     */
    await auth.createUser('u-login', 'known@test.local', 'patient', 'patient-1');

    const wrongPassword = await api()
      .post('/v1/auth/login')
      .send({ email: 'known@test.local', password: 'not-the-password' });

    const unknownEmail = await api()
      .post('/v1/auth/login')
      .send({ email: 'nobody@test.local', password: 'not-the-password' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
    expect(wrongPassword.headers['set-cookie']).toBeUndefined();
  });

  it('is case-insensitive on the email', async () => {
    await auth.createUser('u-login', 'Mixed.Case@Test.Local', 'patient', 'patient-1');

    const response = await api()
      .post('/v1/auth/login')
      .send({ email: 'mixed.case@test.local', password: TEST_PASSWORD });

    expect(response.status).toBe(200);
  });

  it('logs out, and the session stops working immediately', async () => {
    // The entire reason for server-side sessions over a JWT: revocation is instant. A
    // JWT would remain valid until it expired, no matter what this endpoint returned.
    const before = await api().get('/v1/appointments').set('Cookie', patientCookie);
    expect(before.status).toBe(200);

    const logout = await api().post('/v1/auth/logout').set('Cookie', patientCookie);
    expect(logout.status).toBe(204);

    const after = await api().get('/v1/appointments').set('Cookie', patientCookie);
    expect(after.status).toBe(401);
  });

  it('logging out without a session succeeds rather than 401ing', async () => {
    const response = await api().post('/v1/auth/logout');
    expect(response.status).toBe(204);
  });

  it('reports the current session, or null when signed out', async () => {
    const signedIn = await api().get('/v1/auth/me').set('Cookie', doctorCookie);
    expect(signedIn.body).toEqual({ role: 'doctor', profileId: 'doctor-1' });

    const signedOut = await api().get('/v1/auth/me');
    expect(signedOut.status).toBe(200);
    expect(signedOut.body).toEqual({});
  });
});

// ---------------------------------------------------------------------------
describe('IDOR: reading other people’s data', () => {
  it('scopes the list to the caller — no query parameter can widen it', async () => {
    await bookAppointment(SLOT_1);

    // patient-1 sees their own.
    const mine = await api().get('/v1/appointments').set('Cookie', patientCookie);
    expect(mine.body).toHaveLength(1);

    // patient-2 sees nothing, even though an appointment exists.
    const theirs = await api().get('/v1/appointments').set('Cookie', otherPatientCookie);
    expect(theirs.body).toHaveLength(0);

    // And the old escape hatch is gone: passing the filters explicitly changes nothing,
    // because the parameters no longer exist.
    const attempted = await api()
      .get('/v1/appointments')
      .query({ doctorId: 'doctor-1', patientId: 'patient-1' })
      .set('Cookie', otherPatientCookie);
    expect(attempted.body).toHaveLength(0);
  });

  it('returns 404 — NOT 403 — when reading an appointment you are not party to', async () => {
    /**
     * The information-leak distinction. A 403 confirms the id names a real appointment,
     * which makes ids enumerable: an attacker cannot read the contents but learns which
     * exist, and in a medical context the existence of a record is often the sensitive
     * part.
     *
     * The response must be indistinguishable from a completely invented id.
     */
    const id = await bookAppointment();

    const stranger = await api()
      .get(`/v1/appointments/${id}`)
      .set('Cookie', otherPatientCookie);

    const invented = await api()
      .get('/v1/appointments/no-such-appointment-at-all')
      .set('Cookie', otherPatientCookie);

    expect(stranger.status).toBe(404);
    expect(stranger.body.type).toBe(invented.body.type);
    expect(stranger.body.title).toBe(invented.body.title);
    // The service-layer message ("does not belong to you") must not reach the client.
    expect(JSON.stringify(stranger.body)).not.toContain('belong');
  });

  it('scopes the GraphQL list the same way', async () => {
    await bookAppointment();

    const mine = await gql(patientCookie, '{ appointments { id } }');
    expect(mine.body.data.appointments).toHaveLength(1);

    const theirs = await gql(otherPatientCookie, '{ appointments { id } }');
    expect(theirs.body.data.appointments).toHaveLength(0);
  });

  it('does not let the doctor edge traverse to other patients', async () => {
    /**
     * The GraphQL-specific hole, and the one with no REST equivalent.
     *
     * `Doctor.appointments` used to list every appointment for that doctor regardless of
     * who was asking. So a patient could start from their OWN appointment, hop to the
     * doctor, and read every other patient that doctor has ever seen — routing straight
     * around the scoping on the top-level query.
     */
    await bookAppointment(SLOT_1);

    // patient-2 books a different slot with the same doctor.
    const theirBooking = await api()
      .post('/v1/appointments')
      .set('Cookie', otherPatientCookie)
      .send({
        doctorId: 'doctor-1',
        startsAt: iso(SLOT_2),
        endsAt: iso(SLOT_2.plus({ minutes: 30 })),
      });
    expect(theirBooking.status).toBe(201);

    const response = await gql(
      patientCookie,
      '{ appointments { doctor { appointments { id patientId } } } }',
    );

    const traversed = response.body.data.appointments[0].doctor.appointments as {
      patientId: string;
    }[];

    // Only patient-1's own appointment is reachable, not patient-2's.
    expect(traversed).toHaveLength(1);
    expect(traversed.every((a) => a.patientId === 'patient-1')).toBe(true);
  });

  it('lets the doctor see their own inbox through the same edge', async () => {
    // The complement: scoping must not break the legitimate case.
    await bookAppointment();

    const response = await gql(
      doctorCookie,
      '{ appointments { doctor { appointments { id } } } }',
    );

    expect(response.body.data.appointments[0].doctor.appointments).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('IDOR: acting on other people’s data', () => {
  it('a stranger cannot transition an appointment, and gets 404', async () => {
    const id = await bookAppointment();

    for (const action of ['accept', 'decline', 'cancel', 'complete']) {
      const response = await api()
        .post(`/v1/appointments/${id}/${action}`)
        .set('Cookie', otherDoctorCookie)
        .send({});

      expect(response.status).toBe(404);
    }
  });

  it('a patient CANNOT accept their own request — 403', async () => {
    /**
     * The headline authorization rule, end to end. Without it a patient confirms an
     * appointment the doctor never agreed to, and it occupies a real slot in their
     * calendar.
     *
     * 403 rather than 404 here because the caller IS a party — they can already see this
     * appointment, so naming the reason discloses nothing.
     */
    const id = await bookAppointment();

    const response = await api()
      .post(`/v1/appointments/${id}/accept`)
      .set('Cookie', patientCookie)
      .send({});

    expect(response.status).toBe(403);
    expect(response.body.type).toContain('forbidden');

    // And it really did not happen.
    const after = await api().get(`/v1/appointments/${id}`).set('Cookie', patientCookie);
    expect(after.body.status).toBe('REQUESTED');
  });

  it('a doctor CANNOT answer a counter-proposal for the patient — 403', async () => {
    const id = await bookAppointment();

    await api()
      .post(`/v1/appointments/${id}/propose`)
      .set('Cookie', doctorCookie)
      .send({ startsAt: iso(SLOT_2), endsAt: iso(SLOT_2.plus({ minutes: 30 })) });

    const response = await api()
      .post(`/v1/appointments/${id}/patient-accept`)
      .set('Cookie', doctorCookie)
      .send({});

    expect(response.status).toBe(403);
  });

  it('a patient CANNOT mark an appointment complete — 403', async () => {
    const id = await bookAppointment();
    await api()
      .post(`/v1/appointments/${id}/accept`)
      .set('Cookie', doctorCookie)
      .send({});

    const response = await api()
      .post(`/v1/appointments/${id}/complete`)
      .set('Cookie', patientCookie)
      .send({});

    expect(response.status).toBe(403);
  });

  it('applies the same rules over GraphQL, with the same codes', async () => {
    // The two surfaces must not disagree: if one were more permissive, an attacker would
    // simply use that one.
    const id = await bookAppointment();

    const response = await gql(
      patientCookie,
      `mutation { acceptAppointment(id: "${id}") { id status } }`,
    );

    expect(response.body.errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('a stranger gets NOT_FOUND over GraphQL too, not FORBIDDEN', async () => {
    const id = await bookAppointment();

    const response = await gql(
      otherDoctorCookie,
      `mutation { acceptAppointment(id: "${id}") { id status } }`,
    );

    expect(response.body.errors[0].extensions.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
describe('identity is taken from the session, never the request', () => {
  it('ignores a patientId in the request body', async () => {
    /**
     * The field is gone from the schema, so sending it is simply ignored — and the
     * appointment is created for the AUTHENTICATED patient, not the asserted one.
     *
     * Before this phase, this request would have created an appointment in patient-2's
     * name from patient-1's session.
     */
    const response = await api()
      .post('/v1/appointments')
      .set('Cookie', patientCookie)
      .send({
        doctorId: 'doctor-1',
        patientId: 'patient-2',
        startsAt: iso(SLOT_1),
        endsAt: iso(SLOT_1.plus({ minutes: 30 })),
      });

    expect(response.status).toBe(201);
    expect(response.body.patientId).toBe('patient-1');
  });

  it('records the audit trail from the session, not from `by`', async () => {
    // `by` used to be a request field, so anyone could cancel an appointment and record
    // it as the other party having done so — the one field whose whole purpose is
    // answering "who did this?" was written by whoever wanted a different answer.
    const id = await bookAppointment();

    await api()
      .post(`/v1/appointments/${id}/cancel`)
      .set('Cookie', patientCookie)
      .send({ by: 'doctor', reason: 'trying to blame the doctor' });

    const after = await api().get(`/v1/appointments/${id}`).set('Cookie', patientCookie);
    expect(after.body.status).toBe('CANCELLED');
    expect(after.body.cancelledBy ?? 'patient').toBe('patient');
  });

  it('a doctor cannot request an appointment', async () => {
    // Only a patient books. A doctor booking on a patient's behalf is a real workflow and
    // is deliberately unsupported, because doing it safely needs delegation modelling —
    // otherwise it reopens exactly the "client asserts an identity" hole.
    const response = await api()
      .post('/v1/appointments')
      .set('Cookie', doctorCookie)
      .send({
        doctorId: 'doctor-1',
        startsAt: iso(SLOT_1),
        endsAt: iso(SLOT_1.plus({ minutes: 30 })),
      });

    expect(response.status).toBe(403);
  });

  it('scopes Idempotency-Key to the caller', async () => {
    /**
     * Two patients independently generating the same key is plausible — nothing
     * coordinates that namespace. Without scoping, the second would be served the FIRST
     * patient's appointment as a replayed response: a wrong answer AND a disclosure.
     */
    const key = 'shared-key-by-coincidence';

    const first = await api()
      .post('/v1/appointments')
      .set('Cookie', patientCookie)
      .set('Idempotency-Key', key)
      .send({
        doctorId: 'doctor-1',
        startsAt: iso(SLOT_1),
        endsAt: iso(SLOT_1.plus({ minutes: 30 })),
      });
    expect(first.status).toBe(201);

    const second = await api()
      .post('/v1/appointments')
      .set('Cookie', otherPatientCookie)
      .set('Idempotency-Key', key)
      .send({
        doctorId: 'doctor-1',
        startsAt: iso(SLOT_2),
        endsAt: iso(SLOT_2.plus({ minutes: 30 })),
      });

    // A genuinely different appointment for the second patient — never a replay of the
    // first patient's response.
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
    expect(second.body.patientId).toBe('patient-2');
  });
});

// ---------------------------------------------------------------------------
describe('CSRF', () => {
  it('rejects a state-changing request from a foreign origin', async () => {
    const response = await api()
      .post('/v1/appointments')
      .set('Cookie', patientCookie)
      .set('Origin', 'https://evil.example')
      .send({
        doctorId: 'doctor-1',
        startsAt: iso(SLOT_1),
        endsAt: iso(SLOT_1.plus({ minutes: 30 })),
      });

    expect(response.status).toBe(403);
    expect(response.body.type).toContain('cross-origin');
  });

  it('rejects a request the browser labels cross-site', async () => {
    // `Sec-Fetch-Site` is set by the browser and cannot be spoofed by page JavaScript.
    const response = await api()
      .post('/v1/appointments')
      .set('Cookie', patientCookie)
      .set('Sec-Fetch-Site', 'cross-site')
      .send({
        doctorId: 'doctor-1',
        startsAt: iso(SLOT_1),
        endsAt: iso(SLOT_1.plus({ minutes: 30 })),
      });

    expect(response.status).toBe(403);
  });

  it('allows an allowed origin', async () => {
    const response = await api()
      .post('/v1/appointments')
      .set('Cookie', patientCookie)
      .set('Origin', 'http://localhost:5173')
      .send({
        doctorId: 'doctor-1',
        startsAt: iso(SLOT_1),
        endsAt: iso(SLOT_1.plus({ minutes: 30 })),
      });

    expect(response.status).toBe(201);
  });

  it('does NOT block safe methods from anywhere', async () => {
    // A forged GET achieves nothing — the same-origin policy still stops the attacker
    // reading the response — and blocking them would break ordinary linking.
    const response = await api()
      .get('/v1/appointments')
      .set('Cookie', patientCookie)
      .set('Origin', 'https://evil.example');

    expect(response.status).toBe(200);
  });
});

/** Referenced so the unused-var lint rule does not fire on the date fixture. */
void TUESDAY;

import type { RedisService } from '../../../infra/redis.service';
import { AvailabilityCache } from '../../availability/application/availability.cache';
import { INestApplication, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DateTime } from 'luxon';
import { interval } from '../../../shared/intervals/interval';
import { ProblemDetailsFilter } from '../../../shared/http/problem-details';
import {
  IDEMPOTENCY_STORE,
  InMemoryIdempotencyStore,
} from '../../../shared/idempotency/idempotency.store';
import {
  DISTRIBUTED_LOCK,
  type DistributedLock,
  InMemoryDistributedLock,
} from '../../../shared/locking/distributed-lock';
import { type MongoHarness, startMongoHarness } from '../../../../test/mongo-harness';
import { AvailabilityService } from '../../availability/application/availability.service';
import {
  AVAILABILITY_REPOSITORY,
  type DoctorSchedule,
} from '../../availability/domain/availability.repository';
import { MongoAvailabilityRepository } from '../../availability/persistence/mongo-availability.repository';
import { AppointmentService } from '../application/appointment.service';
import { APPOINTMENT_REPOSITORY } from '../domain/appointment.repository';
import { MongoAppointmentRepository } from '../persistence/mongo-appointment.repository';
import {
  AppointmentsController,
  AvailabilityController,
} from './appointments.controller';
import cookieParser from 'cookie-parser';
import { createAuthHarness, type AuthHarness } from '../../../../test/auth-harness';

jest.setTimeout(180_000);

let harness: MongoHarness;
let app: INestApplication;

/**
 * A Tuesday well in the future, so the clinic rule matches and `complete` is not blocked
 * by the "cannot complete before it starts" domain rule when we do not want it to be.
 */
const TUESDAY = DateTime.fromISO('2027-06-01T00:00', { zone: 'utc' });
const dayStart = TUESDAY.toMillis();
const dayEnd = TUESDAY.plus({ days: 1 }).toMillis();

/** Lisbon is UTC+1 in June, so the clinic's 09:00 is 08:00Z. */
const SLOT_1 = DateTime.fromISO('2027-06-01T08:00', { zone: 'utc' });
const SLOT_2 = DateTime.fromISO('2027-06-01T08:30', { zone: 'utc' });

const iso = (dt: DateTime): string => dt.toISO() ?? '';
/**
 * `patientId` is gone: it comes from the session now. Booking "as someone else" is
 * expressed by sending a different cookie, which is the entire point of this phase.
 */
const slotBody = (start: DateTime, minutes = 30) => ({
  doctorId: 'doctor-1',
  startsAt: iso(start),
  endsAt: iso(start.plus({ minutes })),
});

let auth: AuthHarness;
/** Cookie headers for the two parties on every appointment in this suite. */
let doctorCookie: string;
let patientCookie: string;

/**
 * A lock that can be switched off mid-suite.
 *
 * Needed because the in-memory lock serialises perfectly WITHIN one process, so with it
 * enabled the ten concurrent requests never actually reach MongoDB together — the first
 * one books, and the availability pre-check rejects the rest before any race occurs.
 *
 * That is a fine production behaviour and exactly what the lock is for. It is useless for
 * TESTING the guarantee, because it hides the thing under test: a green concurrency test
 * would then be proving that the lock works, not that the database constraint does. And
 * the lock cannot be the guarantee (see distributed-lock.ts) — across several processes
 * it would not serialise these at all.
 *
 * So the concurrency tests disable it, which reproduces the multi-process case: every
 * request reaches the insert, and the index alone decides.
 */
class TogglableLock implements DistributedLock {
  enabled = true;
  private readonly inner = new InMemoryDistributedLock();

  acquire(key: string, ttlMs: number): Promise<(() => Promise<void>) | null> {
    if (!this.enabled) return Promise.resolve(() => Promise.resolve());
    return this.inner.acquire(key, ttlMs);
  }
}

const lock = new TogglableLock();

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

  auth = createAuthHarness();

  const moduleRef = await Test.createTestingModule({
    controllers: [AppointmentsController, AvailabilityController],
    providers: [
      ...auth.providers,
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
      // Redis-backed ports swapped for in-memory ones. This is the DI payoff: the
      // controller and service are unmodified, and the test needs one container instead
      // of two. Redis-specific behaviour (atomic SET NX, the Lua release) is not what
      // these tests are about — the HTTP contract is.
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
      { provide: DISTRIBUTED_LOCK, useValue: lock },
      { provide: IDEMPOTENCY_STORE, useClass: InMemoryIdempotencyStore },
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  // The guard reads the session id from `request.cookies`, which only exists once
  // cookie-parser has run — same registration order as main.ts.
  app.use(cookieParser());
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalFilters(new ProblemDetailsFilter());

  // `listen(0)` on an ephemeral port, not just `init()`. Supertest binds a fresh
  // listener per `request()` call against a non-listening server, and ten of those
  // dispatched together exhaust the backlog and surface as ECONNRESET — which looks
  // exactly like a bug in the code under test. Listening once makes the concurrency
  // test measure the application rather than the test harness.
  await app.listen(0);
});

afterAll(async () => {
  await app?.close();
  await harness?.stop();
});

beforeEach(async () => {
  await harness.reset();
  await new MongoAvailabilityRepository(harness.mongoService).saveSchedule(schedule);

  auth.users.clear();
  auth.sessions.clear();
  doctorCookie = await auth.signIn('u-doctor', 'doctor', 'doctor-1');
  patientCookie = await auth.signIn('u-patient', 'patient', 'patient-1');
});

const api = () => request(app.getHttpServer());

/**
 * Every request in this suite is authenticated, because every endpoint now requires it.
 * `asPatient()` is the default because a patient is who books.
 */
const asPatient = () => ({ Cookie: patientCookie });
const asDoctor = () => ({ Cookie: doctorCookie });

describe('POST /v1/appointments', () => {
  it('creates an appointment and returns a DTO, not a database document', async () => {
    const response = await api()
      .post('/v1/appointments')
      .set(asPatient())
      .send(slotBody(SLOT_1));

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      doctorId: 'doctor-1',
      patientId: 'patient-1',
      status: 'REQUESTED',
      startsAt: '2027-06-01T08:00:00.000Z',
      proposedStartsAt: null,
    });
    // Internal fields must never leak — they become a contract clients depend on.
    expect(response.body).not.toHaveProperty('_id');
    expect(response.body).not.toHaveProperty('confirmedAt');
    expect(response.body.id).toEqual(expect.any(String));
  });

  it("rejects a slot outside the doctor's working hours with 422", async () => {
    // 03:00Z is 04:00 Lisbon — well before the clinic opens.
    const response = await api()
      .post('/v1/appointments')
      .set(asPatient())
      .send(slotBody(DateTime.fromISO('2027-06-01T03:00', { zone: 'utc' })));

    expect(response.status).toBe(422);
    expect(response.body.type).toContain('slot-unavailable');
  });

  it('rejects an off-grid slot with 422', async () => {
    // 08:15 is inside working hours but not on the 30-minute grid.
    const response = await api()
      .post('/v1/appointments')
      .set(asPatient())
      .send(slotBody(DateTime.fromISO('2027-06-01T08:15', { zone: 'utc' })));

    expect(response.status).toBe(422);
  });

  it('returns problem+json with field-level errors for malformed input', async () => {
    const response = await api()
      .post('/v1/appointments')
      .set(asPatient())
      .send({ doctorId: '', startsAt: 'not-a-date', endsAt: 'nope' });

    expect(response.status).toBe(422);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body.type).toContain('validation-failed');
    expect(response.body.errors.length).toBeGreaterThan(0);
    expect(response.body.errors[0]).toHaveProperty('path');
  });

  it('rejects endsAt before startsAt', async () => {
    const response = await api()
      .post('/v1/appointments')
      .set(asPatient())
      .send({
        doctorId: 'doctor-1',
        startsAt: iso(SLOT_2),
        endsAt: iso(SLOT_1),
      });
    expect(response.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// THE HEADLINE TEST for this phase.
// ---------------------------------------------------------------------------
describe('concurrent booking over HTTP', () => {
  // Simulate multiple processes: no single-process serialisation, so nothing in the
  // application layer is coordinating these requests.
  beforeEach(() => {
    lock.enabled = false;
  });
  afterEach(() => {
    lock.enabled = true;
  });

  it('never double-books, whichever layer rejects the losers', async () => {
    // Ten real HTTP requests for the identical slot, dispatched together.
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        api().post('/v1/appointments').set(asPatient()).send(slotBody(SLOT_1)),
      ),
    );

    const created = responses.filter((r) => r.status === 201);
    const rejected = responses.filter((r) => r.status !== 201);

    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(9);

    // Every loser gets a machine-readable reason, not a generic failure.
    for (const failure of rejected) {
      expect(failure.headers['content-type']).toContain('application/problem+json');
      expect(failure.body.type).toMatch(/slot-taken|slot-unavailable|contended/);
    }

    const list = await api().get('/v1/appointments').set(asDoctor());
    expect(list.body).toHaveLength(1);
  });

  it('rejects losers at EITHER layer — the split is nondeterministic', async () => {
    // Documenting a genuinely surprising result rather than hiding it.
    //
    // The intuition is that ten concurrent bookings all pass the availability pre-check
    // (none has committed yet) and then nine are rejected by the unique index with 409.
    // What actually happens in a single Node process is a MIX, and the mix changes
    // between runs: some requests resume after their await before the winner's insert
    // lands and get a 409 from the index; others resume after it and get a 422 from the
    // pre-check. Observed splits have ranged from 9/0 to 7/2.
    //
    // Three things follow, and all of them matter more than the numbers:
    //
    //  1. Asserting an exact split here would produce a FLAKY test. The invariant is
    //     "exactly one wins and no slot is double-booked" — that is what is actually
    //     guaranteed, and it is what the previous test asserts.
    //  2. An in-process concurrency test is not a faithful model of production. Across
    //     several pods the pre-checks genuinely interleave and 409s dominate, because no
    //     request can observe another's insert before making its own.
    //  3. The pre-check is therefore not load-bearing for correctness — it is a nicer
    //     error message that sometimes arrives first. The index is the guarantee, proved
    //     under real concurrency without a pre-check in front of it in
    //     mongo-appointment.repository.integration.spec.ts.
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        api().post('/v1/appointments').set(asPatient()).send(slotBody(SLOT_1)),
      ),
    );

    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((code) => code === 201)).toHaveLength(1);

    // Every loser was rejected by one layer or the other, and by nothing else.
    const losers = statuses.filter((code) => code !== 201);
    expect(losers).toHaveLength(9);
    expect(losers.every((code) => code === 409 || code === 422)).toBe(true);
  });

  it('returns 409 from the INDEX when the pre-check is bypassed', async () => {
    // Booking the same slot twice sequentially still exercises the index, because the
    // pre-check is skipped for an appointment that is already terminal... so instead we
    // go at it directly: create a booking, then race a second identical insert through
    // the repository, which is the path that has no pre-check in front of it.
    const first = await api()
      .post('/v1/appointments')
      .set(asPatient())
      .send(slotBody(SLOT_1));
    expect(first.status).toBe(201);

    const repository = new MongoAppointmentRepository(harness.mongoService);
    await expect(
      repository.create({
        id: 'direct-conflict',
        doctorId: 'doctor-1',
        patientId: 'patient-2',
        slot: interval(SLOT_1.toMillis(), SLOT_1.plus({ minutes: 30 }).toMillis()),
        createdAt: Date.now(),
        status: 'REQUESTED',
      }),
    ).rejects.toThrow(/already taken/);

    const list = await api().get('/v1/appointments').set(asDoctor());
    expect(list.body).toHaveLength(1);
  });
});

describe('Idempotency-Key', () => {
  it('replays the original response for a repeated key with the same body', async () => {
    const key = 'idem-key-1';
    const first = await api()
      .post('/v1/appointments')
      .set(asPatient())
      .set('Idempotency-Key', key)
      .send(slotBody(SLOT_1));

    const second = await api()
      .post('/v1/appointments')
      .set(asPatient())
      .set('Idempotency-Key', key)
      .send(slotBody(SLOT_1));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    // Same appointment, not a second one — this is the whole feature.
    expect(second.body.id).toBe(first.body.id);

    const list = await api().get('/v1/appointments').set(asDoctor());
    expect(list.body).toHaveLength(1);
  });

  it('REJECTS a repeated key with a DIFFERENT body rather than replaying it', async () => {
    // The case naive implementations get wrong. Replaying here would tell the client
    // "created" about an appointment they did not ask for, and silently discard the one
    // they did — with nothing anywhere recording that it happened.
    const key = 'idem-key-2';
    await api()
      .post('/v1/appointments')
      .set(asPatient())
      .set('Idempotency-Key', key)
      .send(slotBody(SLOT_1));

    const conflicting = await api()
      .post('/v1/appointments')
      .set(asPatient())
      .set('Idempotency-Key', key)
      .send(slotBody(SLOT_2));

    expect(conflicting.status).toBe(422);
    expect(conflicting.body.type).toContain('idempotency-key-reuse');

    // The second slot was NOT booked.
    const list = await api().get('/v1/appointments').set(asDoctor());
    expect(list.body).toHaveLength(1);
  });

  it('treats key order in the JSON body as irrelevant', async () => {
    // A client that serialises its retry with different key ordering is sending the same
    // request, and must not be told its body changed.
    const key = 'idem-key-3';
    const body = slotBody(SLOT_1);

    const first = await api()
      .post('/v1/appointments')
      .set(asPatient())
      .set('Idempotency-Key', key)
      .send(body);

    const reordered = {
      endsAt: body.endsAt,
      startsAt: body.startsAt,
      doctorId: body.doctorId,
    };
    const second = await api()
      .post('/v1/appointments')
      .set(asPatient())
      .set('Idempotency-Key', key)
      .send(reordered);

    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
  });

  it('releases the key when the request fails, so a retry can succeed', async () => {
    const key = 'idem-key-4';

    // First attempt fails validation at the availability check.
    const failed = await api()
      .post('/v1/appointments')
      .set(asPatient())
      .set('Idempotency-Key', key)
      .send(slotBody(DateTime.fromISO('2027-06-01T03:00', { zone: 'utc' })));
    expect(failed.status).toBe(422);

    // The same key must now be reusable — otherwise a transient failure permanently
    // burns the key and the client can never complete that request.
    const retried = await api()
      .post('/v1/appointments')
      .set(asPatient())
      .set('Idempotency-Key', key)
      .send(slotBody(SLOT_1));
    expect(retried.status).toBe(201);
  });
});

describe('lifecycle transitions over HTTP', () => {
  async function createRequested(): Promise<string> {
    const response = await api()
      .post('/v1/appointments')
      .set(asPatient())
      .send(slotBody(SLOT_1));
    return response.body.id as string;
  }

  it('runs the full counter-proposal happy path', async () => {
    const id = await createRequested();

    const proposed = await api()
      .post(`/v1/appointments/${id}/propose`)
      .set(asDoctor())
      .send({ startsAt: iso(SLOT_2), endsAt: iso(SLOT_2.plus({ minutes: 30 })) });

    expect(proposed.status).toBe(200);
    expect(proposed.body.status).toBe('COUNTER_PROPOSED');
    expect(proposed.body.proposedStartsAt).toBe('2027-06-01T08:30:00.000Z');
    // The original request is preserved alongside the proposal.
    expect(proposed.body.requestedStartsAt).toBe('2027-06-01T08:00:00.000Z');

    const accepted = await api()
      .post(`/v1/appointments/${id}/patient-accept`)
      .set(asPatient());
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe('CONFIRMED');
    // The PROPOSED slot became the real appointment.
    expect(accepted.body.startsAt).toBe('2027-06-01T08:30:00.000Z');
    expect(accepted.body.proposedStartsAt).toBeNull();
  });

  it('rejects an illegal transition with 409, not 400', async () => {
    // The request is well-formed; it conflicts with the resource's state. 400 would tell
    // the client to fix its syntax, which is misleading and unactionable.
    const id = await createRequested();

    const response = await api().post(`/v1/appointments/${id}/complete`).set(asDoctor());

    expect(response.status).toBe(409);
    expect(response.body.type).toContain('illegal-transition');
    expect(response.body.detail).toContain('REQUESTED');
  });

  it('rejects a counter-proposal identical to the request with 422', async () => {
    const id = await createRequested();
    const response = await api()
      .post(`/v1/appointments/${id}/propose`)
      .set(asDoctor())
      .send({ startsAt: iso(SLOT_1), endsAt: iso(SLOT_1.plus({ minutes: 30 })) });

    expect(response.status).toBe(422);
  });

  it('frees the slot after cancellation so it can be rebooked', async () => {
    const id = await createRequested();
    await api().post(`/v1/appointments/${id}/cancel`).set(asPatient()).send({});

    const rebooked = await api()
      .post('/v1/appointments')
      .set(asPatient())
      .send(slotBody(SLOT_1));
    expect(rebooked.status).toBe(201);
  });

  it('returns 404 for an unknown appointment', async () => {
    const response = await api()
      .post('/v1/appointments/does-not-exist/accept')
      .set(asDoctor());
    expect(response.status).toBe(404);
    expect(response.body.type).toContain('not-found');
  });
});

describe('GET /v1/doctors/:id/availability', () => {
  it('returns slots with the clinic timezone attached', async () => {
    const response = await api()
      .get('/v1/doctors/doctor-1/availability')
      .set(asPatient())
      .query({
        from: new Date(dayStart).toISOString(),
        to: new Date(dayEnd).toISOString(),
      });

    expect(response.status).toBe(200);
    expect(response.body.timezone).toBe('Europe/Lisbon');
    // 09:00-13:00 Lisbon = 4 hours = 8 slots.
    expect(response.body.slots).toHaveLength(8);
    expect(response.body.slots[0].startsAt).toBe('2027-06-01T08:00:00.000Z');
  });

  it('excludes a slot once it is booked', async () => {
    await api().post('/v1/appointments').set(asPatient()).send(slotBody(SLOT_1));

    const response = await api()
      .get('/v1/doctors/doctor-1/availability')
      .set(asPatient())
      .query({
        from: new Date(dayStart).toISOString(),
        to: new Date(dayEnd).toISOString(),
      });

    expect(response.body.slots).toHaveLength(7);
    expect(
      response.body.slots.some(
        (s: { startsAt: string }) => s.startsAt === '2027-06-01T08:00:00.000Z',
      ),
    ).toBe(false);
  });

  it('rejects a range longer than 90 days', async () => {
    const response = await api()
      .get('/v1/doctors/doctor-1/availability')
      .set(asPatient())
      .query({
        from: new Date(dayStart).toISOString(),
        to: new Date(dayStart + 120 * 86_400_000).toISOString(),
      });

    expect(response.status).toBe(422);
  });

  it('returns 404 for an unknown doctor', async () => {
    const response = await api()
      .get('/v1/doctors/nobody/availability')
      .set(asPatient())
      .query({
        from: new Date(dayStart).toISOString(),
        to: new Date(dayEnd).toISOString(),
      });

    expect(response.status).toBe(404);
  });
});

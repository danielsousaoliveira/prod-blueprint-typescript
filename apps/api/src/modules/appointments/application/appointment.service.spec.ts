import { InMemoryDistributedLock } from '../../../shared/locking/distributed-lock';
import type { AvailabilityCache } from '../../availability/application/availability.cache';
import { InMemoryAppointmentRepository } from '../persistence/in-memory-appointment.repository';
import { AppointmentService, events } from './appointment.service';
import type { Actor } from '../../auth/domain/user';

/**
 * Service tests with NO database, NO HTTP and NO container — microseconds per test.
 *
 * This is the return on the repository port and the DI container. The service under test
 * is completely unmodified; only its bound adapters differ. If the service imported
 * `MongoAppointmentRepository` directly (or Express types), none of this would be
 * possible and every one of these cases would need a container.
 */

const HOUR = 3_600_000;
const T0 = Date.UTC(2027, 5, 1, 9, 0);

/**
 * A cache stub that records invalidations.
 *
 * Not a mocking library — just an object implementing the methods the service calls, so
 * the tests can assert that every write path invalidates. A missed invalidation is the
 * classic cache bug and it is invisible without an assertion like this.
 */
function makeCache() {
  const invalidated: string[] = [];
  const cache = {
    get: () => Promise.resolve(null),
    set: () => Promise.resolve(),
    invalidate: (doctorId: string) => {
      invalidated.push(doctorId);
      return Promise.resolve();
    },
  } as unknown as AvailabilityCache;
  return { cache, invalidated };
}

function makeService() {
  const repository = new InMemoryAppointmentRepository();
  const lock = new InMemoryDistributedLock();
  const { cache, invalidated } = makeCache();
  return {
    service: new AppointmentService(repository, lock, cache),
    repository,
    invalidated,
  };
}

const booking = {
  doctorId: 'doctor-1',
  startsAt: T0,
  endsAt: T0 + HOUR,
};

/**
 * Actors for the fixtures.
 *
 * `patientId` is gone from `booking` — it comes from the actor now, so "book as a
 * different patient" is expressed by passing a different actor rather than by editing a
 * request body. That is the API change these tests are documenting.
 */
const DOCTOR: Actor = { userId: 'u-d1', role: 'doctor', profileId: 'doctor-1' };
const PATIENT: Actor = { userId: 'u-p1', role: 'patient', profileId: 'patient-1' };
const PATIENT_2: Actor = { userId: 'u-p2', role: 'patient', profileId: 'patient-2' };
const PATIENT_3: Actor = { userId: 'u-p3', role: 'patient', profileId: 'patient-3' };

describe('AppointmentService.request', () => {
  it('creates a REQUESTED appointment', async () => {
    const { service } = makeService();
    const result = await service.request(booking, PATIENT);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('REQUESTED');
      expect(result.value.slot).toEqual({ start: T0, end: T0 + HOUR });
      expect(result.value.id).toEqual(expect.any(String));
    }
  });

  it('returns SLOT_TAKEN rather than throwing when the slot is gone', async () => {
    // Errors as values: the caller cannot forget to handle this, because the compiler
    // will not let it read `.value` without checking `.ok` first.
    const { service } = makeService();
    await service.request(booking, PATIENT);
    const second = await service.request(booking, PATIENT_2);

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.kind).toBe('SLOT_TAKEN');
  });

  it('allows the same slot for a different doctor', async () => {
    const { service } = makeService();
    await service.request(booking, PATIENT);
    const other = await service.request({ ...booking, doctorId: 'doctor-2' }, PATIENT);
    expect(other.ok).toBe(true);
  });

  it('releases the lock after a failed booking so the slot is not stuck', async () => {
    // A lock leaked on the error path would make the slot unbookable until the TTL
    // expired — a bug that only shows up after a failure, which is exactly when you
    // least want a second one.
    const { service } = makeService();
    await service.request(booking, PATIENT);
    await service.request(booking, PATIENT_2);

    // Cancel the winner, then rebook: only possible if the lock was released.
    const all = await service.list(DOCTOR);
    await service.applyEvent(all[0]!.id, events.cancel('patient', T0), PATIENT);

    const rebooked = await service.request(booking, PATIENT_3);
    expect(rebooked.ok).toBe(true);
  });
});

describe('AppointmentService.applyEvent', () => {
  async function withRequested() {
    const { service, repository } = makeService();
    const created = await service.request(booking, PATIENT);
    if (!created.ok) throw new Error('setup failed');
    return { service, repository, id: created.value.id };
  }

  it('accepts a requested appointment', async () => {
    const { service, id } = await withRequested();
    const result = await service.applyEvent(id, events.accept(T0 - 60_000), DOCTOR);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('CONFIRMED');
  });

  it('rejects an illegal transition through the state machine', async () => {
    // The service does not re-implement the rules — it delegates to the Phase 2
    // transition function, so there is exactly one definition of what is legal.
    const { service, id } = await withRequested();
    const result = await service.applyEvent(id, events.complete(T0 + HOUR), DOCTOR);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('ILLEGAL_TRANSITION');
  });

  it('reports a missing appointment', async () => {
    const { service } = makeService();
    const result = await service.applyEvent('nope', events.accept(T0), DOCTOR);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('APPOINTMENT_NOT_FOUND');
  });

  it('runs the counter-proposal flow end to end', async () => {
    const { service, id } = await withRequested();
    const proposedSlot = { start: T0 + 2 * HOUR, end: T0 + 3 * HOUR };

    const proposed = await service.applyEvent(
      id,
      events.propose(proposedSlot, T0),
      DOCTOR,
    );
    expect(proposed.ok).toBe(true);

    const accepted = await service.applyEvent(id, events.patientAccept(T0), PATIENT);
    expect(accepted.ok).toBe(true);
    if (accepted.ok && accepted.value.status === 'CONFIRMED') {
      // The proposed slot became the appointment; the original is retained.
      expect(accepted.value.confirmedSlot).toEqual(proposedSlot);
      expect(accepted.value.slot).toEqual({ start: T0, end: T0 + HOUR });
    }
  });

  it('frees the slot after cancellation', async () => {
    const { service, id } = await withRequested();
    await service.applyEvent(id, events.cancel('patient', T0), PATIENT);

    const rebooked = await service.request(booking, PATIENT_2);
    expect(rebooked.ok).toBe(true);
  });

  it('rejects a second transition from a stale read (compare-and-set)', async () => {
    const { service, id } = await withRequested();

    // Two callers both read REQUESTED; both try to act. The second must not silently
    // overwrite the first.
    const first = await service.applyEvent(id, events.accept(T0 - 60_000), DOCTOR);
    const second = await service.applyEvent(id, events.decline('doctor', T0), DOCTOR);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });
});

describe('the distributed lock is not load-bearing', () => {
  it('still prevents double booking when the lock always grants', async () => {
    // Proving the claim in distributed-lock.ts: if the lock did nothing at all, the
    // repository constraint alone still holds. The lock is an optimisation, and this
    // test fails if anyone ever makes correctness depend on it.
    const repository = new InMemoryAppointmentRepository();
    const alwaysGrants = {
      acquire: () => Promise.resolve(() => Promise.resolve()),
    };
    const service = new AppointmentService(repository, alwaysGrants, makeCache().cache);

    const results = await Promise.all([
      service.request(booking, PATIENT),
      service.request(booking, PATIENT_2),
      service.request(booking, PATIENT_3),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});

describe('cache invalidation on every write path', () => {
  it('invalidates after a successful booking', async () => {
    const { service, invalidated } = makeService();
    await service.request(booking, PATIENT);
    expect(invalidated).toEqual(['doctor-1']);
  });

  it('does NOT invalidate when the booking failed', async () => {
    // Pins the ordering: invalidation belongs after a write that actually happened.
    const { service, invalidated } = makeService();
    await service.request(booking, PATIENT);
    invalidated.length = 0;

    await service.request(booking, PATIENT_2);
    expect(invalidated).toEqual([]);
  });

  it('invalidates after every transition, because any of them can free a slot', async () => {
    const { service, invalidated } = makeService();
    const created = await service.request(booking, PATIENT);
    if (!created.ok) throw new Error('setup failed');
    invalidated.length = 0;

    await service.applyEvent(created.value.id, events.cancel('patient', T0), PATIENT);
    expect(invalidated).toEqual(['doctor-1']);
  });
});

describe('outbox messages are emitted on every write path', () => {
  // These exist because the transition path silently shipped WITHOUT an outbox message
  // for a while: the code was written, an edit failed to apply, and every existing test
  // still passed. The repository-level outbox tests could not catch it because they call
  // the repository directly, bypassing the service that decides what to emit.
  it('emits a requested message when an appointment is booked', async () => {
    const { service, repository } = makeService();
    await service.request(booking, PATIENT);

    expect(repository.outbox).toHaveLength(1);
    expect(repository.outbox[0]).toMatchObject({
      type: 'appointment.requested',
      publishedAt: null,
    });
  });

  it('emits a message describing the RESULTING state of each transition', async () => {
    const { service, repository } = makeService();
    const created = await service.request(booking, PATIENT);
    if (!created.ok) throw new Error('setup failed');

    await service.applyEvent(created.value.id, events.accept(T0 - 60_000), DOCTOR);
    await service.applyEvent(created.value.id, events.cancel('patient', T0), PATIENT);

    expect(repository.outbox.map((m) => m.type)).toEqual([
      'appointment.requested',
      'appointment.confirmed',
      'appointment.cancelled',
    ]);
    // Every message carries the aggregate it describes, so a consumer can correlate.
    expect(repository.outbox.every((m) => m.aggregateId === created.value.id)).toBe(true);
  });

  it('emits NOTHING when the transition is rejected', async () => {
    const { service, repository } = makeService();
    const created = await service.request(booking, PATIENT);
    if (!created.ok) throw new Error('setup failed');
    repository.outbox.length = 0;

    // Illegal transition — rejected by the state machine before any write.
    await service.applyEvent(created.value.id, events.complete(T0 + HOUR), DOCTOR);

    expect(repository.outbox).toEqual([]);
  });

  it('emits NOTHING when the booking loses the slot', async () => {
    const { service, repository } = makeService();
    await service.request(booking, PATIENT);
    repository.outbox.length = 0;

    await service.request(booking, PATIENT_2);

    expect(repository.outbox).toEqual([]);
  });
});

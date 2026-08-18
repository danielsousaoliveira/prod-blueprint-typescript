import type { Interval } from '../../../shared/intervals/interval';
import type { OutboxMessage } from '../../outbox/domain/outbox';
import type { Appointment } from './appointment';

/**
 * The persistence port for appointments.
 *
 * Expressed entirely in domain types — no `ObjectId`, no `Filter<T>`, no `ClientSession`,
 * nothing from the MongoDB driver. That constraint is what makes the interface a genuine
 * boundary rather than a thin wrapper over the driver: if a driver type appeared in a
 * signature here, every consumer would transitively depend on MongoDB and the in-memory
 * adapter could not exist.
 *
 * Two adapters implement it: `MongoAppointmentRepository` for real, and
 * `InMemoryAppointmentRepository` for unit tests. Both are verified against the SAME
 * contract test suite, which is the only thing that stops the fake from drifting into a
 * more forgiving version of reality than the real one.
 */

/**
 * Raised when the slot uniqueness constraint rejects a write.
 *
 * This is a DOMAIN error, deliberately, even though only the MongoDB adapter can
 * originate it. The service layer must be able to handle "someone else took that slot"
 * without catching a driver-specific duplicate-key error — that translation happens
 * inside the adapter, which is the only place that knows what error code 11000 means.
 */
export class SlotTakenError extends Error {
  readonly kind = 'SLOT_TAKEN';

  constructor(
    readonly doctorId: string,
    readonly startsAt: number,
  ) {
    super(`Slot ${new Date(startsAt).toISOString()} is already taken for ${doctorId}`);
    this.name = 'SlotTakenError';
  }
}

/** Raised when an update targets an appointment that no longer exists. */
export class AppointmentNotFoundError extends Error {
  readonly kind = 'APPOINTMENT_NOT_FOUND';

  constructor(readonly id: string) {
    super(`Appointment ${id} not found`);
    this.name = 'AppointmentNotFoundError';
  }
}

export interface FindAppointmentsQuery {
  readonly doctorId?: string;
  readonly patientId?: string;
  /** Restrict to appointments whose held slot intersects this window. */
  readonly within?: Interval;
  /** When omitted, all statuses are returned. */
  readonly statuses?: readonly Appointment['status'][];
}

/** One row of the appointments-per-status-per-doctor-per-week aggregation. */
export interface AppointmentStatsRow {
  readonly doctorId: string;
  /** ISO week start (Monday 00:00 UTC) as an epoch millisecond value. */
  readonly weekStart: number;
  readonly status: Appointment['status'];
  readonly count: number;
}

export interface AppointmentRepository {
  /**
   * Insert a new appointment, optionally with outbox messages written ATOMICALLY
   * alongside it.
   *
   * The outbox parameter is what makes the transactional outbox real rather than
   * aspirational: the messages and the appointment commit together or not at all. If the
   * insert violates the unique index, the outbox row rolls back with it and no
   * notification is ever owed for a booking that did not happen.
   *
   * Throws `SlotTakenError` when the unique index rejects the write. That rejection —
   * not any check performed beforehand — is the double-booking guarantee.
   */
  create(
    appointment: Appointment,
    outbox?: readonly OutboxMessage[],
  ): Promise<Appointment>;

  /**
   * Persist a state transition.
   *
   * `expectedStatus` implements a compare-and-set: the update only applies if the stored
   * status still matches what the caller read. Without it, two concurrent requests could
   * both read a REQUESTED appointment and both write a transition, and the second would
   * silently overwrite the first — a lost update. With it, the second write matches zero
   * documents and the caller is told to retry.
   *
   * This is optimistic concurrency on the status field specifically, rather than a
   * general `version` counter. Phase 4 builds the full `version`-based variant on a
   * branch and documents the difference.
   */
  update(
    appointment: Appointment,
    expectedStatus: Appointment['status'],
    outbox?: readonly OutboxMessage[],
  ): Promise<Appointment>;

  findById(id: string): Promise<Appointment | null>;

  find(query: FindAppointmentsQuery): Promise<Appointment[]>;

  /** Appointments counted by status, per doctor, per ISO week. */
  statsByStatusPerWeek(range: Interval): Promise<AppointmentStatsRow[]>;
}

/** DI token. A symbol rather than a string so it cannot collide with another provider. */
export const APPOINTMENT_REPOSITORY = Symbol('APPOINTMENT_REPOSITORY');

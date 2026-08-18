import { interval } from '../../../shared/intervals/interval';
import type { Appointment, AppointmentStatus, Party } from '../domain/appointment';

/**
 * The stored shape of an appointment, and the mappers between it and the domain union.
 *
 * The document is FLAT where the domain is a discriminated union. That is deliberate:
 * MongoDB indexes fields, not variants, and the whole double-booking guarantee depends on
 * indexing `(doctorId, startsAt)`. A nested `{ confirmed: { slot: {...} } }` shape would
 * put the indexed field in a different path per status, which no single index can cover.
 *
 * So the mapping is not mechanical, and that is the point of having mappers at all:
 * the domain gets the shape that makes illegal states unrepresentable, and the database
 * gets the shape that makes the constraint enforceable. Neither compromises for the other.
 */

export interface AppointmentDocument {
  /** Domain id used directly as `_id` — see the note below. */
  _id: string;
  doctorId: string;
  patientId: string;

  /**
   * The slot CURRENTLY HELD, denormalised out of whichever union member holds it.
   *
   * This is the field the unique index covers, so it must always reflect the slot this
   * appointment is actually occupying:
   *   REQUESTED / COUNTER_PROPOSED -> the originally requested slot
   *   CONFIRMED / COMPLETED        -> the confirmed slot
   *
   * On `patientAccept` this is REWRITTEN to the proposed slot, which is what makes the
   * unique index catch a conflict at exactly the moment the counter-proposal is accepted.
   */
  startsAt: Date;
  endsAt: Date;

  status: AppointmentStatus;

  /** The patient's original request, retained for audit once `startsAt` moves. */
  requestedStartsAt: Date;
  requestedEndsAt: Date;

  createdAt: Date;

  // --- Per-status fields. Absent rather than null when not applicable. ---
  proposedStartsAt?: Date;
  proposedEndsAt?: Date;
  proposedAt?: Date;
  confirmedAt?: Date;
  declinedBy?: Party;
  declinedAt?: Date;
  cancelledBy?: Party;
  cancelledAt?: Date;
  cancelReason?: string;
  completedAt?: Date;
}

/**
 * Dates are stored as BSON `Date`, not as epoch numbers.
 *
 * The domain works in milliseconds because that keeps the interval algebra as plain
 * arithmetic. The database stores real dates because that is what makes range queries,
 * `$dateTrunc` in the aggregation pipeline, and anything read by a human in a Mongo shell
 * work correctly. Converting at the boundary costs nothing and keeps both sides idiomatic.
 */
const toDate = (ms: number): Date => new Date(ms);
const toMs = (date: Date): number => date.getTime();

/** Only include an optional key when it has a value — exactOptionalPropertyTypes. */
function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

export function toDocument(appointment: Appointment): AppointmentDocument {
  const held = heldSlotForStorage(appointment);

  const base: AppointmentDocument = {
    // The domain id IS the _id. Using a separate ObjectId plus a unique `id` field would
    // mean two indexes and two identities for one concept; MongoDB does not require _id
    // to be an ObjectId, only that it is unique and immutable.
    _id: appointment.id,
    doctorId: appointment.doctorId,
    patientId: appointment.patientId,
    startsAt: toDate(held.start),
    endsAt: toDate(held.end),
    status: appointment.status,
    requestedStartsAt: toDate(appointment.slot.start),
    requestedEndsAt: toDate(appointment.slot.end),
    createdAt: toDate(appointment.createdAt),
  };

  switch (appointment.status) {
    case 'REQUESTED':
      return base;
    case 'COUNTER_PROPOSED':
      return {
        ...base,
        proposedStartsAt: toDate(appointment.proposedSlot.start),
        proposedEndsAt: toDate(appointment.proposedSlot.end),
        proposedAt: toDate(appointment.proposedAt),
      };
    case 'CONFIRMED':
      return { ...base, confirmedAt: toDate(appointment.confirmedAt) };
    case 'DECLINED':
      return {
        ...base,
        declinedBy: appointment.declinedBy,
        declinedAt: toDate(appointment.declinedAt),
      };
    case 'CANCELLED':
      return {
        ...base,
        cancelledBy: appointment.cancelledBy,
        cancelledAt: toDate(appointment.cancelledAt),
        ...optional('cancelReason', appointment.reason),
      };
    case 'COMPLETED':
      return { ...base, completedAt: toDate(appointment.completedAt) };
  }
}

/**
 * Which slot this appointment occupies for indexing purposes.
 *
 * Note this is intentionally NOT `heldSlots()` from the domain, which returns BOTH slots
 * for a counter-proposal. A document has one indexed slot; the availability engine hides
 * the proposed slot from other patients as a courtesy, but the database constraint
 * applies to the held one. See design rationale — this is the known limit of a single-field
 * unique index, and the reason a `slot_holds` collection is the alternative.
 */
function heldSlotForStorage(appointment: Appointment): { start: number; end: number } {
  switch (appointment.status) {
    case 'CONFIRMED':
    case 'COMPLETED':
      return appointment.confirmedSlot;
    default:
      return appointment.slot;
  }
}

export class CorruptDocumentError extends Error {
  constructor(id: string, missing: string) {
    super(`Appointment document ${id} is missing required field '${missing}'`);
    this.name = 'CorruptDocumentError';
  }
}

function required<T>(id: string, field: string, value: T | undefined | null): T {
  if (value === undefined || value === null) throw new CorruptDocumentError(id, field);
  return value;
}

/**
 * Document -> domain.
 *
 * Throws rather than returning a partially-populated object when a status-specific field
 * is missing. A `CONFIRMED` document with no `confirmedAt` is corrupt — silently
 * defaulting it would launder a data bug into a plausible-looking appointment and push
 * the failure somewhere far away from the cause.
 */
export function toDomain(doc: AppointmentDocument): Appointment {
  const base = {
    id: doc._id,
    doctorId: doc.doctorId,
    patientId: doc.patientId,
    slot: interval(toMs(doc.requestedStartsAt), toMs(doc.requestedEndsAt)),
    createdAt: toMs(doc.createdAt),
  };

  switch (doc.status) {
    case 'REQUESTED':
      return { ...base, status: 'REQUESTED' };

    case 'COUNTER_PROPOSED':
      return {
        ...base,
        status: 'COUNTER_PROPOSED',
        proposedSlot: interval(
          toMs(required(doc._id, 'proposedStartsAt', doc.proposedStartsAt)),
          toMs(required(doc._id, 'proposedEndsAt', doc.proposedEndsAt)),
        ),
        proposedAt: toMs(required(doc._id, 'proposedAt', doc.proposedAt)),
      };

    case 'CONFIRMED':
      return {
        ...base,
        status: 'CONFIRMED',
        confirmedSlot: interval(toMs(doc.startsAt), toMs(doc.endsAt)),
        confirmedAt: toMs(required(doc._id, 'confirmedAt', doc.confirmedAt)),
      };

    case 'DECLINED':
      return {
        ...base,
        status: 'DECLINED',
        declinedBy: required(doc._id, 'declinedBy', doc.declinedBy),
        declinedAt: toMs(required(doc._id, 'declinedAt', doc.declinedAt)),
      };

    case 'CANCELLED':
      return {
        ...base,
        status: 'CANCELLED',
        cancelledBy: required(doc._id, 'cancelledBy', doc.cancelledBy),
        cancelledAt: toMs(required(doc._id, 'cancelledAt', doc.cancelledAt)),
        ...optional('reason', doc.cancelReason),
      };

    case 'COMPLETED':
      return {
        ...base,
        status: 'COMPLETED',
        confirmedSlot: interval(toMs(doc.startsAt), toMs(doc.endsAt)),
        completedAt: toMs(required(doc._id, 'completedAt', doc.completedAt)),
      };
  }
}

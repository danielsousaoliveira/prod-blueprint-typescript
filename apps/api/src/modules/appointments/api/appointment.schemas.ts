import { z } from 'zod';
import type { Appointment } from '../domain/appointment';

/**
 * Zod at the HTTP boundary, with TypeScript types INFERRED from the schemas.
 *
 * `z.infer` rather than a hand-written interface next to the schema is the whole point:
 * one source of truth. A parallel interface drifts the first time someone adds a field to
 * the schema and not the type, and the compiler cannot notice because both are valid.
 *
 * Validation happens once, at the edge. Everything past the controller works with data
 * that has already been proven to have the right shape, so the service layer contains no
 * defensive checks about types — only domain rules.
 */

/**
 * Instants cross the wire as ISO 8601 strings, not epoch numbers.
 *
 * A number is ambiguous — seconds or milliseconds? — and unreadable in a log or a curl.
 * An ISO string with an offset is unambiguous and self-describing. It is converted to an
 * epoch millisecond value here, at the boundary, so the domain keeps working in numbers.
 */
const isoInstant = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).getTime());

/**
 * Note there is no `patientId`.
 *
 * It used to be here, and removing it is the single most important schema change in this
 * phase. A field a client can set is a field a client can lie about, so `patientId` in a
 * request body meant anyone could book appointments in anyone else's name. The identity
 * now comes from the session.
 *
 * The general rule this is an instance of: **never accept an identifier for the caller
 * from the caller.** If the server can derive it, deriving it is not just safer, it also
 * removes a whole class of "which one wins" questions when the body and the session
 * disagree.
 */
export const requestAppointmentSchema = z
  .object({
    doctorId: z.string().min(1),
    startsAt: isoInstant,
    endsAt: isoInstant,
  })
  .refine((value) => value.endsAt > value.startsAt, {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  });

export type RequestAppointmentBody = z.infer<typeof requestAppointmentSchema>;

export const proposeSchema = z
  .object({
    startsAt: isoInstant,
    endsAt: isoInstant,
  })
  .refine((value) => value.endsAt > value.startsAt, {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  });

export type ProposeBody = z.infer<typeof proposeSchema>;

/**
 * `by` is gone from here too — the audit field is derived from the session (see the
 * comment on `events` in appointment.service.ts). `reason` stays: it is free text the
 * actor is writing about their own action, not a claim about who they are.
 */
export const cancelSchema = z.object({
  reason: z.string().max(500).optional(),
});

export type CancelBody = z.infer<typeof cancelSchema>;

/**
 * `declineSchema` has been deleted entirely rather than emptied. Its only field was `by`,
 * so an empty object schema would be a validation step that validates nothing while
 * suggesting the endpoint takes a body. `POST /v1/appointments/:id/decline` now takes no
 * body at all.
 */

/**
 * `doctorId` and `patientId` are gone.
 *
 * They were optional filters, which made `GET /v1/appointments` with no query string a
 * full table scan of every appointment in the system, returned to any caller. Scoping is
 * now derived from the session and there is no parameter that can widen it — see
 * `AppointmentService.list`.
 */
export const listQuerySchema = z.object({
  from: isoInstant.optional(),
  to: isoInstant.optional(),
});

export const availabilityQuerySchema = z
  .object({
    from: isoInstant,
    to: isoInstant,
  })
  .refine((value) => value.to > value.from, {
    message: 'to must be after from',
    path: ['to'],
  })
  .refine((value) => value.to - value.from <= 90 * 86_400_000, {
    // An unbounded window would let one request expand every recurring rule for years.
    // Bounding it at the boundary is cheaper than discovering it as a slow query.
    message: 'Range must not exceed 90 days',
    path: ['to'],
  });

// ---------------------------------------------------------------------------
// DTOs — the OUTPUT shape.
// ---------------------------------------------------------------------------

/**
 * A database document is never returned directly.
 *
 * Three reasons, and the third is the one that actually bites: internal fields leak
 * (`_id`, `requestedStartsAt`) and become a contract clients depend on; a schema change
 * silently becomes a breaking API change; and per-status fields would appear and
 * disappear from responses depending on state, so clients would have to reverse-engineer
 * the state machine to know which fields exist.
 *
 * The DTO is flat, total, and stable: every field is present in every state, with `null`
 * where it does not apply.
 */
export interface AppointmentDto {
  id: string;
  doctorId: string;
  patientId: string;
  status: Appointment['status'];
  /** The slot currently held, as an ISO instant. */
  startsAt: string;
  endsAt: string;
  /** What the patient originally asked for — differs after a counter-proposal. */
  requestedStartsAt: string;
  requestedEndsAt: string;
  /** Present only while COUNTER_PROPOSED; null otherwise. */
  proposedStartsAt: string | null;
  proposedEndsAt: string | null;
  createdAt: string;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export function toAppointmentDto(appointment: Appointment): AppointmentDto {
  const held =
    appointment.status === 'CONFIRMED' || appointment.status === 'COMPLETED'
      ? appointment.confirmedSlot
      : appointment.slot;

  const proposed =
    appointment.status === 'COUNTER_PROPOSED' ? appointment.proposedSlot : null;

  return {
    id: appointment.id,
    doctorId: appointment.doctorId,
    patientId: appointment.patientId,
    status: appointment.status,
    startsAt: iso(held.start),
    endsAt: iso(held.end),
    requestedStartsAt: iso(appointment.slot.start),
    requestedEndsAt: iso(appointment.slot.end),
    proposedStartsAt: proposed ? iso(proposed.start) : null,
    proposedEndsAt: proposed ? iso(proposed.end) : null,
    createdAt: iso(appointment.createdAt),
  };
}

import { graphql, rest } from '../../starter/api/client';

// ---------------------------------------------------------------------------
// Types mirroring the API contract.
// ---------------------------------------------------------------------------

export type AppointmentStatus =
  'REQUESTED' | 'CONFIRMED' | 'COUNTER_PROPOSED' | 'DECLINED' | 'CANCELLED' | 'COMPLETED';

export interface Appointment {
  id: string;
  doctorId: string;
  patientId: string;
  status: AppointmentStatus;
  startsAt: string;
  endsAt: string;
  requestedStartsAt: string;
  requestedEndsAt: string;
  proposedStartsAt: string | null;
  proposedEndsAt: string | null;
  createdAt: string;
}

export interface Slot {
  startsAt: string;
  endsAt: string;
}

export interface Availability {
  doctorId: string;
  timezone: string;
  slots: Slot[];
}

// ---------------------------------------------------------------------------
// The calendar query — GraphQL, one round trip.
// ---------------------------------------------------------------------------

const CALENDAR_QUERY = `
  query Calendar($input: AvailabilityInputGql!) {
    availabilityFor(input: $input) {
      doctorId
      timezone
      slots { startsAt endsAt }
    }
    # No arguments: the server scopes this to the signed-in user. The doctorId argument
    # was removed from the schema, so passing one is now a validation error rather than a
    # silently-ignored filter.
    appointments {
      id
      status
      startsAt
      endsAt
      requestedStartsAt
      requestedEndsAt
      proposedStartsAt
      proposedEndsAt
      createdAt
      doctorId
      patientId
      doctor { id name specialty }
    }
  }
`;

export interface CalendarData {
  availabilityFor: Availability | null;
  appointments: (Appointment & {
    doctor: { id: string; name: string; specialty: string } | null;
  })[];
}

export function fetchCalendar(
  doctorId: string,
  range: { from: string; to: string },
): Promise<CalendarData> {
  // Availability AND appointments AND the doctor, in ONE request. In REST this is three
  // round trips or a bespoke `?expand=` parameter.
  return graphql<CalendarData>(CALENDAR_QUERY, {
    input: { doctorId, from: range.from, to: range.to },
  });
}

// ---------------------------------------------------------------------------
// Mutations — REST, for status codes and idempotency.
// ---------------------------------------------------------------------------

export function requestAppointment(input: {
  doctorId: string;
  startsAt: string;
  endsAt: string;
  idempotencyKey: string;
}): Promise<Appointment> {
  const { idempotencyKey, ...body } = input;
  return rest<Appointment>('/v1/appointments', {
    method: 'POST',
    // Generated per booking ATTEMPT, not per retry, so a network-level retry of the same
    // attempt is deduplicated while a genuinely new booking gets a new key.
    headers: { 'idempotency-key': idempotencyKey },
    body: JSON.stringify(body),
  });
}

const transition = (id: string, action: string, body?: unknown) =>
  rest<Appointment>(`/v1/appointments/${id}/${action}`, {
    method: 'POST',
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

export const acceptAppointment = (id: string) => transition(id, 'accept');
// `by` is no longer sent: the server derives it from the session, because a client that
// can write the audit trail can write whatever it likes into it.
export const declineAppointment = (id: string) => transition(id, 'decline');
export const proposeNewTime = (id: string, slot: Slot) => transition(id, 'propose', slot);
export const patientAcceptProposal = (id: string) => transition(id, 'patient-accept');
export const patientDeclineProposal = (id: string) => transition(id, 'patient-decline');
export const cancelAppointment = (id: string, reason?: string) =>
  transition(id, 'cancel', reason ? { reason } : {});

/**
 * The caller's appointments. No filter parameters, because the server scopes by session —
 * `doctorId`/`patientId` were removed from the endpoint entirely (they used to let anyone
 * read the whole database).
 */
export const listAppointments = () => rest<Appointment[]>('/v1/appointments');

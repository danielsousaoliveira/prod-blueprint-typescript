import type { Interval } from '../../../shared/intervals/interval';

/**
 * The appointment entity, modelled as a DISCRIMINATED UNION over its status rather than
 * as one object with a status field and a pile of optional properties.
 *
 * The difference is not cosmetic. The naive shape:
 *
 *   interface Appointment {
 *     status: AppointmentStatus;
 *     proposedSlot?: Interval;   // only when COUNTER_PROPOSED
 *     cancelledBy?: Party;       // only when CANCELLED
 *   }
 *
 * ...makes every one of those fields optional in EVERY state, so `appointment.
 * proposedSlot` compiles when the appointment is `COMPLETED` and quietly yields
 * undefined. The comment saying "only when COUNTER_PROPOSED" is doing all the work, and
 * comments do not fail builds.
 *
 * With a union, `proposedSlot` exists only on the `COUNTER_PROPOSED` member. Reading it
 * without first narrowing on `status` is a compile error, and once narrowed it is
 * non-optional — no defensive `?? throw` at the point of use. Illegal states are not
 * merely discouraged; they cannot be constructed.
 */

export type AppointmentStatus =
  'REQUESTED' | 'CONFIRMED' | 'COUNTER_PROPOSED' | 'DECLINED' | 'CANCELLED' | 'COMPLETED';

/** Who acted. Needed because both sides can cancel, and the audit trail differs. */
export type Party = 'doctor' | 'patient';

export interface AppointmentBase {
  readonly id: string;
  readonly doctorId: string;
  readonly patientId: string;
  /** The slot originally requested by the patient, as UTC instants. */
  readonly slot: Interval;
  readonly createdAt: number;
}

export interface RequestedAppointment extends AppointmentBase {
  readonly status: 'REQUESTED';
}

export interface CounterProposedAppointment extends AppointmentBase {
  readonly status: 'COUNTER_PROPOSED';
  /** Non-optional: a counter-proposal without a proposed slot is unrepresentable. */
  readonly proposedSlot: Interval;
  readonly proposedAt: number;
}

export interface ConfirmedAppointment extends AppointmentBase {
  readonly status: 'CONFIRMED';
  /**
   * The slot that was actually agreed. Differs from `slot` when the patient accepted a
   * counter-proposal — which is exactly why this is a separate field rather than a
   * mutation of `slot`: the original request is retained for audit.
   */
  readonly confirmedSlot: Interval;
  readonly confirmedAt: number;
}

export interface DeclinedAppointment extends AppointmentBase {
  readonly status: 'DECLINED';
  readonly declinedBy: Party;
  readonly declinedAt: number;
}

export interface CancelledAppointment extends AppointmentBase {
  readonly status: 'CANCELLED';
  readonly cancelledBy: Party;
  readonly cancelledAt: number;
  readonly reason?: string;
}

export interface CompletedAppointment extends AppointmentBase {
  readonly status: 'COMPLETED';
  readonly confirmedSlot: Interval;
  readonly completedAt: number;
}

export type Appointment =
  | RequestedAppointment
  | CounterProposedAppointment
  | ConfirmedAppointment
  | DeclinedAppointment
  | CancelledAppointment
  | CompletedAppointment;

/**
 * States from which nothing further can happen. Kept as a value (not just a type) so the
 * repository can build the "active statuses" filter for the partial unique index in
 * Phase 3 from the same source of truth — a slot is only genuinely taken while the
 * appointment is in a non-terminal state.
 */
export const TERMINAL_STATUSES = ['DECLINED', 'CANCELLED', 'COMPLETED'] as const;

export const ACTIVE_STATUSES = ['REQUESTED', 'COUNTER_PROPOSED', 'CONFIRMED'] as const;

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];
export type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

export function isTerminal(appointment: Appointment): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(appointment.status);
}

/**
 * The slot that currently holds the doctor's time.
 *
 * Centralised because "which interval is this appointment actually occupying?" has a
 * different answer per state, and getting it wrong means the availability engine leaks a
 * slot that is really taken. The exhaustive switch below means adding a new status to the
 * union makes this a compile error rather than a silent `undefined`.
 */
export function occupiedSlot(appointment: Appointment): Interval | null {
  switch (appointment.status) {
    case 'REQUESTED':
      return appointment.slot;
    case 'COUNTER_PROPOSED':
      // Both are held: the original is not released until the patient responds, and the
      // proposed one must not be offered to someone else in the meantime. The caller
      // handles the second via `heldSlots`.
      return appointment.slot;
    case 'CONFIRMED':
      return appointment.confirmedSlot;
    case 'COMPLETED':
    case 'DECLINED':
    case 'CANCELLED':
      return null;
  }
}

/**
 * Every interval this appointment removes from the doctor's availability.
 *
 * A counter-proposed appointment holds TWO slots at once — the patient's original request
 * and the doctor's proposed alternative — because either could become the confirmed one.
 * Offering the proposed slot to another patient while the first is deciding is a race
 * that ends in a double booking.
 */
export function heldSlots(appointment: Appointment): Interval[] {
  if (appointment.status === 'COUNTER_PROPOSED') {
    return [appointment.slot, appointment.proposedSlot];
  }
  const slot = occupiedSlot(appointment);
  return slot ? [slot] : [];
}

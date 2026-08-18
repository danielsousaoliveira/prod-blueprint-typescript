import { interval } from '../../../shared/intervals/interval';
import type { Appointment, AppointmentStatus, Party } from './appointment';
import {
  ALLOWED_TRANSITIONS,
  type AppointmentEvent,
  type EventType,
  type TransitionActor,
  isParty,
  transition,
} from './state-machine';

/**
 * ============================================================================
 * AUTHORIZATION AS A DOMAIN RULE, TESTED EXHAUSTIVELY
 * ============================================================================
 *
 * This file exists separately from `state-machine.spec.ts` because it asks a different
 * question. That file asks "does the appointment reach the right state?"; this one asks
 * "may this person do that at all?".
 *
 * The whole point of putting authorization in the state machine rather than scattering
 * checks through the service layer is that it becomes a PURE FUNCTION — no database, no
 * session, no HTTP. Which means the entire rule set can be enumerated rather than
 * sampled: 6 statuses × 2 roles × 7 events = 84 combinations, every one asserted below
 * against the table.
 *
 * A sampled test ("a patient cannot accept") passes while an unnoticed hole sits two
 * rows away. There is no reason to sample something this cheap.
 * ============================================================================
 */

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 5, 2, 9, 0);
const slot = interval(T0, T0 + HOUR);
const otherSlot = interval(T0 + 2 * HOUR, T0 + 3 * HOUR);

const DOCTOR: TransitionActor = { role: 'doctor', profileId: 'doctor-1' };
const PATIENT: TransitionActor = { role: 'patient', profileId: 'patient-1' };

/** Neither of these is on the appointment under test. */
const OTHER_DOCTOR: TransitionActor = { role: 'doctor', profileId: 'doctor-99' };
const OTHER_PATIENT: TransitionActor = { role: 'patient', profileId: 'patient-99' };

const base = {
  id: 'appt-1',
  doctorId: 'doctor-1',
  patientId: 'patient-1',
  slot,
  createdAt: T0 - HOUR,
};

/** One appointment in each of the six states, all with the same two parties. */
const samples: Record<AppointmentStatus, Appointment> = {
  REQUESTED: { ...base, status: 'REQUESTED' },
  COUNTER_PROPOSED: {
    ...base,
    status: 'COUNTER_PROPOSED',
    proposedSlot: otherSlot,
    proposedAt: T0,
  },
  CONFIRMED: { ...base, status: 'CONFIRMED', confirmedSlot: slot, confirmedAt: T0 },
  DECLINED: { ...base, status: 'DECLINED', declinedBy: 'doctor', declinedAt: T0 },
  CANCELLED: { ...base, status: 'CANCELLED', cancelledBy: 'patient', cancelledAt: T0 },
  COMPLETED: {
    ...base,
    status: 'COMPLETED',
    confirmedSlot: slot,
    completedAt: T0 + HOUR,
  },
};

/**
 * One event of each type. Chosen so that a PERMITTED event also satisfies the domain
 * rules — `propose` uses a different slot, `complete` happens after the slot starts —
 * because otherwise a permitted-but-invalid event would fail for the wrong reason and
 * the test would prove nothing about authorization.
 */
const everyEvent: Record<EventType, AppointmentEvent> = {
  accept: { type: 'accept', at: T0 - 60_000 },
  decline: { type: 'decline', by: 'doctor', at: T0 },
  propose: { type: 'propose', slot: otherSlot, at: T0 },
  patientAccept: { type: 'patientAccept', at: T0 },
  patientDecline: { type: 'patientDecline', at: T0 },
  cancel: { type: 'cancel', by: 'doctor', at: T0 },
  complete: { type: 'complete', at: T0 + HOUR },
};

const STATUSES = Object.keys(samples) as AppointmentStatus[];
const EVENT_TYPES = Object.keys(everyEvent) as EventType[];
const ROLES: Party[] = ['doctor', 'patient'];

describe('the transition table is the single source of truth', () => {
  it.each(STATUSES)(
    'every role/event combination from %s matches the table',
    (status) => {
      const appointment = samples[status];

      for (const role of ROLES) {
        const actor = role === 'doctor' ? DOCTOR : PATIENT;
        const permitted = ALLOWED_TRANSITIONS[status][role] as readonly EventType[];

        for (const eventType of EVENT_TYPES) {
          const result = transition(
            appointment as never,
            everyEvent[eventType] as never,
            actor,
          );

          if (permitted.includes(eventType)) {
            // Must not be refused on AUTHORIZATION grounds. It may still fail a domain
            // rule, which is a different kind of error and not what this file tests.
            if (!result.ok) {
              expect(result.error.kind).not.toBe('ACTOR_NOT_PERMITTED');
              expect(result.error.kind).not.toBe('NOT_A_PARTY');
              expect(result.error.kind).not.toBe('ILLEGAL_TRANSITION');
            }
          } else {
            expect(result.ok).toBe(false);
          }
        }
      }
    },
  );

  it('covers all 84 combinations', () => {
    // Guards the guard: if someone adds a status or an event and forgets to extend the
    // fixtures above, the sweep would silently test less. Asserting the count makes that
    // impossible to miss.
    expect(STATUSES).toHaveLength(6);
    expect(EVENT_TYPES).toHaveLength(7);
    expect(STATUSES.length * EVENT_TYPES.length * ROLES.length).toBe(84);
  });
});

describe('the specific rules worth naming', () => {
  it('a patient CANNOT accept their own request', () => {
    // The headline rule. Without it, a patient confirms an appointment the doctor has
    // never agreed to, and it occupies a real slot in the doctor's calendar.
    const result = transition(
      samples.REQUESTED as never,
      everyEvent.accept as never,
      PATIENT,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('ACTOR_NOT_PERMITTED');
  });

  it('a doctor CANNOT answer a counter-proposal on the patient’s behalf', () => {
    for (const eventType of ['patientAccept', 'patientDecline'] as const) {
      const result = transition(
        samples.COUNTER_PROPOSED as never,
        everyEvent[eventType] as never,
        DOCTOR,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('ACTOR_NOT_PERMITTED');
    }
  });

  it('a patient CANNOT mark an appointment complete', () => {
    // Not merely a permissions question: `completedAt` is a clinical record, and the
    // stats aggregation counts it.
    const result = transition(
      samples.CONFIRMED as never,
      everyEvent.complete as never,
      PATIENT,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('ACTOR_NOT_PERMITTED');
  });

  it('BOTH parties can cancel, from every non-terminal state', () => {
    // The one genuinely symmetric right, and worth asserting explicitly so a future
    // tightening of the table cannot silently remove a patient's ability to cancel.
    for (const status of ['REQUESTED', 'COUNTER_PROPOSED', 'CONFIRMED'] as const) {
      for (const actor of [DOCTOR, PATIENT]) {
        const result = transition(
          samples[status] as never,
          everyEvent.cancel as never,
          actor,
        );
        expect(result.ok).toBe(true);
      }
    }
  });
});

describe('party membership', () => {
  it('rejects a stranger before considering the transition at all', () => {
    // Ordering matters: a non-party must not learn whether the event WOULD have been
    // legal. `accept` from REQUESTED is legal for a doctor, so if the party check ran
    // second, this would return ILLEGAL_TRANSITION or succeed — either of which tells
    // the stranger something about an appointment that is not theirs.
    const result = transition(
      samples.REQUESTED as never,
      everyEvent.accept as never,
      OTHER_DOCTOR,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('NOT_A_PARTY');
  });

  it('rejects a stranger even for an event that is illegal anyway', () => {
    // The complement of the test above: NOT_A_PARTY must win over ILLEGAL_TRANSITION in
    // both directions, or the error kind itself becomes an oracle for the appointment's
    // current state.
    const result = transition(
      samples.COMPLETED as never,
      everyEvent.accept as never,
      OTHER_PATIENT,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('NOT_A_PARTY');
  });

  it('matches the id belonging to the actor’s own role, not either id', () => {
    // A doctor whose profileId happens to equal the PATIENT's id is not a party. Ids come
    // from two independently-generated collections, so a collision is possible, and a
    // check written as `id === doctorId || id === patientId` would let it through as the
    // wrong party entirely.
    const confusable: TransitionActor = { role: 'doctor', profileId: 'patient-1' };

    expect(isParty(samples.REQUESTED, confusable)).toBe(false);
    expect(isParty(samples.REQUESTED, DOCTOR)).toBe(true);
    expect(isParty(samples.REQUESTED, PATIENT)).toBe(true);
  });
});

import { interval } from '../../../shared/intervals/interval';
import type {
  Appointment,
  ConfirmedAppointment,
  CounterProposedAppointment,
  RequestedAppointment,
} from './appointment';
import { ACTIVE_STATUSES, heldSlots, isTerminal, occupiedSlot } from './appointment';
import {
  ALLOWED_TRANSITIONS,
  type AppointmentEvent,
  type TransitionActor,
  transition,
} from './state-machine';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 5, 2, 9, 0);
const slot = interval(T0, T0 + HOUR);
const otherSlot = interval(T0 + 2 * HOUR, T0 + 3 * HOUR);

const requested: RequestedAppointment = {
  id: 'appt-1',
  doctorId: 'doctor-1',
  patientId: 'patient-1',
  slot,
  createdAt: T0 - HOUR,
  status: 'REQUESTED',
};

/**
 * The two parties on the fixtures above. Phase 10 made `transition` actor-aware, so every
 * call needs one.
 */
export const DOCTOR: TransitionActor = { role: 'doctor', profileId: 'doctor-1' };
export const PATIENT: TransitionActor = { role: 'patient', profileId: 'patient-1' };

/**
 * Helper that unwraps a successful transition, failing loudly otherwise.
 *
 * The actor defaults to whichever party may legally raise the event, so the pre-existing
 * tests here keep testing what they were written to test — state transitions — rather
 * than becoming authorization tests by accident. Authorization has its own exhaustive
 * spec (`state-machine.authz.spec.ts`), and mixing the two would leave both weaker.
 */
function apply(
  appointment: Appointment,
  event: AppointmentEvent,
  actor: TransitionActor = actorFor(event),
): Appointment {
  const result = transition(appointment as never, event as never, actor);
  if (!result.ok) throw new Error(`Expected success, got ${result.error.message}`);
  return result.value;
}

/** The party that owns each event, per ALLOWED_TRANSITIONS. */
function actorFor(event: AppointmentEvent): TransitionActor {
  return event.type === 'patientAccept' || event.type === 'patientDecline'
    ? PATIENT
    : DOCTOR;
}

describe('legal transitions', () => {
  it('REQUESTED --accept--> CONFIRMED, keeping the requested slot', () => {
    const next = apply(requested, { type: 'accept', at: T0 - 60_000 });
    expect(next.status).toBe('CONFIRMED');
    expect((next as ConfirmedAppointment).confirmedSlot).toEqual(slot);
  });

  it('REQUESTED --decline--> DECLINED, recording who declined', () => {
    const next = apply(requested, { type: 'decline', by: 'doctor', at: T0 });
    expect(next.status).toBe('DECLINED');
    expect(next).toMatchObject({ declinedBy: 'doctor' });
  });

  it('REQUESTED --propose--> COUNTER_PROPOSED', () => {
    const next = apply(requested, { type: 'propose', slot: otherSlot, at: T0 });
    expect(next.status).toBe('COUNTER_PROPOSED');
    expect((next as CounterProposedAppointment).proposedSlot).toEqual(otherSlot);
    // The original request is retained rather than overwritten — needed for audit and
    // for the patient to see what they asked for versus what was offered.
    expect(next.slot).toEqual(slot);
  });

  it('COUNTER_PROPOSED --patientAccept--> CONFIRMED on the PROPOSED slot', () => {
    const proposed = apply(requested, { type: 'propose', slot: otherSlot, at: T0 });
    const confirmed = apply(proposed, { type: 'patientAccept', at: T0 });

    expect(confirmed.status).toBe('CONFIRMED');
    // The critical assertion: the doctor's alternative becomes the real appointment.
    // Confirming the patient's ORIGINAL slot here would book a time the doctor
    // explicitly said they could not do.
    expect((confirmed as ConfirmedAppointment).confirmedSlot).toEqual(otherSlot);
    expect(confirmed.slot).toEqual(slot);
  });

  it('COUNTER_PROPOSED --patientDecline--> DECLINED, attributed to the patient', () => {
    const proposed = apply(requested, { type: 'propose', slot: otherSlot, at: T0 });
    const next = apply(proposed, { type: 'patientDecline', at: T0 });
    expect(next).toMatchObject({ status: 'DECLINED', declinedBy: 'patient' });
  });

  it('CONFIRMED --complete--> COMPLETED once the slot has started', () => {
    const confirmed = apply(requested, { type: 'accept', at: T0 - 60_000 });
    const next = apply(confirmed, { type: 'complete', at: T0 + HOUR });
    expect(next.status).toBe('COMPLETED');
  });

  it('both parties can cancel a CONFIRMED appointment', () => {
    const confirmed = apply(requested, { type: 'accept', at: T0 - 60_000 });
    for (const by of ['doctor', 'patient'] as const) {
      const next = apply(confirmed, { type: 'cancel', by, at: T0 });
      expect(next).toMatchObject({ status: 'CANCELLED', cancelledBy: by });
    }
  });

  it('omits `reason` entirely when none is given', () => {
    // exactOptionalPropertyTypes: an absent property and one set to undefined are
    // different documents once this reaches MongoDB.
    const next = apply(requested, { type: 'cancel', by: 'patient', at: T0 });
    expect('reason' in next).toBe(false);
  });

  it('keeps `reason` when given', () => {
    const next = apply(requested, {
      type: 'cancel',
      by: 'patient',
      at: T0,
      reason: 'feeling better',
    });
    expect(next).toMatchObject({ reason: 'feeling better' });
  });
});

describe('illegal transitions are rejected at runtime', () => {
  // The runtime guard is what protects appointments loaded from the database, where the
  // status is the full union and the compiler cannot narrow it.

  it('cannot complete an appointment that was never confirmed', () => {
    const result = transition(
      requested as never,
      {
        type: 'complete',
        at: T0 + HOUR,
      } as never,
      DOCTOR,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('ILLEGAL_TRANSITION');
    }
  });

  it('cannot accept an already-confirmed appointment (no double confirmation)', () => {
    const confirmed = apply(requested, { type: 'accept', at: T0 - 60_000 });
    const result = transition(
      confirmed as never,
      { type: 'accept', at: T0 } as never,
      DOCTOR,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects EVERY event from EVERY terminal state', () => {
    // Exhaustive rather than illustrative: terminal really means terminal. A resurrected
    // cancelled appointment would re-occupy a slot that has since been given away.
    const terminals: Appointment[] = [
      apply(requested, { type: 'decline', by: 'doctor', at: T0 }),
      apply(requested, { type: 'cancel', by: 'patient', at: T0 }),
      apply(apply(requested, { type: 'accept', at: T0 - 60_000 }), {
        type: 'complete',
        at: T0 + HOUR,
      }),
    ];

    const everyEvent: AppointmentEvent[] = [
      { type: 'accept', at: T0 },
      { type: 'decline', by: 'doctor', at: T0 },
      { type: 'propose', slot: otherSlot, at: T0 },
      { type: 'patientAccept', at: T0 },
      { type: 'patientDecline', at: T0 },
      { type: 'cancel', by: 'doctor', at: T0 },
      { type: 'complete', at: T0 },
    ];

    for (const appointment of terminals) {
      expect(isTerminal(appointment)).toBe(true);
      for (const event of everyEvent) {
        // Both parties, because terminal must mean terminal for everyone.
        for (const actor of [DOCTOR, PATIENT]) {
          const result = transition(appointment as never, event as never, actor);
          expect(result.ok).toBe(false);
        }
      }
    }
  });

  it('every state/event pair matches the transition table exactly', () => {
    // A table-driven sweep over the whole machine, so a transition added to
    // ALLOWED_TRANSITIONS without a handler — or a handler without a table entry —
    // fails here rather than in production.
    const samples: Record<string, Appointment> = {
      REQUESTED: requested,
      COUNTER_PROPOSED: apply(requested, { type: 'propose', slot: otherSlot, at: T0 }),
      CONFIRMED: apply(requested, { type: 'accept', at: T0 - 60_000 }),
      DECLINED: apply(requested, { type: 'decline', by: 'doctor', at: T0 }),
      CANCELLED: apply(requested, { type: 'cancel', by: 'patient', at: T0 }),
      COMPLETED: apply(apply(requested, { type: 'accept', at: T0 - 60_000 }), {
        type: 'complete',
        at: T0 + HOUR,
      }),
    };

    const events: AppointmentEvent[] = [
      { type: 'accept', at: T0 + 2 * HOUR },
      { type: 'decline', by: 'doctor', at: T0 },
      { type: 'propose', slot: otherSlot, at: T0 },
      { type: 'patientAccept', at: T0 },
      { type: 'patientDecline', at: T0 },
      { type: 'cancel', by: 'doctor', at: T0 },
      { type: 'complete', at: T0 + 2 * HOUR },
    ];

    for (const [status, appointment] of Object.entries(samples)) {
      const byParty = ALLOWED_TRANSITIONS[status as keyof typeof ALLOWED_TRANSITIONS];
      const allowed = [...byParty.doctor, ...byParty.patient] as readonly string[];

      for (const event of events) {
        // Try BOTH parties and take the best outcome, because this test is about the
        // state graph, not about who may act — an event allowed from this state must be
        // allowed for SOMEONE, and forbidden from this state must be forbidden for
        // EVERYONE.
        const results = [DOCTOR, PATIENT].map((actor) =>
          transition(appointment as never, event as never, actor),
        );

        // A permitted event must not fail with ILLEGAL_TRANSITION (it may still fail a
        // domain rule, e.g. proposing an identical slot, or be refused for one party).
        if (allowed.includes(event.type)) {
          for (const result of results) {
            if (!result.ok) {
              expect(result.error.kind).not.toBe('ILLEGAL_TRANSITION');
            }
          }
        } else {
          for (const result of results) expect(result.ok).toBe(false);
        }
      }
    }
  });
});

describe('domain rules beyond the state graph', () => {
  it('rejects a counter-proposal identical to the request', () => {
    const result = transition(requested, { type: 'propose', slot, at: T0 }, DOCTOR);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('INVALID_PROPOSAL');
  });

  it('rejects completing an appointment before it has started', () => {
    const confirmed = apply(requested, { type: 'accept', at: T0 - 60_000 });
    const result = transition(
      confirmed as never,
      {
        type: 'complete',
        at: T0 - 60_000,
      } as never,
      DOCTOR,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('INVALID_PROPOSAL');
  });
});

describe('transitions are pure', () => {
  it('never mutates the input appointment', () => {
    const snapshot = structuredClone(requested);
    apply(requested, { type: 'accept', at: T0 });
    expect(requested).toEqual(snapshot);
  });
});

describe('slot occupancy', () => {
  it('active states hold a slot, terminal states hold none', () => {
    expect(occupiedSlot(requested)).toEqual(slot);
    expect(
      occupiedSlot(apply(requested, { type: 'decline', by: 'doctor', at: T0 })),
    ).toBeNull();
  });

  it('a COUNTER_PROPOSED appointment holds BOTH slots', () => {
    // Both must stay blocked while the patient decides. Releasing the proposed slot
    // would let another patient take it, and accepting the counter-proposal would then
    // double-book. Releasing the original would lose the fallback if they decline.
    const proposed = apply(requested, { type: 'propose', slot: otherSlot, at: T0 });
    expect(heldSlots(proposed)).toEqual([slot, otherSlot]);
  });

  it('ACTIVE_STATUSES is exactly the set of statuses that hold a slot', () => {
    // Phase 3 builds the partial unique index from ACTIVE_STATUSES, so this list and the
    // occupancy logic must not drift apart — a status that holds a slot but is missing
    // from the index filter is a double booking waiting to happen.
    const samples: Appointment[] = [
      requested,
      apply(requested, { type: 'propose', slot: otherSlot, at: T0 }),
      apply(requested, { type: 'accept', at: T0 - 60_000 }),
      apply(requested, { type: 'decline', by: 'doctor', at: T0 }),
      apply(requested, { type: 'cancel', by: 'patient', at: T0 }),
    ];

    for (const appointment of samples) {
      const holds = heldSlots(appointment).length > 0;
      const isActive = (ACTIVE_STATUSES as readonly string[]).includes(
        appointment.status,
      );
      expect(holds).toBe(isActive);
    }
  });
});

import { interval } from '../../../shared/intervals/interval';
import type {
  CancelledAppointment,
  ConfirmedAppointment,
  CounterProposedAppointment,
  RequestedAppointment,
} from './appointment';
import { type TransitionActor, transition } from './state-machine';

/**
 * The actor argument is required now but is NOT what this file proves. Every call below
 * passes a valid party, so the only thing that can make a line compile or fail is the
 * STATUS/EVENT pairing — which is the compile-time guarantee under test.
 *
 * Note what deliberately is not asserted here: there is no `@ts-expect-error` for "a
 * patient cannot accept". That check is genuinely runtime-only (see the comment on
 * `EventsFor`), and writing a compile-time proof for it would be writing a proof of
 * something false.
 */
const DOCTOR: TransitionActor = { role: 'doctor', profileId: 'doctor-1' };
const PATIENT: TransitionActor = { role: 'patient', profileId: 'patient-1' };

/**
 * Compile-time proof of the state machine's type-level guarantee.
 *
 * These assertions are checked by the COMPILER, not at runtime. `@ts-expect-error` is
 * itself an error when the line below it compiles cleanly — so if a guarantee ever
 * regresses, this file fails to build. That is what makes this a proof rather than a
 * comment claiming a proof.
 *
 * The boundary being demonstrated, precisely:
 *
 *   - Where the appointment's status is STATICALLY KNOWN, an illegal event does not
 *     compile. No runtime check is involved.
 *   - Where the status is only known at runtime (anything loaded from MongoDB), the
 *     union widens, the compiler cannot help, and the runtime guard in
 *     `state-machine.ts` takes over. Those cases are covered in state-machine.spec.ts.
 *
 * Claiming "illegal states are unrepresentable" without acknowledging the second half is
 * how people end up with elaborate types AND an unguarded runtime path.
 */

const T0 = Date.UTC(2026, 5, 2, 9, 0);
const slot = interval(T0, T0 + 3_600_000);

const base = {
  id: 'appt-1',
  doctorId: 'doctor-1',
  patientId: 'patient-1',
  slot,
  createdAt: T0,
};

const requested: RequestedAppointment = { ...base, status: 'REQUESTED' };
const confirmed: ConfirmedAppointment = {
  ...base,
  status: 'CONFIRMED',
  confirmedSlot: slot,
  confirmedAt: T0,
};
const counterProposed: CounterProposedAppointment = {
  ...base,
  status: 'COUNTER_PROPOSED',
  proposedSlot: interval(T0 + 7_200_000, T0 + 10_800_000),
  proposedAt: T0,
};
const cancelled: CancelledAppointment = {
  ...base,
  status: 'CANCELLED',
  cancelledBy: 'patient',
  cancelledAt: T0,
};

describe('compile-time transition guarantees', () => {
  it('rejects illegal events at compile time when the state is statically known', () => {
    // --- Legal: these must compile. ---
    transition(requested, { type: 'accept', at: T0 }, DOCTOR);
    transition(requested, { type: 'propose', slot, at: T0 }, DOCTOR);
    transition(confirmed, { type: 'complete', at: T0 }, DOCTOR);
    transition(confirmed, { type: 'cancel', by: 'doctor', at: T0 }, DOCTOR);
    transition(counterProposed, { type: 'patientAccept', at: T0 }, PATIENT);

    // --- Illegal: each of these is a COMPILE ERROR. ---

    // Cannot complete something never confirmed.
    // @ts-expect-error 'complete' is not a legal event for REQUESTED
    transition(requested, { type: 'complete', at: T0 }, DOCTOR);

    // Cannot re-accept an appointment already confirmed.
    // @ts-expect-error 'accept' is not a legal event for CONFIRMED
    transition(confirmed, { type: 'accept', at: T0 }, DOCTOR);

    // The patient cannot accept a proposal that was never made.
    // @ts-expect-error 'patientAccept' is not a legal event for REQUESTED
    transition(requested, { type: 'patientAccept', at: T0 }, PATIENT);

    // A counter-proposal cannot be counter-proposed again.
    // @ts-expect-error 'propose' is not a legal event for COUNTER_PROPOSED
    transition(counterProposed, { type: 'propose', slot, at: T0 }, DOCTOR);

    // Terminal states map to `never`, so EVERY event is a compile error.
    // @ts-expect-error CANCELLED is terminal and accepts no events
    transition(cancelled, { type: 'accept', at: T0 }, DOCTOR);
    // @ts-expect-error CANCELLED is terminal and accepts no events
    transition(cancelled, { type: 'cancel', by: 'doctor', at: T0 }, DOCTOR);

    expect(true).toBe(true);
  });

  it('makes state-specific fields inaccessible without narrowing', () => {
    // @ts-expect-error `proposedSlot` exists only on COUNTER_PROPOSED
    void requested.proposedSlot;

    // @ts-expect-error `confirmedSlot` exists only on CONFIRMED/COMPLETED
    void requested.confirmedSlot;

    // @ts-expect-error `cancelledBy` exists only on CANCELLED
    void confirmed.cancelledBy;

    // Once narrowed, the field is present AND non-optional — no `?? throw` at the point
    // of use, which is the practical payoff of the union over optional properties.
    const definitelyPresent: (typeof counterProposed)['proposedSlot'] =
      counterProposed.proposedSlot;
    expect(definitelyPresent).toBeDefined();
  });
});

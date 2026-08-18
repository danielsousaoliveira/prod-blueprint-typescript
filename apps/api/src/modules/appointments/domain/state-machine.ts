import type { Interval } from '../../../shared/intervals/interval';
import { type Result, err, ok } from '../../../shared/result';
import type {
  Appointment,
  AppointmentStatus,
  CancelledAppointment,
  ConfirmedAppointment,
  CompletedAppointment,
  CounterProposedAppointment,
  DeclinedAppointment,
  Party,
} from './appointment';

/**
 * The appointment lifecycle, as an explicit state machine.
 *
 *   REQUESTED --accept--> CONFIRMED --complete--> COMPLETED
 *       |                     |
 *       |--decline--> DECLINED|--cancel--> CANCELLED
 *       |
 *       |--propose--> COUNTER_PROPOSED --patientAccept--> CONFIRMED
 *                           |--patientDecline--> DECLINED
 *                           |--cancel--> CANCELLED
 *
 * Transitions are the ONLY way an appointment changes state. Nothing outside this file
 * constructs a `ConfirmedAppointment`, so there is exactly one place to audit for "can
 * this appointment reach this state?" — which is what makes the machine worth having
 * rather than scattering `if (status === ...)` across services.
 *
 * Transition functions are pure and total: same input, same output, no I/O, no clock
 * read. `at` is passed in rather than calling `Date.now()` internally, which is what
 * makes the time-dependent behaviour testable without mocking global time.
 */

export type AppointmentEvent =
  | { readonly type: 'accept'; readonly at: number }
  | { readonly type: 'decline'; readonly by: Party; readonly at: number }
  | { readonly type: 'propose'; readonly slot: Interval; readonly at: number }
  | { readonly type: 'patientAccept'; readonly at: number }
  | { readonly type: 'patientDecline'; readonly at: number }
  | {
      readonly type: 'cancel';
      readonly by: Party;
      readonly at: number;
      readonly reason?: string;
    }
  | { readonly type: 'complete'; readonly at: number };

export type EventType = AppointmentEvent['type'];

/**
 * Who is attempting a transition.
 *
 * ============================================================================
 * WHY THIS IS DEFINED HERE AND NOT IMPORTED FROM THE AUTH MODULE
 * ============================================================================
 *
 * The auth module has an `Actor` type with exactly these two fields plus `userId`, and
 * importing it would be one line shorter. It would also make the appointment DOMAIN
 * depend on the authentication module, which inverts the dependency the architecture is
 * built around: the domain is the thing everything else points at, and it should be
 * possible to reason about appointment rules with no notion of sessions, users, or
 * logging in.
 *
 * Structurally, `Actor` is assignable to this, so the service layer passes one straight
 * through with no mapping function. TypeScript's structural typing does the adaptation
 * for free — which is the case where declaring the narrower type costs nothing and buys
 * a boundary.
 *
 * It is also genuinely narrower, and that matters: `userId` has no business being in a
 * domain rule. The rule is about which *party* someone is on this appointment, not which
 * account they signed in with.
 * ============================================================================
 */
export interface TransitionActor {
  readonly role: Party;
  readonly profileId: string;
}

/**
 * Is this actor one of the two parties on this appointment?
 *
 * The role check is not redundant with the id check. Without it, a doctor whose
 * `profileId` happened to equal some patient's id would pass as the patient — which
 * sounds impossible until ids come from two different collections with independent
 * generators, which is exactly the case here. Comparing the id belonging to the actor's
 * *claimed role* is what makes the check total.
 */
export function isParty(appointment: Appointment, actor: TransitionActor): boolean {
  return actor.role === 'doctor'
    ? appointment.doctorId === actor.profileId
    : appointment.patientId === actor.profileId;
}

/**
 * The transition table, as a type.
 *
 * This is what buys the compile-time guarantee. `EventsFor<'CONFIRMED'>` is
 * `'cancel' | 'complete'`, so when the compiler statically knows an appointment is
 * confirmed, passing `{ type: 'accept' }` fails to typecheck.
 *
 * Terminal states map to `never` — there is no event they accept, so ANY event against a
 * statically-known terminal appointment is a compile error.
 */
export interface TransitionTable {
  REQUESTED: {
    doctor: 'accept' | 'decline' | 'propose' | 'cancel';
    patient: 'cancel';
  };
  COUNTER_PROPOSED: {
    doctor: 'cancel';
    patient: 'patientAccept' | 'patientDecline' | 'cancel';
  };
  CONFIRMED: {
    doctor: 'cancel' | 'complete';
    patient: 'cancel';
  };
  DECLINED: { doctor: never; patient: never };
  CANCELLED: { doctor: never; patient: never };
  COMPLETED: { doctor: never; patient: never };
}

/**
 * Every event a state accepts, from anyone.
 *
 * This is what the compile-time guarantee is expressed in terms of, and it is
 * deliberately the UNION across parties rather than being actor-parameterised. The
 * reason is a limit worth being precise about: at a call site the compiler usually knows
 * the appointment's status (from a narrowed type) but almost never knows the actor's
 * role, because that arrived over the network at runtime. Parameterising the event type
 * on the role would push the check into a type variable nobody can resolve statically,
 * producing an elaborate signature that still needs the runtime guard.
 *
 * So: **the status dimension is checked at compile time where possible, the actor
 * dimension is always checked at runtime.** Same honest split as the original design,
 * with one more axis.
 */
export type EventsFor<S extends AppointmentStatus> =
  TransitionTable[S][keyof TransitionTable[S]];

/** The events a specific party may raise from a specific state. */
export type EventsForParty<
  S extends AppointmentStatus,
  P extends Party,
> = TransitionTable[S][P];

/**
 * The same table as a runtime value.
 *
 * It has to exist twice — types are erased at compile time, and an appointment loaded
 * from MongoDB has status `AppointmentStatus` (the full union), not a narrowed literal.
 * The `satisfies` operator ties the two together: if a status is added to the union or a
 * transition is added to the type table without updating this value, the build fails.
 * That is what keeps the two copies from drifting, which is the usual objection to
 * duplicating a table like this.
 */
export const ALLOWED_TRANSITIONS = {
  REQUESTED: {
    // The doctor drives a new request: take it, refuse it, or offer another time.
    doctor: ['accept', 'decline', 'propose', 'cancel'],
    // A patient can withdraw their own request, and nothing else. Notably they CANNOT
    // 'accept' — that is the doctor confirming, and letting a patient raise it would mean
    // self-approving an appointment nobody agreed to.
    patient: ['cancel'],
  },
  COUNTER_PROPOSED: {
    // The ball is with the patient. The doctor can still cancel (something came up), but
    // cannot answer their own proposal on the patient's behalf.
    doctor: ['cancel'],
    patient: ['patientAccept', 'patientDecline', 'cancel'],
  },
  CONFIRMED: {
    // 'complete' is a clinical record — the doctor saw the patient. A patient marking
    // their own appointment complete is a data-integrity problem, not just a permissions
    // one, because that record is what the stats aggregation counts.
    doctor: ['cancel', 'complete'],
    patient: ['cancel'],
  },
  DECLINED: { doctor: [], patient: [] },
  CANCELLED: { doctor: [], patient: [] },
  COMPLETED: { doctor: [], patient: [] },
} as const satisfies {
  [S in AppointmentStatus]: { [P in Party]: readonly EventsForParty<S, P>[] };
};

/**
 * Every event allowed from a state, regardless of who raises it.
 *
 * Used to distinguish the two failure modes below: an event nobody can raise from this
 * state is an ILLEGAL TRANSITION (409 — the resource is in the wrong state), while an
 * event *someone* could raise but not this actor is NOT PERMITTED (403 — right state,
 * wrong person). Collapsing those into one error would tell a patient that accepting a
 * confirmed appointment is a permissions problem, which is misleading and would send
 * them looking for the wrong fix.
 */
function anyPartyMay(status: AppointmentStatus): readonly EventType[] {
  const byParty = ALLOWED_TRANSITIONS[status];
  return [...byParty.doctor, ...byParty.patient] as readonly EventType[];
}

export interface IllegalTransitionError {
  readonly kind: 'ILLEGAL_TRANSITION';
  readonly from: AppointmentStatus;
  readonly event: EventType;
  readonly allowed: readonly EventType[];
  readonly message: string;
}

export interface InvalidProposalError {
  readonly kind: 'INVALID_PROPOSAL';
  readonly message: string;
}

/**
 * The actor is not a party to this appointment at all.
 *
 * Rendered as **404, not 403**, at the API edge. See the long comment on `toProblem` in
 * the appointments controller — a 403 confirms the appointment exists.
 */
export interface NotAPartyError {
  readonly kind: 'NOT_A_PARTY';
  readonly message: string;
}

/**
 * The actor is a party, the state permits this event, but not from them.
 *
 * Rendered as 403. Safe to be specific here: the caller has already proven they are on
 * the appointment, so telling them what they may do discloses nothing they could not
 * work out by reading the appointment they legitimately hold.
 */
export interface ActorNotPermittedError {
  readonly kind: 'ACTOR_NOT_PERMITTED';
  readonly role: Party;
  readonly event: EventType;
  readonly allowedForRole: readonly EventType[];
  readonly message: string;
}

export type TransitionError =
  IllegalTransitionError | InvalidProposalError | NotAPartyError | ActorNotPermittedError;

function illegal(from: AppointmentStatus, event: EventType): IllegalTransitionError {
  const allowed = anyPartyMay(from);
  return {
    kind: 'ILLEGAL_TRANSITION',
    from,
    event,
    allowed,
    message:
      allowed.length === 0
        ? `Cannot ${event} an appointment in terminal state ${from}`
        : `Cannot ${event} an appointment in state ${from}; allowed: ${allowed.join(', ')}`,
  };
}

/**
 * Apply an event to an appointment.
 *
 * The generic signature is where the compile-time/runtime boundary sits, and it is worth
 * being precise about, because "make illegal states unrepresentable" is often oversold:
 *
 *   - When the caller has NARROWED the appointment to one state (a unit test, or code
 *     inside a `case` branch), `A['status']` is a single literal, `EventsFor<A['status']>`
 *     is that state's allowed events, and an illegal event is a COMPILE ERROR.
 *
 *   - When the appointment came from the database, `A['status']` is the full union, so
 *     `EventsFor<...>` widens to every event and the compiler cannot help. That case is
 *     caught by the RUNTIME guard below.
 *
 * The type system cannot check a value it will not know until runtime. Pretending
 * otherwise is how people end up with elaborate types that still need the runtime check
 * anyway. Both are here, deliberately, and they are generated from one table.
 */
export function transition<A extends Appointment>(
  appointment: A,
  event: Extract<AppointmentEvent, { type: EventsFor<A['status']> }>,
  actor: TransitionActor,
): Result<Appointment, TransitionError> {
  // Runtime guard. Widened to the full union because `appointment` may have come from
  // outside the type system's knowledge.
  // A plain widening assignment, not an assertion: `A extends Appointment`, so this is
  // already sound and needs no `as`.
  const current: Appointment = appointment;
  // This one DOES need an assertion. `Extract<...>` over an unresolved generic cannot be
  // proven assignable to the full union by the compiler, even though it always is.
  const incoming = event as AppointmentEvent;

  /**
   * ============================================================================
   * THE THREE CHECKS, IN THIS ORDER, FOR A REASON
   * ============================================================================
   *
   * 1. Party membership — before anything else, because the answer determines whether the
   *    caller is allowed to learn ANYTHING about this appointment, including whether the
   *    state they attempted was legal. Running the transition check first and reporting
   *    "cannot accept a COMPLETED appointment" to a stranger discloses both that the
   *    appointment exists and what state it is in.
   * 2. Is the event legal from this state for anyone — a 409 about the resource.
   * 3. Is it legal for THIS party — a 403 about the caller.
   *
   * Steps 2 and 3 are ordered so that a patient trying to `complete` a CANCELLED
   * appointment is told the appointment is cancelled (the more useful and more
   * fundamental fact) rather than that they lack permission to complete things.
   *
   * All three are pure. Authorization here is a DOMAIN rule with no I/O, which is what
   * makes it exhaustively unit-testable across status × role × event — 6 × 2 × 7 = 84
   * combinations, enumerated in the spec rather than sampled.
   * ============================================================================
   */
  if (!isParty(current, actor)) {
    return err({
      kind: 'NOT_A_PARTY',
      message: 'This appointment does not belong to you',
    });
  }

  if (!anyPartyMay(current.status).includes(incoming.type)) {
    return err(illegal(current.status, incoming.type));
  }

  const allowedForRole = ALLOWED_TRANSITIONS[current.status][
    actor.role
  ] as readonly EventType[];

  if (!allowedForRole.includes(incoming.type)) {
    return err({
      kind: 'ACTOR_NOT_PERMITTED',
      role: actor.role,
      event: incoming.type,
      allowedForRole,
      message: `A ${actor.role} cannot ${incoming.type} an appointment in state ${current.status}`,
    });
  }

  switch (incoming.type) {
    case 'accept': {
      const from = current as import('./appointment').RequestedAppointment;
      const next: ConfirmedAppointment = {
        id: from.id,
        doctorId: from.doctorId,
        patientId: from.patientId,
        slot: from.slot,
        createdAt: from.createdAt,
        status: 'CONFIRMED',
        confirmedSlot: from.slot,
        confirmedAt: incoming.at,
      };
      return ok(next);
    }

    case 'decline': {
      const next: DeclinedAppointment = {
        id: current.id,
        doctorId: current.doctorId,
        patientId: current.patientId,
        slot: current.slot,
        createdAt: current.createdAt,
        status: 'DECLINED',
        declinedBy: incoming.by,
        declinedAt: incoming.at,
      };
      return ok(next);
    }

    case 'propose': {
      // A counter-proposal identical to the original request is meaningless and would
      // strand the patient in a decision they have effectively already made.
      if (
        incoming.slot.start === current.slot.start &&
        incoming.slot.end === current.slot.end
      ) {
        return err({
          kind: 'INVALID_PROPOSAL',
          message: 'Proposed slot is identical to the requested slot',
        });
      }
      const next: CounterProposedAppointment = {
        id: current.id,
        doctorId: current.doctorId,
        patientId: current.patientId,
        slot: current.slot,
        createdAt: current.createdAt,
        status: 'COUNTER_PROPOSED',
        proposedSlot: incoming.slot,
        proposedAt: incoming.at,
      };
      return ok(next);
    }

    case 'patientAccept': {
      // Narrowing is safe: the runtime guard above proved the status accepts this event,
      // and only COUNTER_PROPOSED does.
      const from = current as CounterProposedAppointment;
      const next: ConfirmedAppointment = {
        id: from.id,
        doctorId: from.doctorId,
        patientId: from.patientId,
        slot: from.slot,
        createdAt: from.createdAt,
        status: 'CONFIRMED',
        // The PROPOSED slot becomes the confirmed one; `slot` keeps the original request.
        confirmedSlot: from.proposedSlot,
        confirmedAt: incoming.at,
      };
      return ok(next);
    }

    case 'patientDecline': {
      const next: DeclinedAppointment = {
        id: current.id,
        doctorId: current.doctorId,
        patientId: current.patientId,
        slot: current.slot,
        createdAt: current.createdAt,
        status: 'DECLINED',
        declinedBy: 'patient',
        declinedAt: incoming.at,
      };
      return ok(next);
    }

    case 'cancel': {
      const next: CancelledAppointment = {
        id: current.id,
        doctorId: current.doctorId,
        patientId: current.patientId,
        slot: current.slot,
        createdAt: current.createdAt,
        status: 'CANCELLED',
        cancelledBy: incoming.by,
        cancelledAt: incoming.at,
        // Spread rather than `reason: incoming.reason` — exactOptionalPropertyTypes
        // distinguishes an absent property from one explicitly set to undefined.
        ...(incoming.reason === undefined ? {} : { reason: incoming.reason }),
      };
      return ok(next);
    }

    case 'complete': {
      const from = current as ConfirmedAppointment;
      // An appointment cannot be completed before it has happened. This is a domain
      // rule, not a state-machine rule, which is why it lives inside the handler rather
      // than in the transition table.
      if (incoming.at < from.confirmedSlot.start) {
        return err({
          kind: 'INVALID_PROPOSAL',
          message: 'Cannot complete an appointment before its start time',
        });
      }
      const next: CompletedAppointment = {
        id: from.id,
        doctorId: from.doctorId,
        patientId: from.patientId,
        slot: from.slot,
        createdAt: from.createdAt,
        status: 'COMPLETED',
        confirmedSlot: from.confirmedSlot,
        completedAt: incoming.at,
      };
      return ok(next);
    }
  }
}

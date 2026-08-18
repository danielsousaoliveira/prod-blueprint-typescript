import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { interval, type Interval } from '../../../shared/intervals/interval';
import {
  DISTRIBUTED_LOCK,
  type DistributedLock,
} from '../../../shared/locking/distributed-lock';
import type { Appointment, Party } from '../domain/appointment';
import {
  APPOINTMENT_REPOSITORY,
  type AppointmentRepository,
  SlotTakenError,
  AppointmentNotFoundError,
} from '../domain/appointment.repository';
import {
  type AppointmentEvent,
  type TransitionError,
  isParty,
  transition,
} from '../domain/state-machine';
import type { Actor } from '../../auth/domain/user';
import { type OutboxMessage, outboxTypeForStatus } from '../../outbox/domain/outbox';
import { AvailabilityCache } from '../../availability/application/availability.cache';

/**
 * Application service for appointments.
 *
 * NOTE WHAT THIS FILE DOES NOT IMPORT: no `@nestjs/common` HTTP decorators, no Express
 * `Request`/`Response`, nothing from the `mongodb` driver. It speaks domain types and
 * repository ports only.
 *
 * That is not stylistic. It is what lets the SAME service back both the REST controllers
 * (Phase 4) and the GraphQL resolvers (Phase 5) with zero duplicated business logic —
 * which is the entire premise of building both APIs. It is also what lets the service be
 * unit-tested against in-memory adapters with no HTTP layer and no database.
 *
 * The rule is enforced by an ESLint `no-restricted-imports` rule scoped to the
 * application and domain directories, not by code-review discipline. A rule that depends
 * on someone noticing is a rule that erodes.
 */

/** Errors this service can produce, as values rather than exceptions. */
export type BookingError =
  | { readonly kind: 'SLOT_TAKEN'; readonly message: string }
  | { readonly kind: 'APPOINTMENT_NOT_FOUND'; readonly message: string }
  | { readonly kind: 'CONTENDED'; readonly message: string }
  | TransitionError;

export type ServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: BookingError };

/**
 * Note the absence of `patientId`.
 *
 * A patient books for themselves, so the identity comes from the session and the client
 * does not get to say who it is booking as. Accepting a `patientId` here and trusting it
 * is the entire class of bug this phase exists to close — it would let anyone create
 * appointments in someone else's name, and it would look completely reasonable in a code
 * review because the field is right there in the request body.
 *
 * `doctorId` stays: choosing which doctor to see is a genuine client decision.
 */
export interface RequestAppointmentInput {
  readonly doctorId: string;
  readonly startsAt: number;
  readonly endsAt: number;
}

/**
 * How long the contention lock is held. Deliberately short: it is an optimisation, and a
 * long TTL turns a stalled process into a long outage for that slot. Correctness does not
 * depend on this number, which is precisely the property that makes it safe to tune.
 */
const LOCK_TTL_MS = 3_000;

@Injectable()
export class AppointmentService {
  private readonly logger = new Logger(AppointmentService.name);

  constructor(
    @Inject(APPOINTMENT_REPOSITORY)
    private readonly repository: AppointmentRepository,
    @Inject(DISTRIBUTED_LOCK)
    private readonly lock: DistributedLock,
    private readonly cache: AvailabilityCache,
  ) {}

  /**
   * Request an appointment.
   *
   * The lock is acquired first, but read the comment in `distributed-lock.ts`: it exists
   * to reduce contention, not to make this correct. If the lock layer vanished entirely,
   * this method would still be correct — the repository's insert would fail on the unique
   * index and produce the same `SLOT_TAKEN`. The lock only lets losers find out sooner
   * and more cheaply.
   */
  async request(
    input: RequestAppointmentInput,
    actor: Actor,
  ): Promise<ServiceResult<Appointment>> {
    /**
     * Only a patient can request an appointment.
     *
     * This one rule cannot live in the transition table, because there is no appointment
     * yet — the table answers "who may move this from state X", and creation has no
     * prior state. So it sits here, at the one place appointments come into existence,
     * and it is checked rather than assumed.
     *
     * A doctor booking on a patient's behalf is a real clinic workflow and it is
     * deliberately not supported: it needs a way to say *which* patient, which reopens
     * exactly the "client asserts an identity" hole closed above, and doing it safely
     * means modelling delegation properly. Recorded in design rationale rather than
     * half-built.
     */
    if (actor.role !== 'patient') {
      return {
        ok: false,
        error: {
          kind: 'ACTOR_NOT_PERMITTED',
          role: actor.role,
          event: 'accept',
          allowedForRole: [],
          message: 'Only a patient can request an appointment',
        },
      };
    }

    const slot = interval(input.startsAt, input.endsAt);
    const lockKey = `slot:${input.doctorId}:${input.startsAt}`;

    const release = await this.lock.acquire(lockKey, LOCK_TTL_MS);
    if (!release) {
      // Someone else is mid-booking for this exact slot. Fail fast rather than queue —
      // the caller retries and, by then, the slot is either taken or free.
      return {
        ok: false,
        error: { kind: 'CONTENDED', message: 'That slot is being booked right now' },
      };
    }

    try {
      const appointment: Appointment = {
        id: randomUUID(),
        doctorId: input.doctorId,
        // From the session, never from the request body.
        patientId: actor.profileId,
        slot,
        createdAt: Date.now(),
        status: 'REQUESTED',
      };

      // The outbox message is passed INTO create, so the repository writes both inside
      // one transaction. Publishing here instead — after the create returns — would
      // reopen the exact window the outbox exists to close.
      const created = await this.repository.create(appointment, [
        outboxFor(appointment.id, 'REQUESTED', {
          doctorId: appointment.doctorId,
          patientId: appointment.patientId,
          startsAt: appointment.slot.start,
        }),
      ]);

      // The slot is now taken, so every cached window for this doctor is stale.
      // Invalidating AFTER the write — invalidating before would leave a window in which
      // a concurrent read repopulates the cache from pre-write state.
      await this.cache.invalidate(appointment.doctorId);

      return { ok: true, value: created };
    } catch (error) {
      return this.toErrorResult(error);
    } finally {
      await release();
    }
  }

  /**
   * Apply a lifecycle event.
   *
   * Every mutation goes through the Phase 2 transition function — there is no path that
   * writes a status directly. That is what makes the state machine authoritative rather
   * than advisory.
   *
   * Read-modify-write is safe here because the repository's `update` is a compare-and-set
   * on the status we read. If another request transitioned it in between, the write
   * matches nothing and we report a conflict rather than clobbering their change.
   */
  async applyEvent(
    id: string,
    event: AppointmentEvent,
    actor: Actor,
  ): Promise<ServiceResult<Appointment>> {
    const current = await this.repository.findById(id);
    if (!current) {
      return {
        ok: false,
        error: {
          kind: 'APPOINTMENT_NOT_FOUND',
          message: `Appointment ${id} not found`,
        },
      };
    }

    // `transition` performs the party and role checks itself — see the three-check
    // comment there. Authorization is not a separate step this method could forget to
    // call, because the only way to change an appointment is through the function that
    // enforces it.
    const result = transition(current, event as never, actor);
    if (!result.ok) return { ok: false, error: result.error };

    const next = result.value;

    try {
      // The outbox message goes in with the update, so both commit together. If the
      // compare-and-set loses its race the whole transaction aborts and no message is
      // emitted — a transition that did not happen must not announce itself.
      const updated = await this.repository.update(next, current.status, [
        outboxFor(next.id, next.status, {
          doctorId: next.doctorId,
          patientId: next.patientId,
          startsAt:
            next.status === 'CONFIRMED' || next.status === 'COMPLETED'
              ? next.confirmedSlot.start
              : next.slot.start,
        }),
      ]);

      // Any transition can free or move a slot: cancelling releases one, accepting a
      // counter-proposal moves one. Invalidated AFTER the write — doing it before would
      // leave a window in which a concurrent read repopulates the cache from pre-write
      // state, which is worse than not invalidating at all.
      await this.cache.invalidate(next.doctorId);

      return { ok: true, value: updated };
    } catch (error) {
      return this.toErrorResult(error);
    }
  }

  /**
   * Read one appointment, if it is the caller's.
   *
   * Returns null for both "does not exist" and "not yours" — the caller cannot tell them
   * apart, and must not be able to. See the 404-not-403 discussion in the controller.
   */
  async findById(id: string, actor: Actor): Promise<Appointment | null> {
    const appointment = await this.repository.findById(id);
    if (!appointment) return null;
    return isParty(appointment, actor) ? appointment : null;
  }

  /**
   * List the caller's appointments.
   *
   * ============================================================================
   * THE SCOPING IS NOT OPTIONAL, AND THAT IS THE WHOLE POINT
   * ============================================================================
   *
   * This method used to take `{ doctorId?, patientId?, within? }` and pass it straight to
   * the repository. Both id filters were optional, so calling it with neither returned
   * **every appointment in the database** — and the REST and GraphQL endpoints both
   * exposed exactly that, because their query parameters were optional too.
   *
   * The fix is not to add a check that the caller supplied a filter. It is to make the
   * unscoped query **unexpressible**: the actor determines the filter, and there is no
   * parameter through which a caller could widen it. A rule enforced by the shape of the
   * function cannot be forgotten by the next person who adds an endpoint here.
   *
   * The reporting use case that genuinely needs cross-doctor reads — the stats
   * aggregation — talks to the repository directly, which is the right place to draw that
   * line: it is a different capability, not a wider version of this one.
   * ============================================================================
   */
  list(actor: Actor, within?: Interval): Promise<Appointment[]> {
    const scope =
      actor.role === 'doctor'
        ? { doctorId: actor.profileId }
        : { patientId: actor.profileId };

    return this.repository.find({
      ...scope,
      ...(within === undefined ? {} : { within }),
    });
  }

  /**
   * Translates repository errors into service-level results.
   *
   * The repository already converted MongoDB's error 11000 into `SlotTakenError`, so this
   * layer never sees a driver error code — each layer translates once, into the vocabulary
   * of the layer above it.
   */
  private toErrorResult(error: unknown): ServiceResult<never> {
    if (error instanceof SlotTakenError) {
      return { ok: false, error: { kind: 'SLOT_TAKEN', message: error.message } };
    }
    if (error instanceof AppointmentNotFoundError) {
      return {
        ok: false,
        error: { kind: 'APPOINTMENT_NOT_FOUND', message: error.message },
      };
    }
    // Anything else is a genuine fault, not an expected outcome. Rethrow so it becomes a
    // 500 and gets logged, rather than being flattened into a business error.
    this.logger.error('Unexpected repository error', error);
    throw error;
  }
}

/** Convenience constructors so controllers never build event objects by hand. */
/**
 * ============================================================================
 * `by` IS NOW DERIVED FROM THE SESSION, NEVER FROM THE REQUEST
 * ============================================================================
 *
 * `decline` and `cancel` carry a `Party` recording who acted, and it goes into the audit
 * trail as `declinedBy` / `cancelledBy`. Until this phase the client SUPPLIED it: the
 * REST body had `{ "by": "doctor" }` and the GraphQL mutation took a `Party` argument.
 *
 * That made the audit trail worthless. Anyone could cancel an appointment and record it
 * as the other party having done so — the one field whose entire purpose is answering
 * "who did this?" was filled in by whoever wanted the answer to be something else. It
 * was not an authorization hole (the cancel itself was equally unchecked) but it was a
 * *provenance* hole, and those are worse in a medical context, where the record is
 * sometimes the only evidence of what happened.
 *
 * Callers now pass `actor.role`. The parameter still exists rather than being read from
 * a global, so these stay pure functions — but every call site is a controller or
 * resolver holding an authenticated actor, and there is no longer any path from a
 * request body to this argument.
 * ============================================================================
 */
export const events = {
  accept: (at: number): AppointmentEvent => ({ type: 'accept', at }),
  decline: (by: Party, at: number): AppointmentEvent => ({ type: 'decline', by, at }),
  propose: (slot: Interval, at: number): AppointmentEvent => ({
    type: 'propose',
    slot,
    at,
  }),
  patientAccept: (at: number): AppointmentEvent => ({ type: 'patientAccept', at }),
  patientDecline: (at: number): AppointmentEvent => ({ type: 'patientDecline', at }),
  cancel: (by: Party, at: number, reason?: string): AppointmentEvent => ({
    type: 'cancel',
    by,
    at,
    ...(reason === undefined ? {} : { reason }),
  }),
  complete: (at: number): AppointmentEvent => ({ type: 'complete', at }),
};

/**
 * Build the outbox message for a transition.
 *
 * The message id is a fresh UUID rather than derived from the appointment, because one
 * appointment produces many messages over its lifetime. It becomes the BullMQ jobId,
 * which is the first deduplication layer against at-least-once redelivery.
 */
function outboxFor(
  aggregateId: string,
  status: string,
  payload: Record<string, unknown>,
): OutboxMessage {
  const type = outboxTypeForStatus(status);
  return {
    id: randomUUID(),
    type: type ?? 'appointment.requested',
    aggregateId,
    payload,
    createdAt: Date.now(),
    publishedAt: null,
    attempts: 0,
  };
}

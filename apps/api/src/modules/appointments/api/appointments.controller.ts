import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { interval } from '../../../shared/intervals/interval';
import {
  IDEMPOTENCY_STORE,
  type IdempotencyStore,
  hashRequest,
} from '../../../shared/idempotency/idempotency.store';
import {
  ProblemException,
  ZodValidationPipe,
  problems,
} from '../../../shared/http/problem-details';
import { AvailabilityService } from '../../availability/application/availability.service';
import {
  AppointmentService,
  type BookingError,
  events,
} from '../application/appointment.service';
import {
  type AppointmentDto,
  type CancelBody,
  type ProposeBody,
  type RequestAppointmentBody,
  availabilityQuerySchema,
  cancelSchema,
  listQuerySchema,
  proposeSchema,
  requestAppointmentSchema,
  toAppointmentDto,
} from './appointment.schemas';
import { CurrentActor } from '../../auth/actor.decorator';
import type { Actor } from '../../auth/domain/user';

/**
 * REST surface. Versioned at `/v1` from the first release rather than retrofitted —
 * adding a version prefix later is itself a breaking change, so the cheapest moment to
 * have one is before any client exists.
 *
 * Controllers are thin by design: validate, delegate, map to a DTO, choose a status code.
 * No business logic lives here, which is what allows Phase 5's GraphQL resolvers to call
 * the same services and produce identical behaviour.
 */
@Controller({ path: 'appointments', version: '1' })
export class AppointmentsController {
  constructor(
    private readonly appointments: AppointmentService,
    private readonly availability: AvailabilityService,
    @Inject(IDEMPOTENCY_STORE)
    private readonly idempotency: IdempotencyStore,
  ) {}

  /**
   * Request an appointment.
   *
   * `Idempotency-Key` is optional but strongly recommended for clients. The full flow:
   *
   *   1. No key -> just do the work.
   *   2. Key, unused -> claim it atomically, do the work, store the response.
   *   3. Key, already completed, SAME body -> replay the stored response.
   *   4. Key, already completed, DIFFERENT body -> 422. This is the case naive
   *      implementations get wrong by replaying, which silently discards a request the
   *      client genuinely made.
   *   5. Key currently in flight -> 409, retry shortly.
   */
  /**
   * The pipe is on the `@Body()` PARAMETER, not on the handler via `@UsePipes`.
   *
   * That distinction is not stylistic and it cost a debugging session. `@UsePipes` applies
   * the pipe to EVERY parameter of the handler, so the moment `@CurrentActor()` was added
   * below, Zod started validating the `Actor` object against the request-body schema. It
   * has no `doctorId` or `startsAt`, so every booking failed with a 422 complaining that
   * fields the client HAD sent were missing — an error message pointing at the one place
   * the bug was not.
   *
   * Per-parameter pipes say what they validate. Handler-wide pipes silently acquire new
   * targets whenever someone adds an argument.
   */
  @Post()
  async request(
    @Body(new ZodValidationPipe(requestAppointmentSchema)) body: RequestAppointmentBody,
    @CurrentActor() actor: Actor,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<AppointmentDto> {
    if (idempotencyKey === undefined || idempotencyKey === '') {
      return this.doRequest(body, actor);
    }

    /**
     * ============================================================================
     * THE KEY IS NAMESPACED BY USER. THE HASH IS NOT.
     * ============================================================================
     *
     * Two patients independently generating the same `Idempotency-Key` is entirely
     * plausible — clients generate them locally and nothing coordinates that namespace.
     * Unscoped, the second patient would be served the FIRST patient's appointment as a
     * replayed 201: a wrong answer, and a disclosure of someone else's booking.
     *
     * My first fix was to mix the user id into the request HASH instead. That is wrong,
     * and the test `scopes Idempotency-Key to the caller` is what proved it: with a
     * shared key and different hashes, the second request looks like "same key, different
     * body" — the mismatch case — so it was rejected with a 422 telling the second
     * patient to pick a new key, for a collision they could not know about and did not
     * cause.
     *
     * Namespacing the KEY gives each caller their own keyspace, so the two requests never
     * meet. The hash then means what it is supposed to mean: "is this the same request as
     * last time, *from you*".
     * ============================================================================
     */
    const scopedKey = `${actor.userId}:${idempotencyKey}`;
    const requestHash = hashRequest(body);
    const existing = await this.idempotency.claim(scopedKey, requestHash);

    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ProblemException({
          type: problems.idempotencyMismatch,
          title: 'Idempotency-Key reused with a different request body',
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          detail:
            'This Idempotency-Key was already used for a different request. Use a new key.',
        });
      }

      if (existing.state === 'in-flight') {
        throw new ProblemException({
          type: problems.idempotencyInFlight,
          title: 'Request with this Idempotency-Key is still in progress',
          status: HttpStatus.CONFLICT,
          detail: 'Retry shortly.',
        });
      }

      return existing.body as AppointmentDto;
    }

    try {
      const dto = await this.doRequest(body, actor);
      await this.idempotency.complete(scopedKey, HttpStatus.CREATED, dto);
      return dto;
    } catch (error) {
      // Release on failure so the client can retry with the same key. Keeping the claim
      // would make a transient failure permanently unretryable for that key — which
      // turns a blip into a support ticket.
      await this.idempotency.release(scopedKey);
      throw error;
    }
  }

  private async doRequest(
    body: RequestAppointmentBody,
    actor: Actor,
  ): Promise<AppointmentDto> {
    // Pre-check for a clearer error. NOT the double-booking guarantee — see
    // AvailabilityService.isBookable and design rationale.
    const bookable = await this.availability.isBookable(
      body.doctorId,
      interval(body.startsAt, body.endsAt),
    );

    if (!bookable) {
      throw new ProblemException({
        type: problems.slotUnavailable,
        title: 'Slot is not available',
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        detail:
          "The requested time is outside the doctor's availability or not on the slot grid.",
      });
    }

    const result = await this.appointments.request(
      {
        doctorId: body.doctorId,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
      },
      actor,
    );

    if (!result.ok) throw toProblem(result.error);
    return toAppointmentDto(result.value);
  }

  /**
   * The caller's appointments.
   *
   * `doctorId` and `patientId` are gone from the query schema. They used to be optional
   * filters, which meant `GET /v1/appointments` with no parameters returned **every
   * appointment in the database** to anybody who asked. Scoping now comes from the
   * session and cannot be widened by a parameter.
   *
   * The remaining `from`/`to` are a genuine client concern — which window to show — and
   * disclose nothing.
   */
  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(listQuerySchema))
    query: { from?: number; to?: number },
  ): Promise<AppointmentDto[]> {
    const appointments = await this.appointments.list(
      actor,
      query.from !== undefined && query.to !== undefined
        ? interval(query.from, query.to)
        : undefined,
    );
    return appointments.map(toAppointmentDto);
  }

  /**
   * One appointment, if it is the caller's.
   *
   * ============================================================================
   * A NON-PARTY GETS 404, NOT 403. THIS IS DELIBERATE.
   * ============================================================================
   *
   * 403 is the instinctive answer — the appointment exists, the caller is authenticated,
   * they are simply not allowed. But "403 Forbidden" and "404 Not Found" answer different
   * questions, and the 403 answers one the caller has no right to ask: it confirms **this
   * id names a real appointment**.
   *
   * Give an attacker that distinction and appointment ids become enumerable. They cannot
   * read the contents, but they learn which ids are live, and from response timing and
   * volume they can infer how busy a clinic is, when bookings cluster, and — with a
   * little correlation — that a specific person has an appointment somewhere. In a
   * medical context the *existence* of a record is frequently the sensitive part.
   *
   * So a caller who is not a party is told the same thing as a caller who invented an id:
   * there is nothing here. `AppointmentService.findById` returns null for both cases so
   * this controller cannot accidentally tell them apart.
   *
   * The cost is a genuinely worse error message for a legitimate user who mistypes,
   * because "not found" is less helpful than "not yours". That is a real cost and it is
   * the right trade: the confused user has one bad minute, and the alternative leaks to
   * everyone forever. 403 is still used for the case where the caller HAS proven they are
   * a party — see `ACTOR_NOT_PERMITTED` in `toProblem`.
   * ============================================================================
   */
  @Get(':id')
  async findOne(
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
  ): Promise<AppointmentDto> {
    const appointment = await this.appointments.findById(id, actor);
    if (!appointment) throw notFound(id);
    return toAppointmentDto(appointment);
  }

  // --- Lifecycle transitions -------------------------------------------------
  //
  // Each is a POST to a named sub-resource rather than a PATCH of `status`. The verb is
  // the domain event, which means the API cannot express "set status to COMPLETED"
  // directly — every change goes through the state machine, and illegal transitions are
  // rejected by the same code path the domain tests cover.

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  accept(@Param('id') id: string, @CurrentActor() actor: Actor): Promise<AppointmentDto> {
    return this.apply(id, events.accept(Date.now()), actor);
  }

  /**
   * `by` is `actor.role`, not `body.by`.
   *
   * The request body no longer carries it at all — `declineSchema` is gone. It was the
   * one field whose purpose is recording who acted, filled in by whoever was acting, so
   * the audit trail said whatever the client wanted it to say.
   */
  @Post(':id/decline')
  @HttpCode(HttpStatus.OK)
  decline(
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
  ): Promise<AppointmentDto> {
    return this.apply(id, events.decline(actor.role, Date.now()), actor);
  }

  @Post(':id/propose')
  @HttpCode(HttpStatus.OK)
  propose(
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(proposeSchema)) body: ProposeBody,
  ): Promise<AppointmentDto> {
    return this.apply(
      id,
      events.propose(interval(body.startsAt, body.endsAt), Date.now()),
      actor,
    );
  }

  @Post(':id/patient-accept')
  @HttpCode(HttpStatus.OK)
  patientAccept(
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
  ): Promise<AppointmentDto> {
    return this.apply(id, events.patientAccept(Date.now()), actor);
  }

  @Post(':id/patient-decline')
  @HttpCode(HttpStatus.OK)
  patientDecline(
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
  ): Promise<AppointmentDto> {
    return this.apply(id, events.patientDecline(Date.now()), actor);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(cancelSchema)) body: CancelBody,
  ): Promise<AppointmentDto> {
    // `reason` stays client-supplied — it is free text the actor is describing, not a
    // claim about identity. `by` does not.
    return this.apply(id, events.cancel(actor.role, Date.now(), body.reason), actor);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  complete(
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
  ): Promise<AppointmentDto> {
    return this.apply(id, events.complete(Date.now()), actor);
  }

  /**
   * The single funnel for every transition — which is why threading the actor through it
   * covers all seven endpoints, and why there is no route by which one of them could be
   * left unchecked.
   */
  private async apply(
    id: string,
    event: Parameters<AppointmentService['applyEvent']>[1],
    actor: Actor,
  ): Promise<AppointmentDto> {
    const result = await this.appointments.applyEvent(id, event, actor);
    if (!result.ok) throw toProblem(result.error);
    return toAppointmentDto(result.value);
  }
}

@Controller({ path: 'doctors', version: '1' })
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get(':doctorId/availability')
  async forDoctor(
    @Param('doctorId') doctorId: string,
    @Query(new ZodValidationPipe(availabilityQuerySchema))
    query: { from: number; to: number },
  ) {
    const availability = await this.availability.forDoctor(
      doctorId,
      interval(query.from, query.to),
    );

    if (!availability) {
      throw new ProblemException({
        type: problems.notFound,
        title: 'Doctor not found',
        status: HttpStatus.NOT_FOUND,
      });
    }

    return {
      doctorId: availability.doctorId,
      // The clinic's zone travels with the response so a client in another timezone can
      // label slots correctly instead of guessing or assuming its own.
      timezone: availability.timezone,
      slots: availability.slots.map((slot) => ({
        startsAt: new Date(slot.startsAt).toISOString(),
        endsAt: new Date(slot.endsAt).toISOString(),
      })),
    };
  }
}

function notFound(id: string): ProblemException {
  return new ProblemException({
    type: problems.notFound,
    title: 'Appointment not found',
    status: HttpStatus.NOT_FOUND,
    detail: `No appointment with id ${id}`,
  });
}

/**
 * Maps service errors to HTTP status codes. The mapping is the interesting part:
 *
 * - SLOT_TAKEN      -> 409 Conflict. The request was valid; the world changed underneath
 *                      it. A retry with a different slot may succeed.
 * - CONTENDED       -> 409 Conflict, with Retry-After semantics implied. Same slot, still
 *                      being decided.
 * - ILLEGAL_TRANSITION -> 409 Conflict, NOT 400. The request is well-formed; it conflicts
 *                      with the resource's current state. 400 would tell the client to
 *                      fix its syntax, which is misleading.
 * - INVALID_PROPOSAL -> 422 Unprocessable Entity. Well-formed and understood, but
 *                      semantically wrong.
 */
function toProblem(error: BookingError): ProblemException {
  switch (error.kind) {
    case 'SLOT_TAKEN':
      return new ProblemException({
        type: problems.slotTaken,
        title: 'Slot already taken',
        status: HttpStatus.CONFLICT,
        detail: error.message,
      });

    case 'CONTENDED':
      return new ProblemException({
        type: problems.contended,
        title: 'Slot is being booked concurrently',
        status: HttpStatus.CONFLICT,
        detail: error.message,
      });

    case 'APPOINTMENT_NOT_FOUND':
      return new ProblemException({
        type: problems.notFound,
        title: 'Appointment not found',
        status: HttpStatus.NOT_FOUND,
        detail: error.message,
      });

    case 'ILLEGAL_TRANSITION':
      return new ProblemException({
        type: problems.illegalTransition,
        title: 'Illegal state transition',
        status: HttpStatus.CONFLICT,
        detail: error.message,
      });

    case 'INVALID_PROPOSAL':
      return new ProblemException({
        type: problems.validation,
        title: 'Invalid request for current state',
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        detail: error.message,
      });

    /**
     * NOT_A_PARTY renders as 404 with the SAME body a genuinely missing appointment
     * produces — no `detail` distinguishing it, no different `type`. See the long comment
     * on `findOne`: a 403 here would confirm the appointment exists.
     *
     * `error.message` is deliberately discarded rather than passed through. It says "this
     * appointment does not belong to you", which is true, useful for a log, and precisely
     * the sentence that must not reach the client.
     */
    case 'NOT_A_PARTY':
      return new ProblemException({
        type: problems.notFound,
        title: 'Appointment not found',
        status: HttpStatus.NOT_FOUND,
      });

    /**
     * ACTOR_NOT_PERMITTED is a real 403, and here it is safe to be specific: reaching
     * this case means the caller already passed the party check, so they can see this
     * appointment anyway. Telling them what their role may do discloses nothing new and
     * saves a support ticket.
     */
    case 'ACTOR_NOT_PERMITTED':
      return new ProblemException({
        type: problems.forbidden,
        title: 'Not permitted for your role',
        status: HttpStatus.FORBIDDEN,
        detail: error.message,
      });
  }
}

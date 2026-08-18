import { Inject } from '@nestjs/common';
import {
  Args,
  Context,
  ID,
  Mutation,
  Parent,
  Query,
  ResolveField,
  Resolver,
  Subscription,
} from '@nestjs/graphql';
import { GraphQLError } from 'graphql';
import { PubSub } from 'graphql-subscriptions';
import { interval } from '../../shared/intervals/interval';
import { AvailabilityService } from '../availability/application/availability.service';
import {
  AppointmentService,
  type BookingError,
  events,
} from '../appointments/application/appointment.service';
import type { Appointment } from '../appointments/domain/appointment';
import {
  DOCTOR_REPOSITORY,
  PATIENT_REPOSITORY,
  type DoctorRepository,
  type PatientRepository,
} from '../doctors/domain/doctor.repository';
import type { GraphQLContext } from './dataloaders';
import { CurrentActor } from '../auth/actor.decorator';
import type { Actor } from '../auth/domain/user';
import {
  AppointmentGql,
  AvailabilityGql,
  AvailabilityInputGql,
  DoctorGql,
  PatientGql,
  ProposeInputGql,
  RequestAppointmentInputGql,
} from './graphql.types';

/**
 * GraphQL resolvers over the SAME services the REST controllers use.
 *
 * There is no business logic in this file — only shape translation and error mapping.
 * That is the whole premise of building both APIs: if the two surfaces diverged in
 * behaviour, the comparison between them would be measuring my inconsistency rather than
 * anything about GraphQL or REST.
 */

export const APPOINTMENT_UPDATED = 'appointmentUpdated';

/**
 * In-process PubSub.
 *
 * Fine for a single instance, and WRONG the moment there are two: a subscriber connected
 * to pod A never sees an event published on pod B. Production needs a Redis-backed
 * PubSub, which Phase 6 introduces alongside BullMQ. Flagged here rather than discovered
 * later — see DECISIONS §21 for the Cloud Run consequences.
 */
export const pubSub = new PubSub();

@Resolver(() => AppointmentGql)
export class AppointmentsResolver {
  constructor(
    private readonly appointments: AppointmentService,
    private readonly availability: AvailabilityService,
    @Inject(DOCTOR_REPOSITORY) private readonly doctors: DoctorRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patients: PatientRepository,
  ) {}

  // --- Queries ---------------------------------------------------------------

  /**
   * Returns null for "does not exist" AND for "not yours" — the same conflation the REST
   * `GET /:id` makes, for the same reason. Here it costs nothing extra, because the field
   * is already nullable.
   */
  @Query(() => AppointmentGql, { nullable: true })
  async appointment(
    @Args('id', { type: () => ID }) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<AppointmentGql | null> {
    const found = await this.appointments.findById(id, actor);
    return found ? toGql(found) : null;
  }

  /**
   * The caller's appointments.
   *
   * The `doctorId` and `patientId` arguments are **gone from the schema**, not merely
   * ignored. That distinction matters: an argument that still exists but is silently
   * overridden is a trap for the next person, who will read the schema, believe they can
   * filter by it, and write a client that appears to work while returning something else
   * entirely. Deleting them makes the API honest about what it does.
   *
   * Before this change, `{ appointments { ... } }` with no arguments returned every
   * appointment in the database to any caller — the same hole as the REST list endpoint,
   * reachable by a one-line query.
   */
  @Query(() => [AppointmentGql], { name: 'appointments' })
  async listAppointments(@CurrentActor() actor: Actor): Promise<AppointmentGql[]> {
    const found = await this.appointments.list(actor);
    return found.map(toGql);
  }

  @Query(() => AvailabilityGql, { nullable: true })
  async availabilityFor(
    @Args('input') input: AvailabilityInputGql,
  ): Promise<AvailabilityGql | null> {
    const range = interval(Date.parse(input.from), Date.parse(input.to));
    const result = await this.availability.forDoctor(input.doctorId, range);
    if (!result) return null;

    return {
      doctorId: result.doctorId,
      timezone: result.timezone,
      slots: result.slots.map((slot) => ({
        startsAt: new Date(slot.startsAt).toISOString(),
        endsAt: new Date(slot.endsAt).toISOString(),
      })),
    };
  }

  // --- Field resolvers: where N+1 would happen --------------------------------

  /**
   * Called ONCE PER APPOINTMENT in the result set.
   *
   * `loaders.doctor.load(id)` looks like a single-record fetch and reads like one, but
   * every call made within the same tick is batched into one `$in` query. Fifty
   * appointments produce one doctor query, not fifty.
   *
   * The loaders come from the per-request context — never a module-level singleton. See
   * dataloaders.ts for why that distinction is a security property rather than a
   * performance one.
   */
  @ResolveField(() => DoctorGql, { nullable: true })
  async doctor(
    @Parent() appointment: AppointmentGql,
    @Context() context: GraphQLContext,
  ): Promise<DoctorGql | null> {
    return context.loaders.doctor.load(appointment.doctorId);
  }

  @ResolveField(() => PatientGql, { nullable: true })
  async patient(
    @Parent() appointment: AppointmentGql,
    @Context() context: GraphQLContext,
  ): Promise<PatientGql | null> {
    return context.loaders.patient.load(appointment.patientId);
  }

  // --- Mutations -------------------------------------------------------------

  @Mutation(() => AppointmentGql)
  async requestAppointment(
    @Args('input') input: RequestAppointmentInputGql,
    @CurrentActor() actor: Actor,
  ): Promise<AppointmentGql> {
    const startsAt = Date.parse(input.startsAt);
    const endsAt = Date.parse(input.endsAt);

    // Same pre-check as REST, for the same reason and with the same caveat: it is a
    // clearer error, not the guarantee.
    const bookable = await this.availability.isBookable(
      input.doctorId,
      interval(startsAt, endsAt),
    );
    if (!bookable) {
      throw gqlError('Slot is not available', 'SLOT_UNAVAILABLE');
    }

    const result = await this.appointments.request(
      {
        doctorId: input.doctorId,
        startsAt,
        endsAt,
      },
      actor,
    );

    if (!result.ok) throw toGqlError(result.error);
    return this.publish(result.value);
  }

  @Mutation(() => AppointmentGql)
  acceptAppointment(
    @Args('id', { type: () => ID }) id: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.apply(id, events.accept(Date.now()), actor);
  }

  /**
   * The `by` ARGUMENT IS GONE from this mutation and from `cancelAppointment`.
   *
   * It let the client write the audit trail: cancel an appointment and record it as the
   * other party having done so. Now derived from the session, matching REST — the two
   * surfaces must not disagree about who did something, or the answer depends on which
   * API the client happened to use.
   */
  @Mutation(() => AppointmentGql)
  declineAppointment(
    @Args('id', { type: () => ID }) id: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.apply(id, events.decline(actor.role, Date.now()), actor);
  }

  @Mutation(() => AppointmentGql)
  proposeNewTime(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: ProposeInputGql,
    @CurrentActor() actor: Actor,
  ) {
    return this.apply(
      id,
      events.propose(
        interval(Date.parse(input.startsAt), Date.parse(input.endsAt)),
        Date.now(),
      ),
      actor,
    );
  }

  @Mutation(() => AppointmentGql)
  patientAcceptProposal(
    @Args('id', { type: () => ID }) id: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.apply(id, events.patientAccept(Date.now()), actor);
  }

  @Mutation(() => AppointmentGql)
  patientDeclineProposal(
    @Args('id', { type: () => ID }) id: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.apply(id, events.patientDecline(Date.now()), actor);
  }

  @Mutation(() => AppointmentGql)
  cancelAppointment(
    @Args('id', { type: () => ID }) id: string,
    @CurrentActor() actor: Actor,
    @Args('reason', { nullable: true }) reason?: string,
  ) {
    return this.apply(id, events.cancel(actor.role, Date.now(), reason), actor);
  }

  @Mutation(() => AppointmentGql)
  completeAppointment(
    @Args('id', { type: () => ID }) id: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.apply(id, events.complete(Date.now()), actor);
  }

  // --- Subscription ----------------------------------------------------------

  /**
   * Live updates for one appointment.
   *
   * `filter` runs server-side so a subscriber only receives events for the appointment
   * they asked about. Publishing everything and filtering client-side would leak other
   * patients' appointment activity to anyone holding a socket — the subscription
   * equivalent of the global-DataLoader bug.
   */
  /**
   * ============================================================================
   * THE FILTER NOW CHECKS THE SUBSCRIBER, NOT JUST THE ID
   * ============================================================================
   *
   * It used to be `payload.id === variables.id` and nothing more. That is an
   * authorization hole with an unusual shape: a subscriber who guesses or obtains an
   * appointment id receives a **live stream** of that appointment's full DTO — every
   * status change, both parties' ids, the proposed times — for as long as they hold the
   * socket. Worse than the equivalent query hole, because it keeps paying out.
   *
   * The id check remains (it is the routing), and party membership is checked on top of
   * it against the actor established when the socket connected — see the `onConnect` hook
   * in `graphql.module.ts`, which is what makes an actor available here at all. A
   * WebSocket authenticates once at connection time rather than per message, so without
   * that hook this filter would have no identity to check against.
   * ============================================================================
   */
  @Subscription(() => AppointmentGql, {
    name: APPOINTMENT_UPDATED,
    filter: (
      payload: { appointmentUpdated: AppointmentGql },
      variables: { id: string },
      context: { actor?: Actor },
    ) => {
      if (payload.appointmentUpdated.id !== variables.id) return false;

      const actor = context.actor;
      if (!actor) return false;

      return actor.role === 'doctor'
        ? payload.appointmentUpdated.doctorId === actor.profileId
        : payload.appointmentUpdated.patientId === actor.profileId;
    },
  })
  appointmentUpdated(@Args('id', { type: () => ID }) _id: string) {
    return pubSub.asyncIterableIterator(APPOINTMENT_UPDATED);
  }

  // --- helpers ---------------------------------------------------------------

  private async apply(
    id: string,
    event: Parameters<AppointmentService['applyEvent']>[1],
    actor: Actor,
  ): Promise<AppointmentGql> {
    const result = await this.appointments.applyEvent(id, event, actor);
    if (!result.ok) throw toGqlError(result.error);
    return this.publish(result.value);
  }

  private async publish(appointment: Appointment): Promise<AppointmentGql> {
    const dto = toGql(appointment);
    await pubSub.publish(APPOINTMENT_UPDATED, { [APPOINTMENT_UPDATED]: dto });
    return dto;
  }
}

/**
 * Resolver for the Doctor type, adding the field that makes the graph CYCLIC:
 * Appointment -> Doctor -> Appointment -> ...
 *
 * This is realistic (a client viewing a doctor wants their appointments) and it is what
 * makes depth limiting necessary rather than decorative. Without a cycle no query can be
 * arbitrarily deep, and the guard has nothing to guard. With one, this is a valid query:
 *
 *   { appointments { doctor { appointments { doctor { appointments { ... } } } } } }
 *
 * Each level multiplies the resolver count. DataLoader does not help — it batches round
 * trips, not the exponential number of objects being resolved.
 */
@Resolver(() => DoctorGql)
export class DoctorResolver {
  constructor(private readonly appointmentService: AppointmentService) {}

  /**
   * ============================================================================
   * THE MOST DANGEROUS FIELD IN THE SCHEMA, AND THE EASIEST ONE TO MISS
   * ============================================================================
   *
   * Named `appointments` in the SCHEMA; the method name differs to avoid colliding with
   * the injected service field.
   *
   * This field previously called `list({ doctorId: doctor.id })` — the doctor from the
   * PARENT object, with no reference to who was asking. So any authenticated patient
   * could write:
   *
   *     { appointment(id: "...") { doctor { appointments { patientId startsAt } } } }
   *
   * ...and traverse from their own appointment, through the doctor, to **every other
   * patient that doctor has ever seen**. Scoping the top-level `appointments` query
   * without scoping this achieves nothing: the graph routes around it. That is the
   * specific way authorization fails in GraphQL and has no REST equivalent, because in
   * REST the endpoint author controls the whole query and there is no edge to follow.
   *
   * The field is kept rather than deleted, because it is what makes the schema cyclic and
   * therefore what makes depth limiting meaningful (DECISIONS §19). It now returns the
   * intersection of "this doctor's appointments" and "the viewer's appointments":
   *
   *   - a doctor viewing themselves gets their own list;
   *   - a doctor viewing another doctor gets nothing;
   *   - a patient gets only their own appointments with that doctor, which is exactly
   *     what they can already see, so the edge discloses nothing new.
   * ============================================================================
   */
  @ResolveField(() => [AppointmentGql], { name: 'appointments' })
  async doctorAppointments(
    @Parent() doctor: DoctorGql,
    @CurrentActor() actor: Actor,
  ): Promise<AppointmentGql[]> {
    const visible = await this.appointmentService.list(actor);
    return visible.filter((a) => a.doctorId === doctor.id).map(toGql);
  }
}

/**
 * Errors go in the `errors` array with a machine-readable `extensions.code`, rather than
 * as union result types in the schema.
 *
 * Union results ("payload types") put failure into the type system and force clients to
 * handle every case — genuinely better when you own the client. The cost is that every
 * mutation needs its own payload union, roughly doubling the schema surface, and GraphQL
 * clients already have first-class handling for the errors array.
 *
 * The codes deliberately mirror the REST problem `type` URIs so a client that supports
 * both surfaces branches on one vocabulary.
 */
function gqlError(message: string, code: string, status = 422): GraphQLError {
  return new GraphQLError(message, {
    extensions: { code, http: { status } },
  });
}

function toGqlError(error: BookingError): GraphQLError {
  switch (error.kind) {
    case 'SLOT_TAKEN':
      return gqlError(error.message, 'SLOT_TAKEN', 409);
    case 'CONTENDED':
      return gqlError(error.message, 'CONTENDED', 409);
    case 'APPOINTMENT_NOT_FOUND':
      return gqlError(error.message, 'NOT_FOUND', 404);
    case 'ILLEGAL_TRANSITION':
      return gqlError(error.message, 'ILLEGAL_TRANSITION', 409);
    case 'INVALID_PROPOSAL':
      return gqlError(error.message, 'INVALID_PROPOSAL', 422);
    /**
     * Identical to a genuinely missing appointment, message included — the REST side
     * makes the same collapse for the same reason. If these two surfaces disagreed about
     * whether a non-party gets 404 or 403, an attacker would simply ask the one that
     * tells them more.
     */
    case 'NOT_A_PARTY':
      return gqlError('Appointment not found', 'NOT_FOUND', 404);
    case 'ACTOR_NOT_PERMITTED':
      return gqlError(error.message, 'FORBIDDEN', 403);
  }
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Domain union -> flat API type. Same mapping the REST DTO performs, same reasons. */
export function toGql(appointment: Appointment): AppointmentGql {
  const held =
    appointment.status === 'CONFIRMED' || appointment.status === 'COMPLETED'
      ? appointment.confirmedSlot
      : appointment.slot;

  const proposed =
    appointment.status === 'COUNTER_PROPOSED' ? appointment.proposedSlot : null;

  return {
    id: appointment.id,
    status: appointment.status as AppointmentGql['status'],
    startsAt: iso(held.start),
    endsAt: iso(held.end),
    requestedStartsAt: iso(appointment.slot.start),
    requestedEndsAt: iso(appointment.slot.end),
    proposedStartsAt: proposed ? iso(proposed.start) : null,
    proposedEndsAt: proposed ? iso(proposed.end) : null,
    createdAt: iso(appointment.createdAt),
    doctorId: appointment.doctorId,
    patientId: appointment.patientId,
  };
}

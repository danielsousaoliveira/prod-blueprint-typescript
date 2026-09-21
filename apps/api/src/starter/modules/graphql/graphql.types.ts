import { Field, ID, ObjectType, InputType, registerEnumType } from '@nestjs/graphql';

/**
 * Code-first schema definitions: the SDL is generated from these classes.
 *
 * The reason for code-first over schema-first here is drift. With schema-first there are
 * three artefacts that can disagree — the `.graphql` file, the generated types, and the
 * resolvers. With code-first the decorated class IS the schema, so a field that resolvers
 * cannot produce is a compile error rather than a runtime null.
 *
 * These are API types, not domain types. They are deliberately a separate layer from the
 * `Appointment` union in `domain/` for the same reason the REST DTOs are: the schema is a
 * published contract that must stay stable while the domain model is free to change.
 */

export enum AppointmentStatusGql {
  REQUESTED = 'REQUESTED',
  CONFIRMED = 'CONFIRMED',
  COUNTER_PROPOSED = 'COUNTER_PROPOSED',
  DECLINED = 'DECLINED',
  CANCELLED = 'CANCELLED',
  COMPLETED = 'COMPLETED',
}

registerEnumType(AppointmentStatusGql, {
  name: 'AppointmentStatus',
  description: 'Lifecycle state of an appointment.',
});

export enum PartyGql {
  doctor = 'doctor',
  patient = 'patient',
}

registerEnumType(PartyGql, { name: 'Party' });

@ObjectType('Doctor')
export class DoctorGql {
  @Field(() => ID) id!: string;
  @Field() name!: string;
  @Field() specialty!: string;
  @Field({ description: 'IANA timezone identifier for the clinic.' })
  timezone!: string;
}

@ObjectType('Patient')
export class PatientGql {
  @Field(() => ID) id!: string;
  @Field() name!: string;
  @Field() timezone!: string;
}

@ObjectType('Slot')
export class SlotGql {
  @Field({ description: 'ISO 8601 instant.' }) startsAt!: string;
  @Field() endsAt!: string;
}

@ObjectType('Availability')
export class AvailabilityGql {
  @Field(() => ID) doctorId!: string;
  @Field() timezone!: string;
  @Field(() => [SlotGql]) slots!: SlotGql[];
}

@ObjectType('Appointment')
export class AppointmentGql {
  @Field(() => ID) id!: string;
  @Field(() => AppointmentStatusGql) status!: AppointmentStatusGql;

  @Field() startsAt!: string;
  @Field() endsAt!: string;
  @Field() requestedStartsAt!: string;
  @Field() requestedEndsAt!: string;

  @Field(() => String, { nullable: true }) proposedStartsAt!: string | null;
  @Field(() => String, { nullable: true }) proposedEndsAt!: string | null;

  @Field() createdAt!: string;

  /**
   * The ids stay on the type alongside the resolved objects.
   *
   * A client that only needs the id should not pay for a doctor lookup — even a batched
   * one. Exposing both lets the client choose, which is the whole selling point of
   * GraphQL, and it is what makes the N+1 test meaningful: requesting `doctorId` costs
   * nothing, requesting `doctor { name }` costs exactly one batched query.
   */
  @Field(() => ID) doctorId!: string;
  @Field(() => ID) patientId!: string;
}

/**
 * `patientId` removed — it comes from the session now. See the comment on
 * `requestAppointmentSchema` for why accepting a caller's own identifier from the caller
 * is the hole this phase closes.
 */
@InputType()
export class RequestAppointmentInputGql {
  @Field(() => ID) doctorId!: string;
  @Field() startsAt!: string;
  @Field() endsAt!: string;
}

@InputType()
export class ProposeInputGql {
  @Field() startsAt!: string;
  @Field() endsAt!: string;
}

@InputType()
export class AvailabilityInputGql {
  @Field(() => ID) doctorId!: string;
  @Field() from!: string;
  @Field() to!: string;
}

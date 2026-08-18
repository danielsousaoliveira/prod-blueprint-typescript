import type { Party } from '../../appointments/domain/appointment';

/**
 * Who someone is, and what they are allowed to be.
 *
 * ============================================================================
 * WHY `role` REUSES `Party` RATHER THAN DEFINING ITS OWN UNION
 * ============================================================================
 *
 * `Party = 'doctor' | 'patient'` already exists in the appointment domain, where it
 * answers "who acted" for the audit trail. Authorization asks a different question —
 * "who is allowed to act" — and the temptation is to define a separate `Role` type
 * because they are conceptually distinct.
 *
 * They are deliberately the same type here, because in this domain they are the same
 * set and keeping them identical is what makes the actor-aware transition table
 * typecheck without a conversion function sitting between two unions that always agree.
 * A conversion function between two identical unions is a place for them to silently
 * diverge.
 *
 * The moment a third role appears that cannot be a party to an appointment — an
 * administrator, a receptionist booking on a patient's behalf — this stops being true
 * and `Role` becomes its own union with an explicit mapping. That is the trigger, and
 * it is recorded in documented design choice.
 * ============================================================================
 */
export type Role = Party;

/**
 * A user account.
 *
 * Deliberately separate from the `doctors` and `patients` collections rather than adding
 * a password field to those. Three reasons:
 *
 *   1. A doctor's *profile* (name, specialty, timezone) is read constantly — it is joined
 *      onto every appointment by the DataLoader. Credentials are read once, at login.
 *      Keeping them in one document means every profile read pulls a password hash into
 *      memory and risks it reaching a DTO.
 *   2. The blast radius of an accidental `return doctor` is a leaked hash. Separation
 *      makes that mistake impossible rather than merely unlikely.
 *   3. Identity and profile have genuinely different lifecycles — an account can be
 *      locked, an email can change, a profile can exist for a doctor who has never
 *      logged in.
 */
export interface User {
  readonly id: string;
  /** Stored lowercased. The unique index is on the lowercased value — see migration 005. */
  readonly email: string;
  readonly passwordHash: string;
  readonly role: Role;
  /**
   * The id of the `doctors` or `patients` document this account acts as.
   *
   * This indirection is the whole point of the separation: `userId` identifies the
   * account, `profileId` identifies the thing appointments reference. Conflating them
   * would mean an appointment's `doctorId` is an authentication concern.
   */
  readonly profileId: string;
  readonly createdAt: number;
}

/**
 * The authenticated caller, as everything downstream sees them.
 *
 * This is the type that crosses into the domain layer, and it deliberately contains no
 * credential material and no framework types — the Phase 4 ESLint rule forbids
 * `@nestjs/common` and Express types in `application/` and `domain/`, and an actor
 * carrying a `Request` object would violate the spirit of that even where it passes the
 * letter.
 *
 * `passwordHash` is absent by construction rather than by remembering to omit it.
 */
export interface Actor {
  readonly userId: string;
  readonly role: Role;
  readonly profileId: string;
}

/** Strips everything an `Actor` must not carry. The only sanctioned way to build one. */
export function actorFor(user: Pick<User, 'id' | 'role' | 'profileId'>): Actor {
  return { userId: user.id, role: user.role, profileId: user.profileId };
}

import { z } from 'zod';
import type { Actor } from '../domain/user';

/**
 * Login input.
 *
 * ============================================================================
 * NOTE WHAT IS *NOT* VALIDATED HERE
 * ============================================================================
 *
 * There is no `.email()` check and no password complexity rule, and both omissions are
 * deliberate.
 *
 *   - **Email format**: a login is a lookup, not a registration. Rejecting a malformed
 *     address with a *validation* error tells an attacker their input never reached the
 *     credential check, which is a small oracle, and it gains nothing — an address that
 *     is not in the database fails anyway, on the constant-time path. Format validation
 *     belongs on the signup endpoint, where it is helping the user rather than leaking.
 *   - **Password rules**: enforcing "at least 8 characters" at login would reject a
 *     legitimate user whose password predates the rule, with a message that confirms
 *     their password is too short. Complexity rules belong where passwords are *set*.
 *
 * The only checks are non-emptiness (a blank submission is a client bug, not an
 * authentication attempt) and an upper bound, which exists so an attacker cannot send a
 * megabyte password and make the server spend argon2 time on it.
 * ============================================================================
 */
export const loginSchema = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
});

export type LoginBody = z.infer<typeof loginSchema>;

/**
 * What the client is told about itself.
 *
 * `userId` is deliberately absent. The frontend needs to know its role (which view to
 * render) and its `profileId` (which appointments are its own); the account id is an
 * internal identifier with no client use, and shipping identifiers a client does not need
 * is how they end up in URLs and logs.
 */
export interface SessionDto {
  readonly role: Actor['role'];
  readonly profileId: string;
}

export function toSessionDto(actor: Actor): SessionDto {
  return { role: actor.role, profileId: actor.profileId };
}

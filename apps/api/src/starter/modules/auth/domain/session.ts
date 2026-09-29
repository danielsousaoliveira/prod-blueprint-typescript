import { createHash, randomBytes } from 'node:crypto';
import type { Role } from './user';

/**
 * What a session actually stores.
 *
 * Note what is NOT here: no permissions list, no cached profile fields, no display name.
 * A session holds identity, and everything else is looked up. Caching authorization data
 * in a session is how you get a user whose access was revoked ten minutes ago still
 * making authorized calls — the session becomes a stale copy of a decision.
 */
export interface Session {
  readonly userId: string;
  readonly role: Role;
  readonly profileId: string;
  readonly createdAt: number;
}

/**
 * Generate a session id.
 *
 * ============================================================================
 * 32 CSPRNG BYTES, AND WHY NOT A UUID
 * ============================================================================
 *
 * A session id is a bearer token: whoever holds it *is* the user. So the only property
 * that matters is that it cannot be guessed or predicted, which makes this one of the
 * few places where the choice of random number generator is a security decision rather
 * than a style one.
 *
 * `randomBytes` is the CSPRNG. `Math.random()` is not — it is seeded predictably and its
 * output is reversible from a handful of samples. That is not a theoretical attack.
 *
 * 32 bytes = 256 bits. OWASP's floor is 128; the extra costs nothing and removes the
 * question. base64url so it survives a cookie value without escaping.
 *
 * Not a UUID: v4 UUIDs carry 122 bits of randomness in a 36-character string, and — more
 * importantly — "UUID" says nothing about the generator. Plenty of UUID libraries use
 * `Math.random()`. `crypto.randomUUID()` is genuinely fine, but it is fine by accident of
 * its implementation rather than by saying what it does, and a reader has to know that.
 * This says it.
 *
 * Not a JWT: a session id is opaque and carries no claims, so there is nothing in it to
 * verify, nothing to leak if it is decoded, and nothing that goes stale. That trade keeps
 * session identity server-side and opaque.
 * ============================================================================
 */
export function generateSessionId(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The Redis key for a session id.
 *
 * ============================================================================
 * THE STORE HOLDS A HASH OF THE ID, NEVER THE ID ITSELF
 * ============================================================================
 *
 * Same reasoning as not storing plaintext passwords, applied one layer out. A session id
 * is a live credential: anyone holding one is authenticated as that user until it
 * expires. If they are stored raw, then anything that can read the session store —
 * a Redis replica, a backup, an `KEYS *` from a debugging console, a misconfigured
 * `MONITOR`, an unauthenticated Redis on a shared network — hands over working sessions
 * for every logged-in user. No password cracking required; they are ready to use.
 *
 * Storing `sha256(id)` means a dump contains only verifiers. An attacker with the whole
 * database still cannot authenticate as anyone, because the value the server compares
 * against is not the value the cookie must contain.
 *
 * A plain SHA-256 is correct here, and specifically it should NOT be argon2: the input
 * is 256 bits of CSPRNG output, so there is no dictionary to attack and nothing for a
 * slow hash to defend. A slow hash would add its full cost to *every authenticated
 * request*, which is a real availability problem in exchange for nothing. Slow hashing
 * is for low-entropy secrets that humans chose.
 *
 * No salt for the same reason: salts defend against precomputed rainbow tables across
 * many users' identical low-entropy secrets. There is no rainbow table for 256-bit
 * random values.
 * ============================================================================
 */
export function sessionKey(sessionId: string): string {
  return `session:${createHash('sha256').update(sessionId).digest('hex')}`;
}

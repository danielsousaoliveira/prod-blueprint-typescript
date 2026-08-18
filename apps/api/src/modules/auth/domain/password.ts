import argon2 from 'argon2';

/**
 * Password hashing.
 *
 * ============================================================================
 * WHY ARGON2id, AND WHY THE PARAMETERS ARE WRITTEN DOWN
 * ============================================================================
 *
 * argon2id is the current OWASP recommendation and the Password Hashing Competition
 * winner. The property that matters is that it is *memory*-hard, not just slow: bcrypt
 * costs an attacker CPU, which GPUs and ASICs have in enormous quantity, while argon2's
 * memory cost is expensive to parallelise in silicon. The `id` variant specifically is
 * the hybrid — argon2i's side-channel resistance on the first pass, argon2d's
 * GPU-resistance on the rest.
 *
 * Parameters below are OWASP's minimum for argon2id (19 MiB, 2 iterations, 1 degree of
 * parallelism). They are stated explicitly rather than left to library defaults, because
 * a default that changes in a minor version silently changes the security properties of
 * every hash written after the upgrade — and nothing fails, which is the problem.
 *
 * The salt is generated per-hash by the library and embedded in the output string, along
 * with the parameters. That is why `verify` needs no parameters: the hash describes how
 * it was made. It is also what makes migrating parameters possible — see below.
 *
 * THE ALTERNATIVE: `node:crypto`'s `scrypt` is memory-hard, in the standard library, and
 * needs no native module. It is the right choice if argon2's native build is a problem
 * in a target environment (it needs a compiler or a prebuilt binary). bcrypt is the one
 * to avoid for new work: it silently truncates at 72 bytes, which turns a long
 * passphrase into a much shorter one without any error.
 * ============================================================================
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  /** 19 MiB. OWASP minimum for argon2id at t=2, p=1. */
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verify a password against a stored hash.
 *
 * Returns `false` rather than throwing on a malformed hash. A corrupt or truncated hash
 * in the database is an authentication failure, not a 500 — throwing would let an
 * attacker distinguish "this account has a broken hash" from "wrong password", and
 * would take the login endpoint down for that user in a way that looks like a server
 * bug rather than a data problem.
 */
export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    return false;
  }
}

/**
 * A hash of a value nobody knows, verified against when the email is unrecognised.
 *
 * ============================================================================
 * THIS IS NOT DECORATION — IT CLOSES A USER-ENUMERATION ORACLE
 * ============================================================================
 *
 * The obvious login implementation returns early when the email is not found:
 *
 *     const user = await repo.findByEmail(email);
 *     if (!user) return failure();              // ~1ms
 *     if (!await verify(user.hash, password))   // ~50ms — argon2 is slow BY DESIGN
 *       return failure();
 *
 * Both paths return an identical response, so the API looks safe. But the *timing*
 * differs by the entire cost of the hash, and that cost is deliberately large. An
 * attacker submits a list of candidate emails with a junk password and sorts by response
 * time: the slow ones are registered users. That is a membership disclosure, and for a
 * medical scheduling system "is this person a patient here" is itself sensitive —
 * arguably more sensitive than the password it protects.
 *
 * Verifying against this dummy hash makes the not-found path pay the same cost. It is
 * computed once at module load, so the delay is real work rather than a `sleep`, which
 * would be visible as a suspiciously constant response time.
 *
 * This is imperfect: argon2 timing varies slightly with the stored parameters, and a
 * determined attacker with enough samples can still find signal. The complete answer is
 * rate limiting (which this codebase also has) — timing equalisation raises the cost,
 * rate limiting caps the attempts.
 * ============================================================================
 */
let dummyHashPromise: Promise<string> | undefined;

export function dummyHash(): Promise<string> {
  // Lazily computed, then cached. Doing this at import time would add ~50ms to every
  // process start including every test file, for a value most of them never use.
  dummyHashPromise ??= hashPassword('this-password-belongs-to-no-account');
  return dummyHashPromise;
}

/**
 * Whether a stored hash was made with parameters we no longer consider adequate.
 *
 * Not wired into the login path in this project, but the reason it exists is worth
 * stating: raising the cost parameters does nothing for existing users, because their
 * hashes were made with the old ones. The only moment you can re-hash is when you
 * briefly hold the plaintext — during a successful login. A real deployment checks this
 * after verifying, and transparently re-hashes. Without it, "we upgraded our hashing"
 * means "we upgraded it for accounts created after Tuesday".
 */
export function needsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, ARGON2_OPTIONS);
}

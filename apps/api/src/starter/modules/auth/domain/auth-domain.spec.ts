import { dummyHash, hashPassword, needsRehash, verifyPassword } from './password';
import { generateSessionId, sessionKey } from './session';
import { actorFor } from './user';
import { normaliseEmail } from './user.repository';

/**
 * argon2 is deliberately slow (~50ms per hash at these parameters), and several tests
 * below hash more than once. The default 5s Jest timeout is enough but leaves little
 * margin on a loaded CI machine.
 */
jest.setTimeout(30_000);

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');

    await expect(verifyPassword(hash, 'correct horse battery staple')).resolves.toBe(
      true,
    );
    await expect(verifyPassword(hash, 'Correct horse battery staple')).resolves.toBe(
      false,
    );
  });

  it('produces a DIFFERENT hash for the same password every time', async () => {
    // Because the salt is random per hash. If these were ever equal, the scheme would be
    // unsalted: identical passwords would produce identical hashes, so a database leak
    // would immediately reveal which users share a password, and one cracked hash would
    // unlock all of them.
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');

    expect(a).not.toEqual(b);
    await expect(verifyPassword(a, 'same-password')).resolves.toBe(true);
    await expect(verifyPassword(b, 'same-password')).resolves.toBe(true);
  });

  it('records argon2id and its parameters IN the hash', async () => {
    // The parameters travel with the hash, which is what makes `verify` need no config
    // and what makes raising the cost later possible without invalidating old hashes.
    // Note the field order is `m,p,t`, not the `m,t,p` I first assumed from the order
    // the options are written in. The encoded form follows the PHC string spec, not the
    // library's option object — worth pinning precisely, because this string is what
    // `needsRehash` parses to decide whether a stored hash is still strong enough.
    const hash = await hashPassword('whatever');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
  });

  it('does not need a rehash at the current parameters', async () => {
    const hash = await hashPassword('whatever');
    expect(needsRehash(hash)).toBe(false);
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    // A corrupt hash in the database is an authentication failure, not a 500. Throwing
    // would take login down for that one user in a way that looks like a server bug.
    await expect(verifyPassword('not-a-hash', 'anything')).resolves.toBe(false);
    await expect(verifyPassword('', 'anything')).resolves.toBe(false);
    await expect(verifyPassword('$argon2id$truncated', 'anything')).resolves.toBe(false);
  });

  it('handles a long passphrase without silently truncating it', async () => {
    // bcrypt truncates at 72 bytes, so two different long passphrases sharing a prefix
    // both authenticate. argon2 has no such limit — this test is the reason bcrypt was
    // not chosen.
    const prefix = 'a'.repeat(72);
    const hash = await hashPassword(`${prefix}-one`);

    await expect(verifyPassword(hash, `${prefix}-one`)).resolves.toBe(true);
    await expect(verifyPassword(hash, `${prefix}-two`)).resolves.toBe(false);
  });

  it('the dummy hash is a real argon2 hash that nothing matches', async () => {
    // If this were a constant string rather than a real hash, verifying against it would
    // return instantly and the timing oracle it exists to close would be wide open.
    const hash = await dummyHash();

    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(hash, '')).resolves.toBe(false);
    await expect(verifyPassword(hash, 'password')).resolves.toBe(false);
  });

  it('the dummy hash is computed once and cached', async () => {
    // It is on the login path for every unknown email, so recomputing it would add ~50ms
    // of pure waste to exactly the requests an attacker sends most of.
    const [first, second] = await Promise.all([dummyHash(), dummyHash()]);
    expect(first).toBe(second);
  });
});

describe('session ids', () => {
  it('produces 256 bits, url-safe', () => {
    const id = generateSessionId();

    // 32 bytes base64url-encoded, unpadded.
    expect(id).toHaveLength(43);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never repeats', () => {
    // A weak generator is the difference between "unguessable" and "sequential". A
    // thousand samples will not detect a subtly biased CSPRNG, but it will catch the
    // catastrophic mistakes — a counter, a timestamp, a constant.
    const ids = new Set(Array.from({ length: 1000 }, () => generateSessionId()));
    expect(ids.size).toBe(1000);
  });

  it('the stored key is a HASH of the id, not the id', () => {
    // The property that makes a leaked Redis dump useless: the value the server compares
    // against is not the value the cookie must contain.
    const id = generateSessionId();
    const key = sessionKey(id);

    expect(key).toMatch(/^session:[0-9a-f]{64}$/);
    expect(key).not.toContain(id);
  });

  it('is deterministic, so the same cookie finds the same session', () => {
    const id = generateSessionId();
    expect(sessionKey(id)).toBe(sessionKey(id));
    expect(sessionKey(id)).not.toBe(sessionKey(generateSessionId()));
  });
});

describe('email normalisation', () => {
  it('lowercases and trims', () => {
    // The unique index is on the normalised value, so a signup that skipped this would
    // create a second account for an address that already exists.
    expect(normaliseEmail('  Doctor@Clinic.TEST ')).toBe('doctor@clinic.test');
    expect(normaliseEmail('doctor@clinic.test')).toBe('doctor@clinic.test');
  });
});

describe('actorFor', () => {
  it('cannot carry a password hash', () => {
    // The type forbids it, but this asserts the runtime shape too: an `Actor` is what
    // crosses into the domain and eventually into logs, and a hash reaching either is a
    // disclosure.
    const actor = actorFor({ id: 'u-1', role: 'doctor', profileId: 'doctor-1' });

    expect(actor).toEqual({ userId: 'u-1', role: 'doctor', profileId: 'doctor-1' });
    expect(Object.keys(actor)).not.toContain('passwordHash');
    expect(Object.keys(actor)).toHaveLength(3);
  });
});

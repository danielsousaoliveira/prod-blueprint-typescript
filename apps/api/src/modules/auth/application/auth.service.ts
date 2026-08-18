import { Inject, Injectable } from '@nestjs/common';
import {
  USER_REPOSITORY,
  normaliseEmail,
  type UserRepository,
} from '../domain/user.repository';
import { actorFor, type Actor } from '../domain/user';
import { dummyHash, verifyPassword } from '../domain/password';
import { generateSessionId, type Session } from '../domain/session';
import { LoginRateLimiter } from './login-rate-limiter';
import { SESSION_STORE, type SessionStore } from './session.store';

/**
 * Why this is a discriminated union rather than `Actor | null`:
 *
 * The three failure modes need different HTTP responses (429 vs 401) but must NOT produce
 * different responses for the two 401 cases. Modelling them separately here, and
 * collapsing them at the edge, keeps that collapse deliberate and visible in one place
 * instead of being an accident of how the service happened to return.
 */
export type LoginResult =
  | { readonly ok: true; readonly sessionId: string; readonly actor: Actor }
  | { readonly ok: false; readonly reason: 'INVALID_CREDENTIALS' | 'RATE_LIMITED' };

@Injectable()
export class AuthService {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(SESSION_STORE) private readonly sessions: SessionStore,
    private readonly rateLimiter: LoginRateLimiter,
  ) {}

  /**
   * Verify credentials and start a session.
   *
   * ============================================================================
   * THE CONTROL FLOW HERE IS THE SECURITY PROPERTY. READ THE ORDER.
   * ============================================================================
   *
   * Every step below is placed where it is for a reason, and the natural, readable
   * version of this function — early return when the user is not found — is the insecure
   * one. See `dummyHash` in domain/password.ts for the full argument.
   *
   * The invariant: **the unknown-email path and the wrong-password path must be
   * indistinguishable in both response content and response time.**
   * ============================================================================
   */
  async login(rawEmail: string, password: string, ip: string): Promise<LoginResult> {
    const email = normaliseEmail(rawEmail);

    // 1. Rate limit FIRST, before any expensive work. Checking after the hash would mean
    //    an attacker still gets to spend our CPU on every attempt they make.
    if (await this.rateLimiter.isBlocked(email, ip)) {
      return { ok: false, reason: 'RATE_LIMITED' };
    }

    const user = await this.users.findByEmail(email);

    // 2. No early return on a missing user. Verify against a hash of a value nobody knows,
    //    so this path costs the same ~50ms as a real verification. The result is discarded
    //    — argon2 will not match, but the POINT is that it took just as long to find out.
    const hash = user?.passwordHash ?? (await dummyHash());
    const passwordMatches = await verifyPassword(hash, password);

    // 3. `user &&` comes after the verification, never instead of it.
    if (!user || !passwordMatches) {
      await this.rateLimiter.recordFailure(email, ip);
      return { ok: false, reason: 'INVALID_CREDENTIALS' };
    }

    // 4. Clear counters on success, so honest typos do not accumulate toward a lockout.
    await this.rateLimiter.clear(email, ip);

    // 5. A brand-new id, always. There is no pre-authentication session in this design to
    //    upgrade, which is what makes session fixation structurally impossible here: an
    //    attacker cannot plant a known session id and have it become authenticated,
    //    because logging in never reuses an existing id.
    const sessionId = generateSessionId();
    const session: Session = {
      userId: user.id,
      role: user.role,
      profileId: user.profileId,
      createdAt: Date.now(),
    };

    await this.sessions.create(sessionId, session);

    return { ok: true, sessionId, actor: actorFor(user) };
  }

  /**
   * Resolve a session id to an actor.
   *
   * Called on every authenticated request by the guard. Returns null for absent, expired,
   * unparseable, or destroyed sessions — the caller cannot distinguish those, and should
   * not: every one of them means "not authenticated", and reporting which would tell an
   * attacker whether a guessed id ever existed.
   */
  async resolve(sessionId: string): Promise<Actor | null> {
    const session = await this.sessions.resolve(sessionId);
    if (!session) return null;

    return {
      userId: session.userId,
      role: session.role,
      profileId: session.profileId,
    };
  }

  /**
   * Destroy a session.
   *
   * Deliberately idempotent and silent about whether anything was there. Logging out a
   * session that has already expired is a success from the caller's point of view — the
   * desired state ("this session is not usable") holds either way, and reporting "no such
   * session" would be an existence oracle on session ids for no benefit.
   */
  async logout(sessionId: string): Promise<void> {
    await this.sessions.destroy(sessionId);
  }
}

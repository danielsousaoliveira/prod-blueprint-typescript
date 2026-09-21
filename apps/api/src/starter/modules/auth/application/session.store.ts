import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../../../config/env';
import { RedisService } from '../../../infra/redis.service';
import { sessionKey, type Session } from '../domain/session';

export interface SessionStore {
  create(sessionId: string, session: Session): Promise<void>;
  /** Returns the session and extends its lifetime, or null if absent/expired. */
  resolve(sessionId: string): Promise<Session | null>;
  destroy(sessionId: string): Promise<void>;
}

export const SESSION_STORE = Symbol('SESSION_STORE');

/**
 * Sessions in Redis.
 *
 * ============================================================================
 * WHY SERVER-SIDE STATE RATHER THAN A SELF-CONTAINED TOKEN
 * ============================================================================
 *
 * The single reason: **revocation**. Logout here is a `DEL`, and the session is dead on
 * the very next request. A JWT cannot be un-issued — it is valid until it expires, so
 * "log out everywhere", "this account is compromised" and "this employee left" are all
 * unimplementable without a denylist, and a denylist is a server-side session store with
 * extra steps and inverted logic.
 *
 * The honest cost is that authentication is now stateful: every authenticated request
 * costs a Redis round trip, and if Redis is down nobody is logged in. That second part
 * is why this is a real trade rather than a free win. Mitigations at scale are Redis
 * replication and treating auth as a hard dependency in the readiness check — which
 * `/health` already does, so an instance with a broken Redis stops receiving traffic
 * rather than serving mysterious 401s.
 *
 * Redis is the right store for exactly this shape of data: ephemeral, keyed by one id,
 * read on every request, and with expiry as a first-class feature rather than a cleanup
 * job. Putting sessions in MongoDB would mean writing a TTL index and paying durability
 * costs for data whose whole lifecycle is measured in days.
 * ============================================================================
 */
@Injectable()
export class RedisSessionStore implements SessionStore {
  constructor(
    private readonly redis: RedisService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async create(sessionId: string, session: Session): Promise<void> {
    // Note `sessionKey` — what lands in Redis is a hash of the id, never the id. See the
    // long comment in domain/session.ts for why that matters.
    await this.redis.client.set(
      sessionKey(sessionId),
      JSON.stringify(session),
      'EX',
      this.env.SESSION_TTL_SECONDS,
    );
  }

  /**
   * Read a session and slide its expiry.
   *
   * ============================================================================
   * SLIDING EXPIRY, AND THE TRADE IT MAKES
   * ============================================================================
   *
   * Without this, the TTL is an *absolute* lifetime: a user who logs in and works
   * continuously is thrown out mid-task exactly 7 days later, having done nothing wrong.
   * Sliding expiry means "7 days of inactivity" instead of "7 days", which is what users
   * actually expect from "remember me".
   *
   * The security cost is real and worth naming: a session that is used regularly never
   * expires, so a stolen cookie stays valid indefinitely as long as the attacker keeps
   * using it. The complete answer is a second, absolute cap — re-authenticate after 30
   * days no matter what — which is what a bank does and what I would add if this held
   * anything more sensitive than appointment times. It is not built here, and that is a
   * deliberate omission rather than an oversight.
   *
   * `EXPIRE` is issued unconditionally after a hit rather than being pipelined with the
   * `GET`. A pipeline would be one round trip instead of two, but it would also reset the
   * TTL on a key that turned out not to exist — harmless, yet it makes the code read as
   * though a missing session is refreshable. The clarity is worth the round trip at this
   * scale; at 100x it becomes a Lua script that does both atomically.
   * ============================================================================
   */
  async resolve(sessionId: string): Promise<Session | null> {
    const key = sessionKey(sessionId);
    const raw = await this.redis.client.get(key);
    if (raw === null) return null;

    const session = this.parse(raw);
    if (!session) {
      // Unparseable payload: treat as no session AND remove it. Leaving it would mean
      // re-parsing garbage on every request until its TTL runs out.
      await this.redis.client.del(key);
      return null;
    }

    await this.redis.client.expire(key, this.env.SESSION_TTL_SECONDS);
    return session;
  }

  async destroy(sessionId: string): Promise<void> {
    await this.redis.client.del(sessionKey(sessionId));
  }

  /**
   * Anything read back from an external store is untrusted input, even though this
   * process wrote it. A schema change, a manual edit, or a half-written value should
   * fail closed as "not authenticated" rather than producing an `Actor` with undefined
   * fields that then flows into an authorization check.
   */
  private parse(raw: string): Session | null {
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value !== 'object' || value === null) return null;

      const { userId, role, profileId, createdAt } = value as Record<string, unknown>;
      if (typeof userId !== 'string' || userId.length === 0) return null;
      if (role !== 'doctor' && role !== 'patient') return null;
      if (typeof profileId !== 'string' || profileId.length === 0) return null;
      if (typeof createdAt !== 'number') return null;

      return { userId, role, profileId, createdAt };
    } catch {
      return null;
    }
  }
}

import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../../../config/env';
import { RedisService } from '../../../infra/redis.service';

/**
 * Brute-force protection for the login endpoint.
 *
 * ============================================================================
 * WHY A SLOW HASH IS NOT ENOUGH ON ITS OWN
 * ============================================================================
 *
 * argon2 makes each guess expensive — for the *attacker* if they stole the database, but
 * for the *server* if they are guessing online. Against a live login endpoint, a slow
 * hash means an attacker submitting a thousand passwords per second is asking the server
 * to perform a thousand memory-hard computations per second. The password holds; the
 * service falls over. Password hashing cost and online brute-force protection solve
 * different problems, and only having the first turns a credential attack into a
 * denial-of-service one.
 *
 * So the counter is incremented BEFORE the hash is verified. Checking the limit after
 * doing the expensive work would defeat the entire purpose.
 * ============================================================================
 *
 * ============================================================================
 * KEYED ON BOTH EMAIL AND IP, BECAUSE EACH ALONE HAS A HOLE
 * ============================================================================
 *
 *   - **Email only**: an attacker locks any account out of their own service by
 *     deliberately failing logins against it. Availability attack, trivially executed.
 *   - **IP only**: password spraying walks right past it — one attempt each against ten
 *     thousand accounts never trips a per-IP counter tuned for repeated failures, and
 *     "one common password against every account" is how these attacks actually work.
 *     A NAT'd office or a mobile carrier also shares one IP among many legitimate users.
 *
 * Both counters run, and either one tripping is enough. The email counter is the tighter
 * one; the IP counter is looser and catches spraying.
 *
 * Counters are cleared on a SUCCESSFUL login, so a user who mistypes twice and then gets
 * it right is not carrying a partial strike for the next hour.
 * ============================================================================
 */
@Injectable()
export class LoginRateLimiter {
  constructor(
    private readonly redis: RedisService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** True when this attempt should be refused without touching the password hash. */
  async isBlocked(email: string, ip: string): Promise<boolean> {
    const [byEmail, byIp] = await Promise.all([
      this.redis.client.get(this.emailKey(email)),
      this.redis.client.get(this.ipKey(ip)),
    ]);

    return (
      Number(byEmail ?? 0) >= this.env.AUTH_MAX_ATTEMPTS_PER_EMAIL ||
      Number(byIp ?? 0) >= this.env.AUTH_MAX_ATTEMPTS_PER_IP
    );
  }

  /**
   * Record a failed attempt.
   *
   * `INCR` then `EXPIRE`, and the `EXPIRE` is issued every time rather than only on the
   * first increment. That makes the window *sliding* — sustained attempts keep the block
   * alive rather than letting an attacker wait out a fixed window and resume. The cost is
   * that a user genuinely locked out has to stop trying for the full window, which is the
   * intended behaviour.
   */
  async recordFailure(email: string, ip: string): Promise<void> {
    const window = this.env.AUTH_ATTEMPT_WINDOW_SECONDS;
    await this.redis.client
      .multi()
      .incr(this.emailKey(email))
      .expire(this.emailKey(email), window)
      .incr(this.ipKey(ip))
      .expire(this.ipKey(ip), window)
      .exec();
  }

  async clear(email: string, ip: string): Promise<void> {
    await this.redis.client.del(this.emailKey(email), this.ipKey(ip));
  }

  /**
   * The email is hashed into the key rather than embedded raw.
   *
   * Redis keys show up in `SCAN` output, in slow logs, and in monitoring dashboards. A
   * key literally named `login-fail:email:alice@example.com` turns the cache into an
   * incidental directory of user email addresses, readable by anyone with metrics access
   * and no database permissions at all. Same instinct as hashing the session id.
   */
  private emailKey(email: string): string {
    return `login-fail:email:${hashish(email)}`;
  }

  private ipKey(ip: string): string {
    return `login-fail:ip:${hashish(ip)}`;
  }
}

/**
 * Truncated to 32 hex characters. This is a key-naming concern, not a security boundary
 * — 128 bits is far beyond enough to avoid collisions between counter buckets, and a
 * collision would only merge two users' failure counts rather than authenticate anyone.
 */
function hashish(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

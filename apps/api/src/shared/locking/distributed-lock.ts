import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RedisService } from '../../infra/redis.service';

/**
 * A Redis distributed lock — and an explicit statement that it is NOT the double-booking
 * guarantee.
 *
 * ============================================================================
 * WHY THIS IS NOT THE CORRECTNESS MECHANISM
 * ============================================================================
 *
 * A lock with a TTL cannot be a correctness guarantee in a distributed system, for a
 * reason that has nothing to do with implementation quality:
 *
 *   1. Process A acquires the lock with a 5-second TTL.
 *   2. Process A stalls — GC pause, CPU starvation, a slow network call.
 *   3. The TTL expires. Redis releases the lock.
 *   4. Process B acquires the same lock and starts working.
 *   5. Process A wakes up, still believing it holds the lock, and writes.
 *
 * Two processes are now in the critical section. No amount of care in the lock code
 * prevents this: the lock holder cannot know it has been evicted, and shortening or
 * lengthening the TTL only changes which failure you get. Redis failover makes it worse —
 * an unreplicated lock is simply lost.
 *
 * This is the fencing-token problem. The only reliable fix is for the RESOURCE to reject
 * writes from a stale holder, which means the resource needs the guarantee — at which
 * point the lock is no longer providing it.
 *
 * In this system the resource does exactly that: the partial unique index on
 * (doctorId, startsAt) rejects the second write atomically, whatever any lock believed.
 * That is the guarantee. The lock is a performance optimisation layered on top, and if it
 * malfunctions the worst outcome is a duplicate-key error the code already handles.
 *
 * ============================================================================
 * SO WHAT IS IT FOR — AND WOULD I SHIP IT HERE?
 * ============================================================================
 *
 * Contention reduction. Under heavy contention for one slot, failing fast on a lock is
 * cheaper than sending every request to MongoDB to be rejected: it saves a round trip,
 * index work, and error construction per loser.
 *
 * Honestly: at this project's contention level that trade is NEGATIVE. It adds a network
 * round trip to every booking to avoid an error path that is already correct and rare,
 * and it adds a dependency that can fail. I would not ship it here.
 *
 * It is built because comparing the three approaches — unique index, optimistic
 * concurrency, distributed lock — is a stated goal, and because "I know why the lock
 * isn't the guarantee" is worth much more than a lock that works.
 */
export interface DistributedLock {
  /** Returns a release function, or null when the lock is held by someone else. */
  acquire(key: string, ttlMs: number): Promise<(() => Promise<void>) | null>;
}

export const DISTRIBUTED_LOCK = Symbol('DISTRIBUTED_LOCK');

/**
 * Releasing checks the token before deleting.
 *
 * Without the check, a process whose lock had already expired would delete a lock now
 * held by someone ELSE — actively causing the concurrency bug the lock was meant to
 * reduce. The check and the delete must be atomic, hence Lua: a GET-then-DEL in two
 * commands has the same race in miniature.
 */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

@Injectable()
export class RedisDistributedLock implements DistributedLock {
  constructor(private readonly redis: RedisService) {}

  async acquire(key: string, ttlMs: number): Promise<(() => Promise<void>) | null> {
    // A unique token per acquisition — this is what makes "is this still my lock?"
    // answerable at release time.
    const token = randomUUID();
    const redisKey = `lock:${key}`;

    const acquired = await this.redis.client.set(redisKey, token, 'PX', ttlMs, 'NX');
    if (acquired !== 'OK') return null;

    return async () => {
      await this.redis.client.eval(RELEASE_SCRIPT, 1, redisKey, token);
    };
  }
}

/** In-memory twin. Single-process only, which is the point — see the note above. */
@Injectable()
export class InMemoryDistributedLock implements DistributedLock {
  private readonly held = new Map<string, number>();

  acquire(key: string, ttlMs: number): Promise<(() => Promise<void>) | null> {
    const now = Date.now();
    const expiry = this.held.get(key);

    if (expiry !== undefined && expiry > now) return Promise.resolve(null);

    this.held.set(key, now + ttlMs);
    return Promise.resolve(async () => {
      this.held.delete(key);
      return Promise.resolve();
    });
  }
}

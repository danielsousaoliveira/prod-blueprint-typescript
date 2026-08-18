import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../../infra/redis.service';
import type { DoctorAvailability } from './availability.service';

/**
 * Redis cache for computed availability, with VERSION-BASED invalidation.
 *
 * ============================================================================
 * WHY A VERSION COUNTER RATHER THAN DELETING KEYS
 * ============================================================================
 *
 * One doctor's availability is cached under many keys — one per requested window. So
 * "this doctor's schedule changed, drop their cache" has to invalidate an unknown number
 * of keys. The obvious implementations are both bad:
 *
 *   KEYS avail:doctor-1:*   -> O(n) over the ENTIRE keyspace and it BLOCKS Redis while it
 *                              runs. On a production instance this is an outage.
 *   SCAN + DEL              -> non-blocking, but still O(n) over the keyspace, needs
 *                              cursor management, and races with concurrent writes.
 *
 * Instead the key embeds a per-doctor version:
 *
 *   avail:{doctorId}:v{version}:{from}:{to}
 *
 * Invalidation is `INCR avail-version:{doctorId}` — a single O(1) command. Every existing
 * key instantly becomes unreachable because no future read will ever construct the old
 * key again, and the orphans expire on their own TTL. Constant-time invalidation of an
 * arbitrary number of keys, with no scanning and no blocking.
 *
 * The cost is that orphaned keys occupy memory until their TTL elapses. That is a bounded,
 * predictable cost, and it is a much better trade than a blocking command.
 * ============================================================================
 *
 * TTL is kept as well, as a safety net. Explicit invalidation is correct only if EVERY
 * write path remembers to call it; the TTL bounds the damage when one forgets. Belt and
 * braces, because the failure mode of a missed invalidation is showing a patient a slot
 * that is already taken.
 */

/** Short: availability is high-churn and staleness is directly user-visible. */
export const AVAILABILITY_TTL_SECONDS = 60;

@Injectable()
export class AvailabilityCache {
  private readonly logger = new Logger(AvailabilityCache.name);

  constructor(private readonly redis: RedisService) {}

  private static versionKey(doctorId: string): string {
    return `avail-version:${doctorId}`;
  }

  private static entryKey(
    doctorId: string,
    version: string,
    from: number,
    to: number,
  ): string {
    return `avail:${doctorId}:v${version}:${from}:${to}`;
  }

  private async currentVersion(doctorId: string): Promise<string> {
    // Absent means version 0 — a doctor whose cache has never been invalidated.
    return (await this.redis.client.get(AvailabilityCache.versionKey(doctorId))) ?? '0';
  }

  async get(
    doctorId: string,
    from: number,
    to: number,
  ): Promise<DoctorAvailability | null> {
    try {
      const version = await this.currentVersion(doctorId);
      const raw = await this.redis.client.get(
        AvailabilityCache.entryKey(doctorId, version, from, to),
      );
      return raw ? (JSON.parse(raw) as DoctorAvailability) : null;
    } catch (error) {
      // A cache is an optimisation. If Redis is down the request must still succeed by
      // computing the answer — failing the request because the CACHE is unavailable
      // converts a degraded dependency into an outage.
      this.logger.warn(`Availability cache read failed: ${String(error)}`);
      return null;
    }
  }

  async set(
    doctorId: string,
    from: number,
    to: number,
    value: DoctorAvailability,
  ): Promise<void> {
    try {
      const version = await this.currentVersion(doctorId);
      await this.redis.client.set(
        AvailabilityCache.entryKey(doctorId, version, from, to),
        JSON.stringify(value),
        'EX',
        AVAILABILITY_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(`Availability cache write failed: ${String(error)}`);
    }
  }

  /**
   * Invalidate everything cached for this doctor, in one O(1) command.
   *
   * Called from every write path that could change availability: a booking, a
   * cancellation, a schedule edit, a new exception. Missing one is the classic cache bug,
   * which is why the TTL exists underneath.
   */
  async invalidate(doctorId: string): Promise<void> {
    try {
      await this.redis.client.incr(AvailabilityCache.versionKey(doctorId));
    } catch (error) {
      // A failed invalidation is more serious than a failed read — it means stale data
      // stays visible until the TTL expires. Logged at error level accordingly.
      this.logger.error(`Availability cache invalidation failed: ${String(error)}`);
    }
  }
}

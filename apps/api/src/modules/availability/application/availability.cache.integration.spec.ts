import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import type { RedisService } from '../../../infra/redis.service';
import { AVAILABILITY_TTL_SECONDS, AvailabilityCache } from './availability.cache';
import type { DoctorAvailability } from './availability.service';

jest.setTimeout(180_000);

let container: StartedRedisContainer;
let client: Redis;
let cache: AvailabilityCache;

const availability = (slotCount: number): DoctorAvailability => ({
  doctorId: 'doctor-1',
  timezone: 'Europe/Lisbon',
  slots: Array.from({ length: slotCount }, (_, i) => ({
    startsAt: 1_000_000 + i * 1_800_000,
    endsAt: 1_000_000 + (i + 1) * 1_800_000,
  })),
});

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  client = new Redis(container.getConnectionUrl());
});

afterAll(async () => {
  await client?.quit();
  await container?.stop();
});

beforeEach(async () => {
  await client.flushall();
  cache = new AvailabilityCache({ client } as unknown as RedisService);
});

describe('AvailabilityCache', () => {
  it('round-trips a cached value', async () => {
    await cache.set('doctor-1', 100, 200, availability(8));
    expect(await cache.get('doctor-1', 100, 200)).toEqual(availability(8));
  });

  it('misses for a different window', async () => {
    await cache.set('doctor-1', 100, 200, availability(8));
    expect(await cache.get('doctor-1', 300, 400)).toBeNull();
  });

  it('misses for a different doctor', async () => {
    await cache.set('doctor-1', 100, 200, availability(8));
    expect(await cache.get('doctor-2', 100, 200)).toBeNull();
  });

  it('sets a TTL as the safety net for a missed invalidation', async () => {
    await cache.set('doctor-1', 100, 200, availability(8));

    const keys = await client.keys('avail:doctor-1:*');
    expect(keys).toHaveLength(1);

    const ttl = await client.ttl(keys[0] ?? '');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(AVAILABILITY_TTL_SECONDS);
  });
});

describe('version-based invalidation', () => {
  it('invalidates EVERY window for a doctor in one command', async () => {
    // The property that motivates the design. Three cached windows, one INCR, all gone —
    // with no key scanning and no blocking command.
    await cache.set('doctor-1', 100, 200, availability(8));
    await cache.set('doctor-1', 300, 400, availability(4));
    await cache.set('doctor-1', 500, 600, availability(2));

    await cache.invalidate('doctor-1');

    expect(await cache.get('doctor-1', 100, 200)).toBeNull();
    expect(await cache.get('doctor-1', 300, 400)).toBeNull();
    expect(await cache.get('doctor-1', 500, 600)).toBeNull();
  });

  it('does NOT invalidate other doctors', async () => {
    await cache.set('doctor-1', 100, 200, availability(8));
    await cache.set('doctor-2', 100, 200, availability(4));

    await cache.invalidate('doctor-1');

    expect(await cache.get('doctor-1', 100, 200)).toBeNull();
    expect(await cache.get('doctor-2', 100, 200)).toEqual(availability(4));
  });

  it('leaves orphaned keys behind, which is the accepted trade', async () => {
    // Being explicit about the cost rather than pretending it away. Invalidation does not
    // delete anything — the old keys are simply unreachable because no future read will
    // construct their name again, and they expire on their own TTL.
    //
    // That is the trade: bounded wasted memory for a constant-time, non-blocking
    // invalidation. `SCAN`+`DEL` would reclaim it immediately at O(keyspace) cost.
    await cache.set('doctor-1', 100, 200, availability(8));
    await cache.invalidate('doctor-1');

    const keys = await client.keys('avail:doctor-1:*');
    // The old key still exists...
    expect(keys).toHaveLength(1);
    // ...but is unreachable through the cache API.
    expect(await cache.get('doctor-1', 100, 200)).toBeNull();
  });

  it('is repeatable — successive invalidations keep advancing the version', async () => {
    await cache.set('doctor-1', 100, 200, availability(8));
    await cache.invalidate('doctor-1');
    await cache.set('doctor-1', 100, 200, availability(4));
    await cache.invalidate('doctor-1');

    expect(await cache.get('doctor-1', 100, 200)).toBeNull();
    expect(await client.get('avail-version:doctor-1')).toBe('2');
  });
});

describe('degradation when Redis is unavailable', () => {
  it('returns a miss rather than throwing', async () => {
    // A cache is an optimisation. If Redis is down the request must still succeed by
    // computing the answer — failing the request because the CACHE is unavailable turns a
    // degraded dependency into a full outage, which is strictly worse than being slow.
    const broken = new AvailabilityCache({
      client: {
        get: () => Promise.reject(new Error('connection refused')),
        set: () => Promise.reject(new Error('connection refused')),
        incr: () => Promise.reject(new Error('connection refused')),
      },
    } as unknown as RedisService);

    await expect(broken.get('doctor-1', 100, 200)).resolves.toBeNull();
    await expect(
      broken.set('doctor-1', 100, 200, availability(8)),
    ).resolves.toBeUndefined();
    await expect(broken.invalidate('doctor-1')).resolves.toBeUndefined();
  });
});

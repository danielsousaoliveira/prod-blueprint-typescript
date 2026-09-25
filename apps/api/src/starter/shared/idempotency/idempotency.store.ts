import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { RedisService } from '../../infra/redis.service';

/**
 * Idempotency-Key support.
 *
 * The problem: a client sends a booking request, the network drops the response, the
 * client retries. Without idempotency that is two appointments. With it, the retry
 * returns the original outcome.
 *
 * The part naive implementations get wrong is the SAME KEY WITH A DIFFERENT BODY. Simply
 * replaying the stored response there is a silent data-loss bug: the client asked for a
 * 10:00 appointment, got told "created" about the 09:00 one they sent earlier, and
 * nothing anywhere records that their actual request was discarded. So the request body
 * is hashed and compared, and a mismatch is an error rather than a replay.
 *
 * The second thing worth handling: a key that is currently IN FLIGHT. Two concurrent
 * requests with the same key must not both execute. The record is claimed atomically
 * before the work starts, and the second caller is told to retry rather than racing.
 */

export type IdempotencyRecord =
  | { readonly state: 'in-flight'; readonly requestHash: string }
  | {
      readonly state: 'completed';
      readonly requestHash: string;
      readonly status: number;
      readonly body: unknown;
    };

export interface IdempotencyStore {
  /**
   * Atomically claim `key` for a request with this hash.
   *
   * Returns `null` when the claim succeeded and the caller should do the work, or the
   * EXISTING record when the key was already used — which the caller must then
   * interpret (replay it, reject a hash mismatch, or report an in-flight conflict).
   */
  claim(key: string, requestHash: string): Promise<IdempotencyRecord | null>;
  complete(key: string, status: number, body: unknown): Promise<void>;
  /** Release a claim when the work failed, so a retry is not blocked forever. */
  release(key: string): Promise<void>;
}

export const IDEMPOTENCY_STORE = Symbol('IDEMPOTENCY_STORE');

/**
 * Stable hash of the request body.
 *
 * Keys are sorted so `{a:1,b:2}` and `{b:2,a:1}` hash identically — they are the same
 * request, and a client that serialises its JSON in a different order on retry must not
 * be told its body changed.
 */
export function hashRequest(body: unknown): string {
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);

  return `{${entries.join(',')}}`;
}

/** 24 hours: long enough for any realistic client retry, short enough to bound storage. */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

@Injectable()
export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(private readonly redis: RedisService) {}

  private static key(key: string): string {
    return `idem:${key}`;
  }

  /**
   * `SET key value NX EX ttl` — set only if absent, with expiry, in one atomic command.
   *
   * The atomicity is the whole point. A GET-then-SET would let two concurrent requests
   * with the same key both see "absent" and both proceed, which is exactly the
   * duplicate this feature exists to prevent.
   */
  async claim(key: string, requestHash: string): Promise<IdempotencyRecord | null> {
    const record: IdempotencyRecord = { state: 'in-flight', requestHash };

    const result = await this.redis.client.set(
      RedisIdempotencyStore.key(key),
      JSON.stringify(record),
      'EX',
      IDEMPOTENCY_TTL_SECONDS,
      'NX',
    );

    if (result === 'OK') return null;

    const existing = await this.redis.client.get(RedisIdempotencyStore.key(key));
    // A race: the key expired between the failed SET and this GET. Treat it as claimed
    // rather than inventing a conflict.
    return existing ? (JSON.parse(existing) as IdempotencyRecord) : null;
  }

  async complete(key: string, status: number, body: unknown): Promise<void> {
    const raw = await this.redis.client.get(RedisIdempotencyStore.key(key));
    if (!raw) return;

    const existing = JSON.parse(raw) as IdempotencyRecord;
    const completed: IdempotencyRecord = {
      state: 'completed',
      requestHash: existing.requestHash,
      status,
      body,
    };

    // Preserve the original TTL rather than extending it — the window starts when the
    // client first sent the request, not when it happened to finish.
    await this.redis.client.set(
      RedisIdempotencyStore.key(key),
      JSON.stringify(completed),
      'KEEPTTL',
    );
  }

  async release(key: string): Promise<void> {
    await this.redis.client.del(RedisIdempotencyStore.key(key));
  }
}

/** In-memory twin for unit tests. */
@Injectable()
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly store = new Map<string, IdempotencyRecord>();

  claim(key: string, requestHash: string): Promise<IdempotencyRecord | null> {
    const existing = this.store.get(key);
    if (existing) return Promise.resolve(existing);
    this.store.set(key, { state: 'in-flight', requestHash });
    return Promise.resolve(null);
  }

  complete(key: string, status: number, body: unknown): Promise<void> {
    const existing = this.store.get(key);
    if (existing) {
      this.store.set(key, {
        state: 'completed',
        requestHash: existing.requestHash,
        status,
        body,
      });
    }
    return Promise.resolve();
  }

  release(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }
}

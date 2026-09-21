import { Injectable } from '@nestjs/common';
import type { Collection } from 'mongodb';
import { MongoService } from '../../../infra/mongo.service';
import {
  OUTBOX_COLLECTION,
  type OutboxMessage,
  type OutboxRepository,
} from '../domain/outbox';

/** How long a claimed-but-unpublished message stays claimed before another relay retries. */
export const CLAIM_TTL_MS = 30_000;

export interface OutboxDocument extends Omit<OutboxMessage, 'id'> {
  _id: string;
  claimedUntil?: number;
  /**
   * The same instant as `publishedAt`, stored as a BSON Date.
   *
   * Duplicated deliberately: MongoDB TTL indexes ONLY work on a Date field and silently
   * expire nothing when pointed at a number. The domain works in epoch milliseconds, so
   * rather than change that, the adapter writes both — the number for the domain, the
   * Date for the index. A TTL index on a numeric field is the kind of thing that looks
   * configured and does nothing until the collection is enormous.
   */
  publishedAtDate?: Date;
}

@Injectable()
export class MongoOutboxRepository implements OutboxRepository {
  constructor(private readonly mongo: MongoService) {}

  private get collection(): Collection<OutboxDocument> {
    return this.mongo.db.collection<OutboxDocument>(OUTBOX_COLLECTION);
  }

  /**
   * Atomically claim messages for publishing.
   *
   * `findOneAndUpdate` in a loop rather than `find` then `updateMany`: the read-then-write
   * version lets two relay instances read the same rows before either writes, so both
   * publish them. That is a duplicate for every message on every poll, not an occasional
   * one — it turns at-least-once into at-least-twice as a matter of routine.
   *
   * The claim carries an expiry rather than being permanent. A relay that dies mid-publish
   * would otherwise hold its rows forever and those notifications would never be sent.
   * After `CLAIM_TTL_MS` another relay picks them up — which is exactly the case that
   * makes duplicates possible, and therefore why consumers must be idempotent.
   */
  async claimUnpublished(limit: number, now: number): Promise<OutboxMessage[]> {
    const claimed: OutboxMessage[] = [];

    for (let i = 0; i < limit; i++) {
      const doc = await this.collection.findOneAndUpdate(
        {
          publishedAt: null,
          $or: [{ claimedUntil: { $exists: false } }, { claimedUntil: { $lt: now } }],
        },
        { $set: { claimedUntil: now + CLAIM_TTL_MS } },
        // Oldest first, so a burst does not starve the earliest messages.
        { sort: { createdAt: 1 }, returnDocument: 'after' },
      );

      if (!doc) break;
      claimed.push(toMessage(doc));
    }

    return claimed;
  }

  async markPublished(ids: readonly string[], now: number): Promise<void> {
    if (ids.length === 0) return;
    await this.collection.updateMany(
      { _id: { $in: [...ids] } },
      {
        $set: { publishedAt: now, publishedAtDate: new Date(now) },
        $unset: { claimedUntil: '' },
      },
    );
  }

  async recordFailure(id: string, now: number): Promise<void> {
    await this.collection.updateOne(
      { _id: id },
      // Release the claim immediately on failure so the next poll retries, and count the
      // attempt so a poison message can be identified rather than retried forever.
      { $inc: { attempts: 1 }, $set: { claimedUntil: now } },
    );
  }

  async findAll(): Promise<OutboxMessage[]> {
    const docs = await this.collection.find({}).sort({ createdAt: 1 }).toArray();
    return docs.map(toMessage);
  }
}

/**
 * Domain -> document. The `id` field must become `_id`.
 *
 * Missing this was a real bug: inserting the domain object directly left `id` as an
 * ordinary field and let MongoDB generate an ObjectId `_id`, so every message came back
 * with a different identity than it went in with — which silently breaks the jobId
 * deduplication, since the id the relay publishes is not the id that was written.
 */
export function toOutboxDocument(message: OutboxMessage): OutboxDocument {
  const { id, ...rest } = message;
  return { _id: id, ...rest };
}

function toMessage(doc: OutboxDocument): OutboxMessage {
  return {
    id: doc._id,
    type: doc.type,
    aggregateId: doc.aggregateId,
    payload: doc.payload,
    createdAt: doc.createdAt,
    publishedAt: doc.publishedAt,
    attempts: doc.attempts,
  };
}

/** In-memory twin, for unit tests. */
@Injectable()
export class InMemoryOutboxRepository implements OutboxRepository {
  private readonly store = new Map<string, OutboxMessage & { claimedUntil?: number }>();

  add(message: OutboxMessage): void {
    this.store.set(message.id, message);
  }

  claimUnpublished(limit: number, now: number): Promise<OutboxMessage[]> {
    const claimable = [...this.store.values()]
      .filter(
        (m) =>
          m.publishedAt === null &&
          (m.claimedUntil === undefined || m.claimedUntil < now),
      )
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);

    for (const message of claimable) {
      this.store.set(message.id, { ...message, claimedUntil: now + CLAIM_TTL_MS });
    }

    return Promise.resolve(claimable);
  }

  markPublished(ids: readonly string[], now: number): Promise<void> {
    for (const id of ids) {
      const existing = this.store.get(id);
      if (existing) {
        // Destructure the claim away rather than setting it to undefined —
        // exactOptionalPropertyTypes treats "absent" and "present but undefined" as
        // different, and the in-memory twin must mirror the Mongo adapter's `$unset`.
        const { claimedUntil: _claimed, ...rest } = existing;
        this.store.set(id, { ...rest, publishedAt: now });
      }
    }
    return Promise.resolve();
  }

  recordFailure(id: string, now: number): Promise<void> {
    const existing = this.store.get(id);
    if (existing) {
      this.store.set(id, {
        ...existing,
        attempts: existing.attempts + 1,
        claimedUntil: now,
      });
    }
    return Promise.resolve();
  }

  findAll(): Promise<OutboxMessage[]> {
    return Promise.resolve([...this.store.values()]);
  }
}

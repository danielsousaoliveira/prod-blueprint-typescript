import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  OUTBOX_REPOSITORY,
  type OutboxMessage,
  type OutboxRepository,
} from '../domain/outbox';

/**
 * The relay: moves committed outbox rows onto the queue.
 *
 * This is the second half of the transactional outbox. The first half (writing the row in
 * the same transaction as the appointment) guarantees the intent is never lost. This half
 * guarantees it is eventually acted on.
 *
 * ============================================================================
 * WHY THIS IS AT-LEAST-ONCE AND CANNOT BE EXACTLY-ONCE
 * ============================================================================
 *
 * The relay does three things: claim a row, publish it, mark it published. A crash
 * between step 2 and step 3 means the message was published but the row still says
 * unpublished, so the next poll publishes it again.
 *
 * That window cannot be closed. Marking published BEFORE publishing just swaps it for a
 * worse failure — a message marked sent that was never sent, which is silent data loss.
 * Making the publish and the mark atomic would require a distributed transaction across
 * MongoDB and Redis, which is precisely the thing the outbox pattern exists to avoid.
 *
 * So delivery is at-least-once by construction, and the system absorbs duplicates instead
 * of pretending they cannot happen:
 *   - the BullMQ `jobId` is the outbox row id, so the queue itself deduplicates;
 *   - the notification carries a `dedupeKey` the provider deduplicates on.
 *
 * "Exactly-once delivery" across a network boundary is not a thing you can buy. What you
 * can build is at-least-once delivery with idempotent effects, which is indistinguishable
 * from the outside.
 * ============================================================================
 */

export const OUTBOX_BATCH_SIZE = 50;

@Injectable()
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);

  constructor(
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    private readonly notificationQueue: Queue,
  ) {}

  /**
   * One poll cycle. Returns the number of messages successfully published.
   *
   * Deliberately a plain method rather than a `@Interval()`-decorated one: a scheduler
   * calls it in production, and tests call it directly. A method that schedules itself is
   * one you cannot invoke deterministically, which makes "does a rolled-back transaction
   * produce a notification?" impossible to test without sleeping.
   */
  async publishPending(now: number = Date.now()): Promise<number> {
    const messages = await this.outbox.claimUnpublished(OUTBOX_BATCH_SIZE, now);
    if (messages.length === 0) return 0;

    const published: string[] = [];

    for (const message of messages) {
      try {
        await this.enqueue(message);
        published.push(message.id);
      } catch (error) {
        // One bad message must not stop the batch — otherwise a single poison message
        // blocks every notification behind it.
        this.logger.warn(
          `Failed to publish outbox message ${message.id}: ${String(error)}`,
        );
        await this.outbox.recordFailure(message.id, now);
      }
    }

    await this.outbox.markPublished(published, now);
    return published.length;
  }

  private async enqueue(message: OutboxMessage): Promise<void> {
    await this.notificationQueue.add(
      message.type,
      { messageId: message.id, aggregateId: message.aggregateId, ...message.payload },
      {
        // The outbox row id IS the job id. BullMQ refuses to add a job whose id already
        // exists, so a re-published message after a crash is silently dropped by the
        // queue rather than processed twice. This is the first of the two deduplication
        // layers; the provider's dedupeKey is the second.
        jobId: message.id,
        attempts: 5,
        // Exponential backoff: a provider that is briefly down should not be hammered.
        // 1s, 2s, 4s, 8s, 16s.
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { count: 1000 },
        // Failed jobs are KEPT. They are the dead-letter queue — a failed job that is
        // removed is an incident with no evidence.
        removeOnFail: false,
      },
    );
  }
}

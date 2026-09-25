/**
 * The transactional outbox.
 *
 * ============================================================================
 * THE PROBLEM
 * ============================================================================
 *
 * Two things must happen when an appointment is booked: the row is written, and a
 * notification is sent. They live in different systems (MongoDB and a queue), so there is
 * no single atomic operation covering both. Every naive ordering has a failure window:
 *
 *   publish, then commit  -> the publish succeeds, the commit fails, and a patient is
 *                            notified about an appointment that does not exist.
 *   commit, then publish  -> the commit succeeds, the process dies before publishing, and
 *                            the notification is lost forever with no trace.
 *
 * The second is the common choice and it is usually described as "fine, it's a small
 * window". It is small, and it is silent: nothing records that the notification was owed.
 * At any real volume it happens, and it is unrecoverable because there is no evidence.
 *
 * ============================================================================
 * THE FIX
 * ============================================================================
 *
 * Write the intent to send as a ROW, in the SAME TRANSACTION as the appointment. Now
 * there is one atomic operation, and the two possible outcomes are both consistent:
 *
 *   - Transaction commits -> the appointment AND the outbox row exist. A separate relay
 *     picks the row up and publishes it. If the relay is slow the notification is late;
 *     if it crashes the row is still there and gets retried. Nothing is lost.
 *   - Transaction rolls back -> NEITHER exists. No appointment, no notification.
 *
 * The cost is a poller and the fact that delivery becomes at-least-once — the relay can
 * publish and then die before marking the row sent, so the message goes out twice. That
 * is why consumers must be idempotent. It is the right trade: a duplicate notification is
 * an annoyance, a missing one is a missed appointment.
 * ============================================================================
 */

export type OutboxMessageType =
  | 'appointment.requested'
  | 'appointment.confirmed'
  | 'appointment.declined'
  | 'appointment.cancelled'
  | 'appointment.counter_proposed'
  | 'appointment.completed';

export interface OutboxMessage {
  readonly id: string;
  readonly type: OutboxMessageType;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: number;
  /** Null until the relay has successfully published it. */
  readonly publishedAt: number | null;
  /** Incremented on each failed publish, for backoff and poison-message detection. */
  readonly attempts: number;
}

export interface OutboxRepository {
  /**
   * Claim up to `limit` unpublished messages for publishing.
   *
   * "Claim" rather than "read": several relay instances may run concurrently, and two
   * relays publishing the same row is a duplicate that idempotent consumers must then
   * absorb. Claiming atomically keeps duplicates rare rather than routine.
   */
  claimUnpublished(limit: number, now: number): Promise<OutboxMessage[]>;
  markPublished(ids: readonly string[], now: number): Promise<void>;
  recordFailure(id: string, now: number): Promise<void>;
  /** Test/inspection helper. */
  findAll(): Promise<OutboxMessage[]>;
}

export const OUTBOX_REPOSITORY = Symbol('OUTBOX_REPOSITORY');

export const OUTBOX_COLLECTION = 'outbox';

/**
 * Messages an appointment transition should emit.
 *
 * Derived from the resulting status rather than from the event, so the outbox describes
 * WHAT HAPPENED to the aggregate — a fact — rather than what was requested. Facts are
 * what downstream consumers can safely act on.
 */
export function outboxTypeForStatus(status: string): OutboxMessageType | null {
  switch (status) {
    case 'REQUESTED':
      return 'appointment.requested';
    case 'CONFIRMED':
      return 'appointment.confirmed';
    case 'DECLINED':
      return 'appointment.declined';
    case 'CANCELLED':
      return 'appointment.cancelled';
    case 'COUNTER_PROPOSED':
      return 'appointment.counter_proposed';
    case 'COMPLETED':
      return 'appointment.completed';
    default:
      return null;
  }
}

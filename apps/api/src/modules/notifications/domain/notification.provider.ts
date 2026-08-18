import { Injectable, Logger } from '@nestjs/common';

/**
 * The external notification provider, behind an interface.
 *
 * The real adapter is NEVER called in tests. That is the whole reason this port exists:
 * a test suite that hits a live email or SMS provider is slow, flaky, costs money, and
 * eventually sends real messages to real people from CI.
 *
 * Phase 8 mocks the HTTP adapter at the NETWORK boundary with MSW rather than swapping in
 * a fake class, because that exercises the real serialisation, headers and error handling
 * — a fake class proves only that the fake behaves as written.
 */

export interface Notification {
  readonly to: string;
  readonly channel: 'email' | 'sms';
  readonly template: string;
  readonly data: Record<string, unknown>;
  /**
   * Stable key identifying this exact notification.
   *
   * The provider is expected to deduplicate on it. Delivery is at-least-once, so the same
   * notification WILL occasionally be submitted twice, and "the patient got two identical
   * emails" is a real, visible bug even though no data is corrupted.
   */
  readonly dedupeKey: string;
}

export interface NotificationProvider {
  send(notification: Notification): Promise<void>;
}

export const NOTIFICATION_PROVIDER = Symbol('NOTIFICATION_PROVIDER');

/**
 * HTTP adapter for a third-party provider.
 *
 * Deliberately thin: build the request, send it, translate the failure. Anything it did
 * beyond that would be logic MSW could not observe at the network boundary.
 */
@Injectable()
export class HttpNotificationProvider implements NotificationProvider {
  private readonly logger = new Logger(HttpNotificationProvider.name);

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async send(notification: Notification): Promise<void> {
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
        // The provider deduplicates on this. Sending it is what makes at-least-once
        // delivery acceptable end to end rather than merely acceptable internally.
        'idempotency-key': notification.dedupeKey,
      },
      body: JSON.stringify({
        to: notification.to,
        channel: notification.channel,
        template: notification.template,
        data: notification.data,
      }),
    });

    if (!response.ok) {
      // Thrown so BullMQ retries. Distinguishing retryable (5xx, network) from permanent
      // (4xx) failures matters: retrying a malformed request forever just fills the
      // dead-letter queue more slowly.
      const retryable = response.status >= 500 || response.status === 429;
      const error = new Error(
        `Notification provider returned ${response.status} for ${notification.dedupeKey}`,
      );
      (error as Error & { retryable?: boolean }).retryable = retryable;
      throw error;
    }
  }
}

/** Recording fake, for unit tests that do not involve the network. */
@Injectable()
export class RecordingNotificationProvider implements NotificationProvider {
  readonly sent: Notification[] = [];
  private failNext = 0;

  failFor(count: number): void {
    this.failNext = count;
  }

  send(notification: Notification): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      return Promise.reject(new Error('simulated provider failure'));
    }
    this.sent.push(notification);
    return Promise.resolve();
  }

  /** Notifications actually delivered, deduplicated the way a real provider would. */
  get distinct(): Notification[] {
    const seen = new Map<string, Notification>();
    for (const notification of this.sent) {
      if (!seen.has(notification.dedupeKey))
        seen.set(notification.dedupeKey, notification);
    }
    return [...seen.values()];
  }

  reset(): void {
    this.sent.length = 0;
    this.failNext = 0;
  }
}

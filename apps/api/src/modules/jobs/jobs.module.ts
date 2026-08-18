import {
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { ENV, type Env } from '../../config/env';
import { AvailabilityModule } from '../availability/availability.module';
import {
  NOTIFICATION_PROVIDER,
  type NotificationProvider,
  HttpNotificationProvider,
} from '../notifications/domain/notification.provider';
import { ReminderScheduler } from '../notifications/application/reminder.scheduler';
import { OutboxRelay } from '../outbox/application/outbox-relay.service';
import { OUTBOX_REPOSITORY } from '../outbox/domain/outbox';
import { MongoOutboxRepository } from '../outbox/persistence/mongo-outbox.repository';

export const NOTIFICATION_QUEUE = Symbol('NOTIFICATION_QUEUE');
export const REMINDER_QUEUE = Symbol('REMINDER_QUEUE');

/**
 * Queues, workers and the relay poller.
 *
 * BullMQ connections are created SEPARATELY from the shared `RedisService` client.
 * Workers issue blocking commands (`BRPOPLPUSH`) that occupy a connection for their whole
 * duration, so sharing a client with ordinary request-path caching would stall every
 * cache read behind a blocked worker. BullMQ also requires `maxRetriesPerRequest: null`,
 * which is the wrong setting for a cache client — a cache read should fail fast, not
 * retry forever.
 */
/**
 * Owns the things with a lifecycle: the relay poller and the workers.
 *
 * Separated from the providers above so that shutdown is explicit. Without closing
 * workers on SIGTERM, a redeploy kills them mid-job — BullMQ eventually reclaims those as
 * stalled, but only after a delay, so every deploy silently delays a batch of
 * notifications.
 */
@Injectable()
class JobsRuntime implements OnApplicationShutdown {
  private readonly logger = new Logger(JobsRuntime.name);
  private readonly workers: Worker[] = [];
  private poller?: NodeJS.Timeout;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(NOTIFICATION_PROVIDER) private readonly provider: NotificationProvider,
    private readonly relay: OutboxRelay,
  ) {
    this.startRelayPoller();
    this.startNotificationWorker();
  }

  /**
   * Polls the outbox on an interval.
   *
   * A poller rather than a change stream: change streams are more responsive but add a
   * persistent connection per instance and a resume-token to manage. A 1-second poll is
   * well within tolerance for a notification, and it degrades gracefully — a missed tick
   * simply picks up more rows on the next one.
   */
  private startRelayPoller(): void {
    this.poller = setInterval(() => {
      void this.relay.publishPending().catch((error: unknown) => {
        this.logger.error(`Outbox relay poll failed: ${String(error)}`);
      });
    }, 1000);

    // Do not hold the process open purely for the poller.
    this.poller.unref();
  }

  private startNotificationWorker(): void {
    const worker = new Worker(
      'notifications',
      async (job) => {
        const data = job.data as { messageId: string; patientId?: string };
        await this.provider.send({
          to: `${data.patientId ?? 'unknown'}@example.test`,
          channel: 'email',
          template: job.name,
          data: job.data as Record<string, unknown>,
          // The outbox message id: stable across redeliveries, which is what makes
          // at-least-once delivery produce exactly one visible notification.
          dedupeKey: data.messageId,
        });
      },
      { connection: { url: this.env.REDIS_URL, maxRetriesPerRequest: null } },
    );

    worker.on('failed', (job, error) => {
      this.logger.warn(
        `Notification job ${job?.id ?? 'unknown'} failed: ${error.message}`,
      );
    });

    this.workers.push(worker);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.poller) clearInterval(this.poller);
    this.logger.log('Closing job workers');
    // `close()` waits for in-flight jobs to finish rather than killing them, which is the
    // difference between a clean redeploy and a batch of half-processed notifications.
    await Promise.all(this.workers.map((worker) => worker.close()));
  }
}

@Module({
  imports: [AvailabilityModule],
  providers: [
    { provide: OUTBOX_REPOSITORY, useClass: MongoOutboxRepository },

    {
      provide: NOTIFICATION_QUEUE,
      inject: [ENV],
      useFactory: (env: Env) =>
        new Queue('notifications', {
          connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
        }),
    },
    {
      provide: REMINDER_QUEUE,
      inject: [ENV],
      useFactory: (env: Env) =>
        new Queue('reminders', {
          connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
        }),
    },

    {
      provide: NOTIFICATION_PROVIDER,
      inject: [ENV],
      useFactory: (env: Env): NotificationProvider =>
        new HttpNotificationProvider(
          env.NOTIFICATION_PROVIDER_URL,
          env.NOTIFICATION_API_KEY,
        ),
    },

    {
      provide: ReminderScheduler,
      inject: [REMINDER_QUEUE],
      useFactory: (queue: Queue) => new ReminderScheduler(queue),
    },
    {
      provide: OutboxRelay,
      inject: [OUTBOX_REPOSITORY, NOTIFICATION_QUEUE],
      useFactory: (repo: MongoOutboxRepository, queue: Queue) =>
        new OutboxRelay(repo, queue),
    },

    JobsRuntime,
  ],
  exports: [ReminderScheduler, OutboxRelay, NOTIFICATION_QUEUE, REMINDER_QUEUE],
})
export class JobsModule {}

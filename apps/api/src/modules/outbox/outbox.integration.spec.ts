import { Queue, Worker } from 'bullmq';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { OUTBOX_COLLECTION, type OutboxMessage } from './domain/outbox';
import { MongoOutboxRepository } from './persistence/mongo-outbox.repository';
import { OutboxRelay } from './application/outbox-relay.service';
import { type MongoHarness, startMongoHarness } from '../../../test/mongo-harness';
import { APPOINTMENTS_COLLECTION } from '../../persistence/migrations';
import { MongoAppointmentRepository } from '../appointments/persistence/mongo-appointment.repository';
import { SlotTakenError } from '../appointments/domain/appointment.repository';
import type { Appointment } from '../appointments/domain/appointment';
import { RecordingNotificationProvider } from '../notifications/domain/notification.provider';

jest.setTimeout(180_000);

let harness: MongoHarness;
let redisContainer: StartedRedisContainer;
let redisUrl: string;
let queue: Queue;
let repo: MongoOutboxRepository;
let relay: OutboxRelay;

const T0 = Date.UTC(2027, 5, 1, 9, 0);

const message = (id: string, overrides: Partial<OutboxMessage> = {}): OutboxMessage => ({
  id,
  type: 'appointment.requested',
  aggregateId: 'appt-1',
  payload: { doctorId: 'doctor-1', patientId: 'patient-1' },
  createdAt: T0,
  publishedAt: null,
  attempts: 0,
  ...overrides,
});

const appointment = (id: string, startsAt = T0): Appointment => ({
  id,
  doctorId: 'doctor-1',
  patientId: 'patient-1',
  slot: { start: startsAt, end: startsAt + 1_800_000 },
  createdAt: T0,
  status: 'REQUESTED',
});

beforeAll(async () => {
  harness = await startMongoHarness();
  redisContainer = await new RedisContainer('redis:7-alpine').start();
  redisUrl = redisContainer.getConnectionUrl();
});

afterAll(async () => {
  await queue?.close();
  await harness?.stop();
  await redisContainer?.stop();
});

beforeEach(async () => {
  await harness.reset();
  await queue?.close();

  queue = new Queue('notifications', {
    connection: { url: redisUrl },
    // BullMQ requires this for blocking commands; without it the client retries
    // indefinitely and workers hang rather than failing visibly.
    prefix: `test-${Date.now()}`,
  });
  await queue.obliterate({ force: true }).catch(() => undefined);

  repo = new MongoOutboxRepository(harness.mongoService);
  relay = new OutboxRelay(repo, queue);
});

// ---------------------------------------------------------------------------
// THE HEADLINE PROPERTY
// ---------------------------------------------------------------------------
describe('the transactional outbox', () => {
  it('writes the appointment and its message ATOMICALLY', async () => {
    const appointments = new MongoAppointmentRepository(harness.mongoService);
    await appointments.create(appointment('a1'), [message('m1')]);

    expect(await harness.db.collection(APPOINTMENTS_COLLECTION).countDocuments()).toBe(1);
    expect(await harness.db.collection(OUTBOX_COLLECTION).countDocuments()).toBe(1);
  });

  it('produces NO message when the transaction rolls back', async () => {
    // The property the whole pattern exists for. The second booking violates the unique
    // index, so the transaction aborts — and the outbox row must abort with it. If it
    // survived, a patient would be notified about an appointment that does not exist.
    const appointments = new MongoAppointmentRepository(harness.mongoService);
    await appointments.create(appointment('a1'), [message('m1')]);

    await expect(
      appointments.create(appointment('a2'), [message('m2')]),
    ).rejects.toBeInstanceOf(SlotTakenError);

    // One appointment, and exactly one message — not two.
    expect(await harness.db.collection(APPOINTMENTS_COLLECTION).countDocuments()).toBe(1);
    const messages = await repo.findAll();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe('m1');
  });

  it('does not emit a message when a compare-and-set loses its race', async () => {
    // A transition that loses the CAS never happened, so it must not announce itself.
    const appointments = new MongoAppointmentRepository(harness.mongoService);
    const created = await appointments.create(appointment('a1'));

    await appointments.update(
      {
        ...created,
        status: 'CONFIRMED',
        confirmedSlot: created.slot,
        confirmedAt: T0,
      },
      'REQUESTED',
      [message('m-confirmed')],
    );

    // Second transition from the same stale status — loses.
    await expect(
      appointments.update(
        {
          ...created,
          status: 'DECLINED',
          declinedBy: 'doctor',
          declinedAt: T0,
        },
        'REQUESTED',
        [message('m-declined')],
      ),
    ).rejects.toThrow();

    const ids = (await repo.findAll()).map((m) => m.id);
    expect(ids).toEqual(['m-confirmed']);
  });
});

describe('the relay', () => {
  it('publishes pending messages and marks them published', async () => {
    await harness.db
      .collection(OUTBOX_COLLECTION)
      .insertMany([
        { ...message('m1'), _id: 'm1' } as never,
        { ...message('m2'), _id: 'm2' } as never,
      ]);

    const published = await relay.publishPending(T0);

    expect(published).toBe(2);
    expect(await queue.getWaitingCount()).toBe(2);
    expect((await repo.findAll()).every((m) => m.publishedAt !== null)).toBe(true);
  });

  it('is idempotent — a second run publishes nothing', async () => {
    await harness.db
      .collection(OUTBOX_COLLECTION)
      .insertOne({ ...message('m1'), _id: 'm1' } as never);

    await relay.publishPending(T0);
    const second = await relay.publishPending(T0 + 1000);

    expect(second).toBe(0);
    expect(await queue.getWaitingCount()).toBe(1);
  });

  it('deduplicates via jobId when the SAME message is published twice', async () => {
    // Simulates the unavoidable at-least-once window: the relay published, then crashed
    // before marking the row, so the next poll publishes it again. BullMQ refuses the
    // duplicate jobId, so the queue holds one job rather than two.
    await harness.db
      .collection(OUTBOX_COLLECTION)
      .insertOne({ ...message('m1'), _id: 'm1' } as never);

    await relay.publishPending(T0);

    // Reset the row to unpublished, exactly as a crash would leave it.
    await harness.db
      .collection(OUTBOX_COLLECTION)
      .updateOne({ _id: 'm1' as never }, { $set: { publishedAt: null } });

    await relay.publishPending(T0 + 60_000);

    // Published twice, enqueued once.
    expect(await queue.getWaitingCount()).toBe(1);
  });

  it('does not let one bad message block the rest of the batch', async () => {
    // A poison message must not stop everything behind it. The relay records the failure
    // and carries on.
    await harness.db
      .collection(OUTBOX_COLLECTION)
      .insertMany([
        { ...message('m-good-1'), _id: 'm-good-1' } as never,
        { ...message('m-good-2'), _id: 'm-good-2', createdAt: T0 + 2 } as never,
      ]);

    const failingQueue = {
      add: jest
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue(undefined),
    } as unknown as Queue;

    const published = await new OutboxRelay(repo, failingQueue).publishPending(T0);

    expect(published).toBe(1);
    const all = await repo.findAll();
    expect(all.find((m) => m.attempts === 1)).toBeDefined();
    // The failed one is still pending, so it will be retried.
    expect(all.filter((m) => m.publishedAt === null)).toHaveLength(1);
  });

  it('does not re-claim a message another relay is holding', async () => {
    await harness.db
      .collection(OUTBOX_COLLECTION)
      .insertOne({ ...message('m1'), _id: 'm1' } as never);

    // First relay claims it...
    const claimed = await repo.claimUnpublished(10, T0);
    expect(claimed).toHaveLength(1);

    // ...a second relay polling immediately sees nothing.
    expect(await repo.claimUnpublished(10, T0 + 1000)).toHaveLength(0);
  });

  it('RE-claims a message whose holder died, after the claim expires', async () => {
    // Without claim expiry, a relay that crashes mid-publish holds its rows forever and
    // those notifications are never sent. This is also the case that makes duplicates
    // possible — which is why consumers must be idempotent.
    await harness.db
      .collection(OUTBOX_COLLECTION)
      .insertOne({ ...message('m1'), _id: 'm1' } as never);

    await repo.claimUnpublished(10, T0);
    const afterExpiry = await repo.claimUnpublished(10, T0 + 60_000);

    expect(afterExpiry).toHaveLength(1);
  });
});

describe('the notification consumer', () => {
  it('sends exactly one notification even if the job runs twice', async () => {
    // At-least-once delivery, absorbed by an idempotent consumer. The provider
    // deduplicates on dedupeKey, so a redelivered job produces no second email.
    const provider = new RecordingNotificationProvider();

    const worker = new Worker(
      queue.name,
      async (job) => {
        await provider.send({
          to: 'patient@example.test',
          channel: 'email',
          template: String(job.name),
          data: job.data as Record<string, unknown>,
          // The outbox message id — stable across redeliveries of the same message.
          dedupeKey: (job.data as { messageId: string }).messageId,
        });
      },
      { connection: { url: redisUrl }, prefix: queue.opts.prefix ?? 'bull' },
    );

    try {
      // Same message delivered twice.
      await queue.add('appointment.requested', { messageId: 'm1' }, { jobId: 'j1' });
      await queue.add('appointment.requested', { messageId: 'm1' }, { jobId: 'j2' });

      await new Promise<void>((resolve) => {
        let done = 0;
        worker.on('completed', () => {
          done += 1;
          if (done === 2) resolve();
        });
      });

      // The worker ran twice...
      expect(provider.sent).toHaveLength(2);
      // ...but only one distinct notification was actually owed.
      expect(provider.distinct).toHaveLength(1);
    } finally {
      await worker.close();
    }
  });

  it('retries with backoff and keeps a permanently failing job for inspection', async () => {
    const provider = new RecordingNotificationProvider();
    provider.failFor(99);

    const worker = new Worker(
      queue.name,
      async (job) => {
        await provider.send({
          to: 'patient@example.test',
          channel: 'email',
          template: String(job.name),
          data: {},
          dedupeKey: 'always-fails',
        });
      },
      { connection: { url: redisUrl }, prefix: queue.opts.prefix ?? 'bull' },
    );

    try {
      await queue.add(
        'appointment.requested',
        { messageId: 'poison' },
        {
          jobId: 'poison',
          attempts: 2,
          backoff: { type: 'fixed', delay: 10 },
          // Kept, not removed — a failed job that vanishes is an incident with no
          // evidence. This IS the dead-letter queue.
          removeOnFail: false,
        },
      );

      await new Promise<void>((resolve) => {
        worker.on('failed', (job) => {
          if (job && job.attemptsMade >= 2) resolve();
        });
      });

      const failed = await queue.getFailed();
      expect(failed).toHaveLength(1);
      expect(failed[0]?.failedReason).toContain('simulated provider failure');
    } finally {
      await worker.close();
    }
  });
});

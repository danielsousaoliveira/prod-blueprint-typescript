import type { Queue } from 'bullmq';
import { REMINDER_LEAD_MS, ReminderScheduler } from './reminder.scheduler';

/**
 * Reminder scheduling, tested with FAKE TIMERS and an injected `now`.
 *
 * Nothing here waits on a real clock. A test that genuinely slept until a reminder fired
 * would take 24 hours; one that slept a "short" interval would be slow AND flaky, because
 * it would pass or fail depending on CI load. Time is an input, so it is passed in.
 *
 * `Date.now()` is never called inside the scheduler for the same reason — a function that
 * reads the clock internally cannot be tested deterministically without patching globals.
 */

const HOUR = 3_600_000;
const NOW = Date.UTC(2027, 5, 1, 9, 0);

function makeQueue() {
  const jobs = new Map<
    string,
    { name: string; data: unknown; opts: { delay?: number } }
  >();

  const queue = {
    add: jest.fn(
      (name: string, data: unknown, opts: { jobId: string; delay?: number }) => {
        // Mirrors BullMQ: adding a job whose id already exists is a no-op.
        if (jobs.has(opts.jobId)) return Promise.resolve(undefined);
        jobs.set(opts.jobId, { name, data, opts });
        return Promise.resolve(undefined);
      },
    ),
    getJob: jest.fn((jobId: string) => {
      const job = jobs.get(jobId);
      return Promise.resolve(
        job
          ? {
              remove: () => {
                jobs.delete(jobId);
                return Promise.resolve();
              },
            }
          : undefined,
      );
    }),
  } as unknown as Queue;

  return { queue, jobs };
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('ReminderScheduler', () => {
  it('schedules a reminder 24 hours before the appointment', async () => {
    const { queue, jobs } = makeQueue();
    const scheduler = new ReminderScheduler(queue);

    const startsAt = NOW + 72 * HOUR;
    await scheduler.schedule('appt-1', startsAt, NOW);

    const job = jobs.get('reminder:appt-1');
    expect(job).toBeDefined();
    // 72 hours away, remind 24 hours before -> fire in 48 hours.
    expect(job?.opts.delay).toBe(48 * HOUR);
  });

  it('does NOT schedule when the appointment is already inside the reminder window', async () => {
    // Booking for tomorrow morning means "your appointment is in 24 hours" is already
    // false. A negative delay would fire immediately and send something untrue.
    const { queue, jobs } = makeQueue();
    const scheduler = new ReminderScheduler(queue);

    await scheduler.schedule('appt-1', NOW + 2 * HOUR, NOW);

    expect(jobs.size).toBe(0);
  });

  it('does not schedule for an appointment exactly at the boundary', async () => {
    const { queue, jobs } = makeQueue();
    const scheduler = new ReminderScheduler(queue);

    await scheduler.schedule('appt-1', NOW + REMINDER_LEAD_MS, NOW);

    expect(jobs.size).toBe(0);
  });

  it('cancels a pending reminder', async () => {
    // A cancelled appointment that still reminds the patient to attend is the kind of bug
    // that produces support calls rather than errors.
    const { queue, jobs } = makeQueue();
    const scheduler = new ReminderScheduler(queue);

    await scheduler.schedule('appt-1', NOW + 72 * HOUR, NOW);
    expect(jobs.size).toBe(1);

    await scheduler.cancel('appt-1');
    expect(jobs.size).toBe(0);
  });

  it('cancelling a non-existent reminder is a no-op, not an error', async () => {
    const { queue } = makeQueue();
    const scheduler = new ReminderScheduler(queue);
    await expect(scheduler.cancel('never-scheduled')).resolves.toBeUndefined();
  });

  it('RESCHEDULES to the new time rather than keeping the old delay', async () => {
    // The bug this guards against: BullMQ treats `add` with an existing jobId as a no-op,
    // so rescheduling without removing first silently keeps the ORIGINAL delay. The
    // patient would then be reminded relative to a time that no longer applies — which
    // is exactly what happens after a counter-proposal moves an appointment.
    const { queue, jobs } = makeQueue();
    const scheduler = new ReminderScheduler(queue);

    await scheduler.schedule('appt-1', NOW + 72 * HOUR, NOW);
    expect(jobs.get('reminder:appt-1')?.opts.delay).toBe(48 * HOUR);

    // Counter-proposal moves it a week out.
    await scheduler.schedule('appt-1', NOW + 168 * HOUR, NOW);

    expect(jobs.size).toBe(1);
    expect(jobs.get('reminder:appt-1')?.opts.delay).toBe(144 * HOUR);
  });

  it('never creates two reminders for one appointment', async () => {
    const { queue, jobs } = makeQueue();
    const scheduler = new ReminderScheduler(queue);

    await scheduler.schedule('appt-1', NOW + 72 * HOUR, NOW);
    await scheduler.schedule('appt-1', NOW + 72 * HOUR, NOW);
    await scheduler.schedule('appt-1', NOW + 72 * HOUR, NOW);

    expect(jobs.size).toBe(1);
  });

  it('uses the injected `now` rather than reading the clock', async () => {
    // Proves the scheduler is a pure function of its inputs. Advancing fake time between
    // calls must not change the result, because the scheduler never asks what time it is.
    const { queue, jobs } = makeQueue();
    const scheduler = new ReminderScheduler(queue);

    jest.advanceTimersByTime(10 * HOUR);
    await scheduler.schedule('appt-1', NOW + 72 * HOUR, NOW);

    // Still computed from the passed-in NOW, not from the advanced clock.
    expect(jobs.get('reminder:appt-1')?.opts.delay).toBe(48 * HOUR);
  });
});

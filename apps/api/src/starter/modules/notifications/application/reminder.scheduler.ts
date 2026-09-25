import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';

/**
 * Appointment reminders, as BullMQ delayed jobs.
 *
 * A delayed job rather than a cron that scans for upcoming appointments. The cron version
 * is the reflexive design and it is worse in two specific ways: it re-reads the whole
 * upcoming window every tick regardless of whether anything changed, and its granularity
 * is the tick interval, so a "24 hours before" reminder is really "within 5 minutes of 24
 * hours before". A delayed job is scheduled once, fires at the right instant, and costs
 * nothing while waiting.
 *
 * The trade is that the schedule now lives in Redis rather than being derived from the
 * database on every tick. If Redis loses its data, pending reminders are gone — the
 * appointments are safe, but the reminders need rebuilding. At scale that is worth a
 * reconciliation job; here it is worth knowing about.
 */

export const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class ReminderScheduler {
  private readonly logger = new Logger(ReminderScheduler.name);

  constructor(private readonly reminderQueue: Queue) {}

  /**
   * Deterministic job id per appointment.
   *
   * This is what makes scheduling idempotent AND cancellation possible. Rescheduling
   * after a counter-proposal removes the old job and adds a new one under the same id, so
   * an appointment can never accumulate two reminders.
   */
  private static jobId(appointmentId: string): string {
    return `reminder:${appointmentId}`;
  }

  async schedule(appointmentId: string, startsAt: number, now: number): Promise<void> {
    const delay = startsAt - REMINDER_LEAD_MS - now;

    // An appointment booked for tomorrow morning is already inside the reminder window.
    // Sending an immediate "your appointment is in 24 hours" would be wrong, and a
    // negative delay would fire instantly — so skip it rather than send something false.
    if (delay <= 0) {
      this.logger.debug(
        `Appointment ${appointmentId} starts within the reminder window; no reminder scheduled`,
      );
      return;
    }

    // Remove first: `add` with an existing jobId is a no-op in BullMQ, so a reschedule
    // would silently keep the OLD delay and remind at the wrong time.
    await this.cancel(appointmentId);

    await this.reminderQueue.add(
      'appointment.reminder',
      { appointmentId, startsAt },
      {
        jobId: ReminderScheduler.jobId(appointmentId),
        delay,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }

  /**
   * Cancel a pending reminder.
   *
   * Called on cancellation, decline, and before any reschedule. Without it, a cancelled
   * appointment still reminds the patient to attend — which is the kind of bug that
   * generates support calls rather than errors.
   */
  async cancel(appointmentId: string): Promise<void> {
    const job = await this.reminderQueue.getJob(ReminderScheduler.jobId(appointmentId));
    // A job that has already run cannot be removed, and does not need to be.
    if (job) await job.remove().catch(() => undefined);
  }
}

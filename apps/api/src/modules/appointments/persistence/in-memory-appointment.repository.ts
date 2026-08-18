import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import type { Interval } from '../../../shared/intervals/interval';
import { overlaps } from '../../../shared/intervals/interval';
import { ACTIVE_STATUSES, type Appointment } from '../domain/appointment';
import {
  AppointmentNotFoundError,
  type AppointmentRepository,
  type AppointmentStatsRow,
  type FindAppointmentsQuery,
  SlotTakenError,
} from '../domain/appointment.repository';
import type { OutboxMessage } from '../../outbox/domain/outbox';
import { toDocument } from './appointment.document';

/**
 * In-memory adapter, for unit tests that need a repository but not a database.
 *
 * The value of this is speed and isolation — a service test runs in microseconds with no
 * container. The DANGER is that a hand-written fake drifts into being a more forgiving
 * version of reality: it forgets the unique constraint, or resolves a race the real
 * database would reject, and then a suite of green unit tests says nothing about
 * production.
 *
 * The defence is that both adapters are verified against the SAME contract test suite
 * (`appointment-repository.contract.ts`). Anything the fake gets wrong shows up as a
 * contract failure, not as a surprise in staging. Behaviour that genuinely cannot be
 * reproduced in memory — real concurrency, index selection — is tested only against
 * MongoDB and marked as such.
 */
@Injectable()
export class InMemoryAppointmentRepository implements AppointmentRepository {
  private readonly store = new Map<string, Appointment>();

  /**
   * Outbox messages written alongside appointments.
   *
   * The fake has no transactions, so it models the guarantee structurally instead: the
   * messages are only recorded on a path that has already succeeded. A rejected write
   * returns before reaching this, so it can no more produce an orphaned message than the
   * real transaction can.
   */
  readonly outbox: OutboxMessage[] = [];

  /**
   * Mirror of the partial unique index: `doctorId|startsAt` for ACTIVE appointments only.
   *
   * Kept as an explicit index rather than scanning the store on every write, so that the
   * fake enforces the constraint the same way the database does — including the part
   * people get wrong, that terminal appointments release their slot.
   */
  private readonly activeSlots = new Map<string, string>();

  private static slotKey(doctorId: string, startsAt: number): string {
    return `${doctorId}|${startsAt}`;
  }

  private static isActive(appointment: Appointment): boolean {
    return (ACTIVE_STATUSES as readonly string[]).includes(appointment.status);
  }

  /** The slot the document would index — mirrors `toDocument`, via the same mapper. */
  private static heldStart(appointment: Appointment): number {
    return toDocument(appointment).startsAt.getTime();
  }

  create(
    appointment: Appointment,
    outbox: readonly OutboxMessage[] = [],
  ): Promise<Appointment> {
    const startsAt = InMemoryAppointmentRepository.heldStart(appointment);
    const key = InMemoryAppointmentRepository.slotKey(appointment.doctorId, startsAt);

    if (
      InMemoryAppointmentRepository.isActive(appointment) &&
      this.activeSlots.has(key)
    ) {
      return Promise.reject(new SlotTakenError(appointment.doctorId, startsAt));
    }

    this.store.set(appointment.id, appointment);
    if (InMemoryAppointmentRepository.isActive(appointment)) {
      this.activeSlots.set(key, appointment.id);
    }
    // Only after the write has definitely succeeded.
    this.outbox.push(...outbox);
    return Promise.resolve(appointment);
  }

  update(
    appointment: Appointment,
    expectedStatus: Appointment['status'],
    outbox: readonly OutboxMessage[] = [],
  ): Promise<Appointment> {
    const existing = this.store.get(appointment.id);
    if (!existing) {
      return Promise.reject(new AppointmentNotFoundError(appointment.id));
    }

    // Compare-and-set, matching the Mongo adapter's filter on `{ _id, status }`.
    const startsAt = InMemoryAppointmentRepository.heldStart(appointment);
    if (existing.status !== expectedStatus) {
      return Promise.reject(new SlotTakenError(appointment.doctorId, startsAt));
    }

    const newKey = InMemoryAppointmentRepository.slotKey(appointment.doctorId, startsAt);
    const oldKey = InMemoryAppointmentRepository.slotKey(
      existing.doctorId,
      InMemoryAppointmentRepository.heldStart(existing),
    );

    // The counter-proposal case: the held slot MOVES, and the new one may be taken by a
    // different appointment. Checking `!== appointment.id` matters — an appointment must
    // not collide with its own existing reservation.
    const occupant = this.activeSlots.get(newKey);
    if (
      InMemoryAppointmentRepository.isActive(appointment) &&
      occupant !== undefined &&
      occupant !== appointment.id
    ) {
      return Promise.reject(new SlotTakenError(appointment.doctorId, startsAt));
    }

    this.activeSlots.delete(oldKey);
    if (InMemoryAppointmentRepository.isActive(appointment)) {
      this.activeSlots.set(newKey, appointment.id);
    }
    this.store.set(appointment.id, appointment);
    this.outbox.push(...outbox);

    return Promise.resolve(appointment);
  }

  findById(id: string): Promise<Appointment | null> {
    return Promise.resolve(this.store.get(id) ?? null);
  }

  find(query: FindAppointmentsQuery): Promise<Appointment[]> {
    const results = [...this.store.values()]
      .filter((appointment) => {
        if (query.doctorId !== undefined && appointment.doctorId !== query.doctorId) {
          return false;
        }
        if (query.patientId !== undefined && appointment.patientId !== query.patientId) {
          return false;
        }
        if (
          query.statuses !== undefined &&
          !query.statuses.includes(appointment.status)
        ) {
          return false;
        }
        if (query.within !== undefined) {
          const doc = toDocument(appointment);
          const held: Interval = {
            start: doc.startsAt.getTime(),
            end: doc.endsAt.getTime(),
          };
          // Reuses the domain predicate rather than reimplementing it, so the fake and
          // the real query cannot disagree about what "overlaps" means.
          if (!overlaps(held, query.within)) return false;
        }
        return true;
      })
      .sort(
        (a, b) =>
          InMemoryAppointmentRepository.heldStart(a) -
          InMemoryAppointmentRepository.heldStart(b),
      );

    return Promise.resolve(results);
  }

  statsByStatusPerWeek(range: Interval): Promise<AppointmentStatsRow[]> {
    const buckets = new Map<string, AppointmentStatsRow>();

    for (const appointment of this.store.values()) {
      const startsAt = InMemoryAppointmentRepository.heldStart(appointment);
      if (startsAt < range.start || startsAt >= range.end) continue;

      // Luxon's `startOf('week')` is ISO week (Monday), matching `$dateTrunc` with
      // `startOfWeek: 'monday'` in the aggregation.
      const weekStart = DateTime.fromMillis(startsAt, { zone: 'utc' })
        .startOf('week')
        .toMillis();

      const key = `${appointment.doctorId}|${weekStart}|${appointment.status}`;
      const existing = buckets.get(key);

      buckets.set(
        key,
        existing
          ? { ...existing, count: existing.count + 1 }
          : {
              doctorId: appointment.doctorId,
              weekStart,
              status: appointment.status,
              count: 1,
            },
      );
    }

    const rows = [...buckets.values()].sort(
      (a, b) =>
        a.doctorId.localeCompare(b.doctorId) ||
        a.weekStart - b.weekStart ||
        a.status.localeCompare(b.status),
    );

    return Promise.resolve(rows);
  }

  /** Test helper — not part of the port. */
  clear(): void {
    this.store.clear();
    this.activeSlots.clear();
    this.outbox.length = 0;
  }
}

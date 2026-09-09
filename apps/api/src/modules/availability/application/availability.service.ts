import { Inject, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { type Interval, interval } from '../../../shared/intervals/interval';
import {
  APPOINTMENT_REPOSITORY,
  type AppointmentRepository,
} from '../../appointments/domain/appointment.repository';
import { ACTIVE_STATUSES } from '../../appointments/domain/appointment';
import { computeAvailability } from '../domain/availability.engine';
import { AvailabilityCache } from './availability.cache';
import {
  AVAILABILITY_REPOSITORY,
  type AvailabilityRepository,
} from '../domain/availability.repository';

export interface AvailableSlot {
  readonly startsAt: number;
  readonly endsAt: number;
}

export interface DoctorAvailability {
  readonly doctorId: string;
  /** The clinic's IANA zone, returned so clients can label times without guessing. */
  readonly timezone: string;
  readonly slots: readonly AvailableSlot[];
}

@Injectable()
export class AvailabilityService {
  constructor(
    @Inject(AVAILABILITY_REPOSITORY)
    private readonly schedules: AvailabilityRepository,
    @Inject(APPOINTMENT_REPOSITORY)
    private readonly appointments: AppointmentRepository,
    private readonly cache: AvailabilityCache,
  ) {}

  /**
   * Compute bookable slots for one doctor over a window.
   *
   * Note what is fetched: only appointments in ACTIVE statuses. Terminal ones do not hold
   * time, so pulling them would mean transferring rows the engine immediately discards —
   * and, worse, invites a bug where a cancelled appointment blocks its old slot.
   * Filtering in the query rather than in memory also lets the index do the work.
   */
  async forDoctor(doctorId: string, range: Interval): Promise<DoctorAvailability | null> {
    // Cache the COMPUTED RESULT of a pure function. That is a much smaller commitment
    // than materialising slots as a second representation of the data (documented design choice) —
    // if the cache is wrong or unhelpful, deleting it costs nothing and correctness is
    // unaffected, because deriving remains the source of truth.
    const cached = await this.cache.get(doctorId, range.start, range.end);
    if (cached) return cached;

    const schedule = await this.schedules.findSchedule(doctorId);
    if (!schedule) return null;

    const appointments = await this.appointments.find({
      doctorId,
      within: range,
      statuses: [...ACTIVE_STATUSES],
    });

    const slots = computeAvailability({
      doctorId,
      rules: schedule.rules,
      exceptions: schedule.exceptions,
      appointments,
      range,
      slotDurationMinutes: schedule.slotDurationMinutes,
    });

    const result: DoctorAvailability = {
      doctorId,
      timezone: schedule.timezone,
      slots: slots.map((slot) => ({ startsAt: slot.start, endsAt: slot.end })),
    };

    await this.cache.set(doctorId, range.start, range.end, result);
    return result;
  }

  /**
   * Drop everything cached for this doctor.
   *
   * Called from every write path that can change availability. Missing one is the classic
   * cache bug — which is why the entries also carry a TTL, bounding how long a missed
   * invalidation stays visible.
   */
  invalidate(doctorId: string): Promise<void> {
    return this.cache.invalidate(doctorId);
  }

  /**
   * Is this exact slot currently bookable?
   *
   * Used as a pre-check so an obviously-invalid booking (outside working hours, off the
   * slot grid) fails with a clear 422 instead of a confusing 409 from the unique index.
   *
   * It is emphatically NOT the double-booking guarantee: between this check and the
   * insert, another request can take the slot. That window cannot be closed in
   * application code, which is exactly why the guarantee lives in the index.
   *
   * ---
   * SUBTLE, AND IT WAS A REAL BUG: the availability range must be the containing CLINIC
   * DAY, never the requested slot itself.
   *
   * `expandRule` clips occurrences to the requested range, and `chopIntoSlots` aligns the
   * grid to the start of each free region. So passing the slot as its own range clipped
   * the working block to exactly that slot and then aligned the grid to it — meaning any
   * arbitrary time inside working hours validated itself as a legitimate slot, and 08:15
   * was "bookable" on a 30-minute grid starting at 09:00.
   *
   * Computing over the whole clinic day means the grid is anchored to the rule's real
   * start, which is the only anchor that makes "on the grid" meaningful.
   * ---
   */
  async isBookable(doctorId: string, slot: Interval): Promise<boolean> {
    const schedule = await this.schedules.findSchedule(doctorId);
    if (!schedule) return false;

    // The day boundary is taken in the CLINIC's zone, not UTC — for a clinic far enough
    // east or west those are different days, and the wrong one would miss the rule.
    const dayStart = DateTime.fromMillis(slot.start, {
      zone: schedule.timezone,
    }).startOf('day');
    const range = interval(dayStart.toMillis(), dayStart.plus({ days: 1 }).toMillis());

    const availability = await this.forDoctor(doctorId, range);
    if (!availability) return false;

    return availability.slots.some(
      (candidate) => candidate.startsAt === slot.start && candidate.endsAt === slot.end,
    );
  }
}

import type { RecurringAvailabilityRule } from '../../../shared/time/clinic-time';
import type { AvailabilityException } from './availability.engine';

/**
 * Persistence port for a doctor's schedule.
 *
 * Split from `AppointmentRepository` rather than merged into one "everything" repository:
 * these are different aggregates with different lifecycles. A doctor's schedule changes
 * rarely and is read constantly; appointments are the opposite. Keeping them separate is
 * what will let Phase 6 cache one aggressively without reasoning about the other.
 */
export interface DoctorSchedule {
  readonly doctorId: string;
  /** Embedded on the doctor document — bounded, always read together. DECISIONS §11. */
  readonly rules: readonly RecurringAvailabilityRule[];
  /** Referenced in a separate collection — unbounded growth. DECISIONS §11. */
  readonly exceptions: readonly AvailabilityException[];
  /** IANA identifier for the clinic. Never an offset. */
  readonly timezone: string;
  readonly slotDurationMinutes: number;
}

export interface AvailabilityRepository {
  findSchedule(doctorId: string): Promise<DoctorSchedule | null>;
  /** Batch form — exists so the multi-doctor calendar view is one query, not N. */
  findSchedules(doctorIds: readonly string[]): Promise<Map<string, DoctorSchedule>>;
  saveSchedule(schedule: DoctorSchedule): Promise<void>;
}

export const AVAILABILITY_REPOSITORY = Symbol('AVAILABILITY_REPOSITORY');

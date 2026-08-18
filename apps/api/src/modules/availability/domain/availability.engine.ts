import {
  type Interval,
  chopIntoSlots,
  mergeIntervals,
  subtractIntervals,
} from '../../../shared/intervals/interval';
import {
  type RecurringAvailabilityRule,
  expandRules,
  type ExpandOptions,
} from '../../../shared/time/clinic-time';
import { type Appointment, heldSlots } from '../../appointments/domain/appointment';

/**
 * The availability engine.
 *
 *   free slots = recurring rules − exceptions − existing appointments
 *
 * Pure: no database, no clock, no framework. Every input is passed in, which is what
 * lets the whole engine be tested in milliseconds with no I/O and makes the DST cases
 * cheap to assert rather than something to hand-wave about.
 */

/**
 * A one-off block on a doctor's calendar: holiday, conference, blocked morning.
 * Stored as instants because an exception is a concrete "this actual period", unlike a
 * recurring rule which is a wall-clock pattern.
 */
export interface AvailabilityException {
  readonly id: string;
  readonly doctorId: string;
  readonly period: Interval;
}

export interface ComputeAvailabilityInput {
  readonly doctorId: string;
  readonly rules: readonly RecurringAvailabilityRule[];
  readonly exceptions: readonly AvailabilityException[];
  readonly appointments: readonly Appointment[];
  /** The window to compute over, as UTC instants. */
  readonly range: Interval;
  readonly slotDurationMinutes: number;
  readonly expandOptions?: ExpandOptions;
}

export const MINUTE_MS = 60_000;

/**
 * Compute bookable slots for one doctor.
 *
 * The pipeline reads as the formula it implements — the order matters and is not
 * arbitrary:
 *
 *   1. Expand recurring rules into concrete instants (the only timezone-aware step).
 *   2. Merge, so overlapping rules ("Tue 09:00-13:00" and "Tue 11:00-15:00") become one
 *      block rather than producing duplicate slots.
 *   3. Subtract exceptions and held appointment slots.
 *   4. Chop what remains into the fixed slot grid.
 *
 * Chopping LAST is the part worth defending. Chopping before subtracting would leave
 * slots that are partially blocked — a 30-minute slot with a 10-minute appointment
 * inside it would survive the subtraction as two unusable fragments, or worse, survive
 * whole. Subtracting first means every emitted slot is entirely free by construction.
 */
export function computeAvailability(input: ComputeAvailabilityInput): Interval[] {
  const { rules, exceptions, appointments, range, slotDurationMinutes, expandOptions } =
    input;

  if (slotDurationMinutes <= 0) {
    throw new Error(
      `slotDurationMinutes must be positive, received ${slotDurationMinutes}`,
    );
  }

  // 1 + 2: wall-clock rules become instants, then collapse into non-overlapping blocks.
  const working = mergeIntervals(expandRules(rules, range, expandOptions ?? {}));

  // 3: everything that removes time from the calendar. Exceptions and appointments are
  // subtracted together in one pass — they are indistinguishable as far as the algebra
  // cares, and merging them first avoids two full sweeps.
  const blockers: Interval[] = [
    ...exceptions.map((exception) => exception.period),
    ...appointments.flatMap(heldSlots),
  ];

  const free = subtractIntervals(working, blockers);

  // 4: the fixed grid.
  return chopIntoSlots(free, slotDurationMinutes * MINUTE_MS);
}

/**
 * Compute availability for many doctors at once — the calendar view's query.
 *
 * ---
 * PERFORMANCE NOTE: this is the O(n²) -> O(n) fix.
 *
 * The obvious implementation filters the shared lists inside the per-doctor loop:
 *
 *   for (const doctor of doctors) {
 *     const mine = appointments.filter((a) => a.doctorId === doctor.id);  // O(A)
 *     ...
 *   }
 *
 * That is O(D x A) — every doctor rescans every appointment in the entire result set.
 * With 50 doctors and 5,000 appointments in the window it is 250,000 comparisons, and it
 * degrades quadratically as the clinic grows, which is exactly the shape of bug that
 * passes code review and shows up as a slow endpoint six months later.
 *
 * Bucketing into a Map first is ONE pass over each list to build the index (O(A + E + R))
 * and then O(1) lookups inside the loop. Total O(A + E + R + D) instead of
 * O(D x (A + E + R)).
 *
 * The reason this is worth doing rather than premature optimisation: the input size is
 * driven by the clinic's size, which grows without any code change. A constant-factor
 * micro-optimisation would not be worth it; changing the complexity class is.
 * ---
 */
export function computeAvailabilityForDoctors(input: {
  readonly doctorIds: readonly string[];
  readonly rules: readonly RecurringAvailabilityRule[];
  readonly exceptions: readonly AvailabilityException[];
  readonly appointments: readonly Appointment[];
  readonly range: Interval;
  readonly slotDurationMinutes: number;
  readonly expandOptions?: ExpandOptions;
}): Map<string, Interval[]> {
  const rulesByDoctor = groupBy(input.rules, (rule) => rule.doctorId);
  const exceptionsByDoctor = groupBy(input.exceptions, (e) => e.doctorId);
  const appointmentsByDoctor = groupBy(input.appointments, (a) => a.doctorId);

  const result = new Map<string, Interval[]>();

  for (const doctorId of input.doctorIds) {
    result.set(
      doctorId,
      computeAvailability({
        doctorId,
        rules: rulesByDoctor.get(doctorId) ?? [],
        exceptions: exceptionsByDoctor.get(doctorId) ?? [],
        appointments: appointmentsByDoctor.get(doctorId) ?? [],
        range: input.range,
        slotDurationMinutes: input.slotDurationMinutes,
        ...(input.expandOptions === undefined
          ? {}
          : { expandOptions: input.expandOptions }),
      }),
    );
  }

  return result;
}

/** Single-pass bucketing. The Map that replaces the repeated `filter`. */
function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = map.get(k);
    if (bucket) {
      bucket.push(item);
    } else {
      map.set(k, [item]);
    }
  }
  return map;
}

/**
 * Is this exact slot still bookable?
 *
 * Used by the booking path as a fast pre-check. It is explicitly NOT the double-booking
 * guarantee — between this check and the insert, another request can take the slot. That
 * gap is unavoidable in application code, which is why Phase 4 puts the real guarantee in
 * a unique index and treats this only as a way to fail early with a nicer error.
 */
export function isSlotAvailable(
  slot: Interval,
  input: ComputeAvailabilityInput,
): boolean {
  return computeAvailability(input).some(
    (candidate) => candidate.start === slot.start && candidate.end === slot.end,
  );
}

import { DateTime } from 'luxon';
import { type Interval, interval } from '../intervals/interval';

/**
 * Expansion of recurring wall-clock rules into concrete UTC instants.
 *
 * This is the ONLY file in the domain where a timezone is applied. Everything downstream
 * works in epoch milliseconds; everything upstream stores an IANA identifier alongside a
 * local time. If a timezone bug exists in this system, it is here.
 *
 * The storage model, which is the part worth being able to state in one breath:
 *
 *   - Instants (when an appointment actually is) are stored as UTC.
 *   - Recurring rules are stored as LOCAL WALL-CLOCK TIME plus an IANA zone identifier
 *     ("every Tuesday 09:00-13:00 in Europe/Lisbon") — never as a UTC time, and never as
 *     a fixed offset.
 *
 * Why an IANA identifier and never an offset: "UTC+01:00" is what Lisbon is *today*, not
 * what Lisbon *is*. Store the offset and every rule silently shifts by an hour when DST
 * changes — the clinic's 09:00 appointment becomes 08:00 for half the year. The zone
 * identifier is a subscription to a rule that includes future political changes to that
 * rule; an offset is a snapshot of one moment.
 *
 * Why not store the UTC time of the recurrence: same failure, in the other direction. The
 * clinic means "09:00 as the receptionist reads the clock", and that maps to different
 * UTC instants across a DST boundary.
 */

/** Luxon weekday numbering: 1 = Monday ... 7 = Sunday. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface LocalTime {
  readonly hour: number;
  readonly minute: number;
}

export interface RecurringAvailabilityRule {
  readonly id: string;
  readonly doctorId: string;
  readonly weekday: Weekday;
  /** Wall-clock time in `timezone`, inclusive. */
  readonly startTime: LocalTime;
  /** Wall-clock time in `timezone`, exclusive. */
  readonly endTime: LocalTime;
  /** IANA identifier, e.g. "Europe/Lisbon". Never a fixed offset. */
  readonly timezone: string;
}

/**
 * How to handle a recurrence that lands in a DST spring-forward gap — a local time that
 * simply does not exist on that date.
 *
 * `skip` (the default) drops the occurrence entirely. For a clinic this is the honest
 * answer: if the clock jumps 01:00 -> 02:00, a 01:30 appointment was never a real moment,
 * and inventing one by shifting it silently moves every patient's appointment without
 * telling anyone.
 *
 * `shift` accepts Luxon's default behaviour of moving forward past the gap, which is
 * appropriate for things like "run this job daily" where skipping a day is worse than
 * running it an hour late.
 */
export type GapPolicy = 'skip' | 'shift';

export interface ExpandOptions {
  readonly gapPolicy?: GapPolicy;
}

/**
 * Does this local time actually exist in this zone on this date?
 *
 * Luxon does not return an invalid DateTime for a nonexistent local time — it silently
 * moves forward past the gap. So the only way to detect the gap is to construct the
 * DateTime and check whether it kept the hour and minute we asked for. If it did not,
 * the requested wall-clock time never occurred.
 */
function existsInZone(dt: DateTime, requested: LocalTime): boolean {
  return dt.hour === requested.hour && dt.minute === requested.minute;
}

function atLocalTime(day: DateTime, time: LocalTime): DateTime {
  return day.set({
    hour: time.hour,
    minute: time.minute,
    second: 0,
    millisecond: 0,
  });
}

/**
 * Expand one recurring rule into concrete UTC instants across `range`.
 *
 * Iterates day-by-day in the CLINIC's zone, not in UTC. That matters: "every Tuesday" is
 * a statement about the clinic's calendar, and near midnight a UTC day and a Lisbon day
 * are different days. Iterating in UTC would attach occurrences to the wrong weekday for
 * clinics far enough east or west.
 */
export function expandRule(
  rule: RecurringAvailabilityRule,
  range: Interval,
  options: ExpandOptions = {},
): Interval[] {
  const gapPolicy = options.gapPolicy ?? 'skip';
  const zone = rule.timezone;

  const rangeStart = DateTime.fromMillis(range.start, { zone });
  const rangeEnd = DateTime.fromMillis(range.end, { zone });

  const occurrences: Interval[] = [];

  // Start from the beginning of the local day so a range starting mid-day still catches
  // that day's occurrence.
  let day = rangeStart.startOf('day');

  while (day < rangeEnd) {
    if (day.weekday === rule.weekday) {
      const localStart = atLocalTime(day, rule.startTime);
      const localEnd = atLocalTime(day, rule.endTime);

      const startExists = existsInZone(localStart, rule.startTime);
      const endExists = existsInZone(localEnd, rule.endTime);

      if ((startExists && endExists) || gapPolicy === 'shift') {
        const startMs = localStart.toMillis();
        const endMs = localEnd.toMillis();

        // On a fall-back day this block is genuinely LONGER in real time than its
        // wall-clock length: 09:00-13:00 spans five hours when 01:00-02:00 happened
        // twice inside it. That is correct — the clinic really is open for five hours
        // that day. The arithmetic below gets this right for free precisely because it
        // works on instants rather than on wall-clock durations.
        //
        // For ambiguous times (the repeated hour itself), Luxon resolves to the FIRST
        // occurrence — the one before the clocks go back. Documented, and asserted in
        // the tests, so it cannot change silently under a library upgrade.
        // The `shift` policy can COLLAPSE an interval. A 02:30-03:30 rule on a
        // spring-forward day has its start shifted to 03:30, which is already its end —
        // a zero-length occurrence. Shifting cannot rescue every rule, so a collapsed
        // (or inverted) result is dropped here rather than allowed to reach
        // `interval()`, which would throw on an otherwise ordinary day's expansion.
        if (endMs > startMs) {
          const clippedStart = Math.max(startMs, range.start);
          const clippedEnd = Math.min(endMs, range.end);
          if (clippedEnd > clippedStart) {
            occurrences.push(interval(clippedStart, clippedEnd));
          }
        }
      }
    }

    // `plus({ days: 1 })` rather than adding 24 hours. On a DST boundary a local day is
    // 23 or 25 hours long, so adding a fixed duration would drift onto the wrong day.
    day = day.plus({ days: 1 }).startOf('day');
  }

  return occurrences;
}

/** Expand many rules at once. */
export function expandRules(
  rules: readonly RecurringAvailabilityRule[],
  range: Interval,
  options: ExpandOptions = {},
): Interval[] {
  return rules.flatMap((rule) => expandRule(rule, range, options));
}

/**
 * Render an instant in a given zone. Presentation only — no domain logic depends on it.
 * Exists so the API can label a slot with the clinic's local time alongside the UTC
 * instant, which is what stops a patient in a different zone guessing.
 */
export function describeInZone(instantMs: number, zone: string): string {
  return DateTime.fromMillis(instantMs, { zone }).toISO() ?? '';
}

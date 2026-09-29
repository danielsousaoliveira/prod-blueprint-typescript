import { DateTime } from 'luxon';
import { interval } from '../intervals/interval';
import {
  type RecurringAvailabilityRule,
  type Weekday,
  describeInZone,
  expandRule,
} from './clinic-time';

const utc = (iso: string): number => DateTime.fromISO(iso, { zone: 'utc' }).toMillis();
const HOUR = 3_600_000;

function rule(
  overrides: Partial<RecurringAvailabilityRule> = {},
): RecurringAvailabilityRule {
  return {
    id: 'rule-1',
    doctorId: 'doctor-1',
    weekday: 2,
    startTime: { hour: 9, minute: 0 },
    endTime: { hour: 13, minute: 0 },
    timezone: 'Europe/Lisbon',
    ...overrides,
  };
}

/**
 * Real DST transitions used throughout, verified against the tz database rather than
 * assumed:
 *
 *   America/New_York  2026-03-08  02:00 -> 03:00  (spring forward, 02:00-02:59 does not exist)
 *   America/New_York  2026-11-01  02:00 -> 01:00  (fall back, 01:00-01:59 happens twice)
 *   Europe/Lisbon     2026-03-29  01:00 -> 02:00  (spring forward)
 *
 * All four dates are Sundays — Luxon weekday 7.
 */
const SUNDAY: Weekday = 7;
const TUESDAY: Weekday = 2;

describe('expandRule — ordinary days', () => {
  it('expands a weekly rule to one occurrence per matching weekday', () => {
    // 2026-06-01 is a Monday, so this fortnight contains two Tuesdays.
    const occurrences = expandRule(
      rule({ weekday: TUESDAY }),
      interval(utc('2026-06-01T00:00'), utc('2026-06-15T00:00')),
    );
    expect(occurrences).toHaveLength(2);
  });

  it('produces the correct UTC instants for a summer (DST) date', () => {
    // Lisbon is UTC+1 in June, so 09:00 local is 08:00Z.
    const [occurrence] = expandRule(
      rule({ weekday: TUESDAY }),
      interval(utc('2026-06-02T00:00'), utc('2026-06-03T00:00')),
    );
    expect(occurrence?.start).toBe(utc('2026-06-02T08:00'));
    expect(occurrence?.end).toBe(utc('2026-06-02T12:00'));
  });

  it('produces DIFFERENT UTC instants for the same wall-clock rule in winter', () => {
    // Lisbon is UTC+0 in January, so the same 09:00 local rule is 09:00Z.
    //
    // This is the entire argument for storing wall-clock + zone rather than a UTC time:
    // one rule, two different UTC instants, and the clinic's clock reads 09:00 in both.
    // Storing "08:00Z" would have shifted every winter appointment to 08:00 local.
    const [occurrence] = expandRule(
      rule({ weekday: TUESDAY }),
      interval(utc('2026-01-06T00:00'), utc('2026-01-07T00:00')),
    );
    expect(occurrence?.start).toBe(utc('2026-01-06T09:00'));
  });

  it('clips occurrences to the requested range', () => {
    const occurrences = expandRule(
      rule({ weekday: TUESDAY }),
      // Range starts at 10:00Z = 11:00 Lisbon, mid-way through the 09:00-13:00 block.
      interval(utc('2026-06-02T10:00'), utc('2026-06-02T11:00')),
    );
    expect(occurrences).toEqual([
      interval(utc('2026-06-02T10:00'), utc('2026-06-02T11:00')),
    ]);
  });
});

describe('expandRule — spring forward (the gap)', () => {
  // On 2026-03-08 in New York the clocks jump 02:00 -> 03:00. A rule starting at 02:30
  // names a wall-clock time that never occurs on that date.
  const gapRule = rule({
    weekday: SUNDAY,
    startTime: { hour: 2, minute: 30 },
    endTime: { hour: 3, minute: 30 },
    timezone: 'America/New_York',
  });
  const thatSunday = interval(utc('2026-03-08T00:00'), utc('2026-03-09T00:00'));

  it('Luxon does NOT flag a nonexistent local time as invalid — it silently shifts it', () => {
    // Documenting the library behaviour that makes the gap check necessary in the first
    // place. Asking for 02:30 yields 03:30 with isValid === true. Anyone assuming an
    // invalid DateTime here would ship a silent one-hour shift.
    const asked = DateTime.fromObject(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
      { zone: 'America/New_York' },
    );
    expect(asked.isValid).toBe(true);
    expect(asked.hour).toBe(3);
  });

  it("skips the occurrence entirely under the default 'skip' policy", () => {
    // The honest answer for a clinic: 02:30 was never a real moment that day, so there
    // is no appointment to offer. Silently shifting it would move every patient's
    // appointment by an hour without telling anyone.
    expect(expandRule(gapRule, thatSunday)).toEqual([]);
  });

  it("shifts past the gap under the explicit 'shift' policy", () => {
    // A rule wide enough to survive the shift: 02:30 moves to 03:30, 05:30 is unaffected.
    const occurrences = expandRule(
      rule({
        weekday: SUNDAY,
        startTime: { hour: 2, minute: 30 },
        endTime: { hour: 5, minute: 30 },
        timezone: 'America/New_York',
      }),
      thatSunday,
      { gapPolicy: 'shift' },
    );
    expect(occurrences).toHaveLength(1);
    // 03:30 EDT (UTC-4) === 07:30Z, through 05:30 EDT === 09:30Z.
    expect(occurrences[0]?.start).toBe(utc('2026-03-08T07:30'));
    expect(occurrences[0]?.end).toBe(utc('2026-03-08T09:30'));
  });

  it("drops the occurrence even under 'shift' when the shift COLLAPSES it", () => {
    // Found by writing this test, not by reading the code: 02:30-03:30 has its start
    // shifted forward onto its own end, leaving nothing. 'shift' is not a policy that
    // rescues every rule — a rule shorter than the DST gap cannot survive it either way.
    expect(expandRule(gapRule, thatSunday, { gapPolicy: 'shift' })).toEqual([]);
  });

  it('is unaffected on the surrounding weeks', () => {
    const weekBefore = expandRule(
      gapRule,
      interval(utc('2026-03-01T00:00'), utc('2026-03-02T00:00')),
    );
    // 02:30 EST (UTC-5) === 07:30Z. The rule is fine; only the transition day is special.
    expect(weekBefore[0]?.start).toBe(utc('2026-03-01T07:30'));
  });
});

describe('expandRule — fall back (the repeated hour)', () => {
  // On 2026-11-01 in New York the clocks go back 02:00 -> 01:00, so 01:00-01:59 occurs
  // twice: once at UTC-4 and again at UTC-5.
  const fallBackSunday = interval(utc('2026-11-01T00:00'), utc('2026-11-02T00:00'));

  it('resolves an ambiguous local time to the FIRST occurrence', () => {
    // Asserted explicitly so a Luxon upgrade that changed this resolution would fail the
    // build rather than silently move appointments by an hour.
    const [occurrence] = expandRule(
      rule({
        weekday: SUNDAY,
        startTime: { hour: 1, minute: 30 },
        endTime: { hour: 3, minute: 0 },
        timezone: 'America/New_York',
      }),
      fallBackSunday,
    );
    // First occurrence is EDT (UTC-4): 01:30 -> 05:30Z. The second would be 06:30Z.
    expect(occurrence?.start).toBe(utc('2026-11-01T05:30'));
  });

  it('produces a block that is LONGER in real time than its wall-clock length', () => {
    // 00:30 to 02:30 reads as two hours on the clinic's clock, but three hours actually
    // elapse because the 01:00 hour happens twice. The clinic really is open for three
    // hours that day.
    //
    // The interval algebra gets this right for free precisely because it works on
    // instants. Code that computed durations by subtracting wall-clock times would be
    // an hour short and would under-book the day.
    const [occurrence] = expandRule(
      rule({
        weekday: SUNDAY,
        startTime: { hour: 0, minute: 30 },
        endTime: { hour: 2, minute: 30 },
        timezone: 'America/New_York',
      }),
      fallBackSunday,
    );

    expect(occurrence).toBeDefined();
    const elapsedHours = ((occurrence?.end ?? 0) - (occurrence?.start ?? 0)) / HOUR;
    expect(elapsedHours).toBe(3);
  });

  it('a normal week produces the plain two-hour block', () => {
    const [occurrence] = expandRule(
      rule({
        weekday: SUNDAY,
        startTime: { hour: 0, minute: 30 },
        endTime: { hour: 2, minute: 30 },
        timezone: 'America/New_York',
      }),
      interval(utc('2026-11-08T00:00'), utc('2026-11-09T00:00')),
    );
    const elapsedHours = ((occurrence?.end ?? 0) - (occurrence?.start ?? 0)) / HOUR;
    expect(elapsedHours).toBe(2);
  });
});

describe("expandRule — the weekday is the CLINIC's weekday", () => {
  it('attaches occurrences to the local day, not the UTC day', () => {
    // Auckland is UTC+13 in January. Monday 09:00 NZDT is SUNDAY 20:00 UTC.
    //
    // Iterating the range in UTC instead of the clinic's zone would test the wrong
    // day's weekday and either miss this occurrence or attach it to Sunday. For clinics
    // far enough east or west, "every Monday" silently becomes "every Sunday".
    const occurrences = expandRule(
      rule({
        weekday: 1,
        startTime: { hour: 9, minute: 0 },
        endTime: { hour: 17, minute: 0 },
        timezone: 'Pacific/Auckland',
      }),
      interval(utc('2026-01-11T00:00'), utc('2026-01-13T00:00')),
    );

    expect(occurrences).toHaveLength(1);
    const startUtc = DateTime.fromMillis(occurrences[0]?.start ?? 0, { zone: 'utc' });
    // The instant falls on Sunday in UTC...
    expect(startUtc.weekday).toBe(7);
    // ...but on Monday in Auckland, which is what the rule meant.
    expect(startUtc.setZone('Pacific/Auckland').weekday).toBe(1);
  });
});

describe('cross-timezone rendering', () => {
  it('shows one instant as different wall-clock times for doctor and patient', () => {
    // The doctor is in Lisbon, the patient in New York. There is ONE appointment — one
    // instant — and each side reads a different clock. Nothing about the stored data
    // differs per viewer; only the rendering does.
    const [occurrence] = expandRule(
      rule({ weekday: TUESDAY }),
      interval(utc('2026-06-02T00:00'), utc('2026-06-03T00:00')),
    );
    const instant = occurrence?.start ?? 0;

    expect(describeInZone(instant, 'Europe/Lisbon')).toBe(
      '2026-06-02T09:00:00.000+01:00',
    );
    expect(describeInZone(instant, 'America/New_York')).toBe(
      '2026-06-02T04:00:00.000-04:00',
    );

    // Same instant either way — the whole point.
    expect(DateTime.fromISO(describeInZone(instant, 'Europe/Lisbon')).toMillis()).toBe(
      DateTime.fromISO(describeInZone(instant, 'America/New_York')).toMillis(),
    );
  });
});

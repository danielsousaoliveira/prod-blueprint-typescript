import { DateTime } from 'luxon';
import { interval } from '../../../shared/intervals/interval';
import type { RecurringAvailabilityRule } from '../../../shared/time/clinic-time';
import type { Appointment } from '../../appointments/domain/appointment';
import {
  type AvailabilityException,
  computeAvailability,
  computeAvailabilityForDoctors,
  isSlotAvailable,
} from './availability.engine';

const utc = (iso: string): number => DateTime.fromISO(iso, { zone: 'utc' }).toMillis();

// 2026-06-02 is a Tuesday. Lisbon is UTC+1 in June, so the clinic's 09:00-13:00 is
// 08:00Z-12:00Z.
const TUESDAY = 2;
const day = interval(utc('2026-06-02T00:00'), utc('2026-06-03T00:00'));

const clinicRule: RecurringAvailabilityRule = {
  id: 'rule-1',
  doctorId: 'doctor-1',
  weekday: TUESDAY,
  startTime: { hour: 9, minute: 0 },
  endTime: { hour: 13, minute: 0 },
  timezone: 'Europe/Lisbon',
};

function confirmedAppointment(
  startIso: string,
  endIso: string,
  doctorId = 'doctor-1',
): Appointment {
  return {
    id: `appt-${startIso}`,
    doctorId,
    patientId: 'patient-1',
    slot: interval(utc(startIso), utc(endIso)),
    createdAt: utc('2026-06-01T00:00'),
    status: 'CONFIRMED',
    confirmedSlot: interval(utc(startIso), utc(endIso)),
    confirmedAt: utc('2026-06-01T00:00'),
  };
}

const baseInput = {
  doctorId: 'doctor-1',
  rules: [clinicRule],
  exceptions: [] as AvailabilityException[],
  appointments: [] as Appointment[],
  range: day,
  slotDurationMinutes: 30,
};

describe('computeAvailability', () => {
  it('produces a full grid of slots from the recurring rule alone', () => {
    const slots = computeAvailability(baseInput);
    // 4 clinic hours / 30 minutes = 8 slots.
    expect(slots).toHaveLength(8);
    expect(slots[0]).toEqual(interval(utc('2026-06-02T08:00'), utc('2026-06-02T08:30')));
    expect(slots[7]).toEqual(interval(utc('2026-06-02T11:30'), utc('2026-06-02T12:00')));
  });

  it('returns nothing on a day the rule does not cover', () => {
    const wednesday = interval(utc('2026-06-03T00:00'), utc('2026-06-04T00:00'));
    expect(computeAvailability({ ...baseInput, range: wednesday })).toEqual([]);
  });

  it('removes slots taken by an existing appointment', () => {
    const slots = computeAvailability({
      ...baseInput,
      appointments: [confirmedAppointment('2026-06-02T09:00', '2026-06-02T10:00')],
    });
    // Two 30-minute slots removed from eight.
    expect(slots).toHaveLength(6);
    expect(slots.some((s) => s.start === utc('2026-06-02T09:00'))).toBe(false);
    expect(slots.some((s) => s.start === utc('2026-06-02T09:30'))).toBe(false);
  });

  it('removes slots covered by an exception', () => {
    const exception: AvailabilityException = {
      id: 'exc-1',
      doctorId: 'doctor-1',
      period: interval(utc('2026-06-02T08:00'), utc('2026-06-02T10:00')),
    };
    expect(computeAvailability({ ...baseInput, exceptions: [exception] })).toHaveLength(
      4,
    );
  });

  it('subtracts exceptions AND appointments together', () => {
    const slots = computeAvailability({
      ...baseInput,
      exceptions: [
        {
          id: 'exc-1',
          doctorId: 'doctor-1',
          period: interval(utc('2026-06-02T08:00'), utc('2026-06-02T09:00')),
        },
      ],
      appointments: [confirmedAppointment('2026-06-02T11:00', '2026-06-02T12:00')],
    });
    expect(slots).toHaveLength(4);
  });

  it('ignores appointments in terminal states', () => {
    // A cancelled appointment must release its slot. If it did not, every cancellation
    // would permanently burn a slot.
    const cancelled: Appointment = {
      id: 'appt-cancelled',
      doctorId: 'doctor-1',
      patientId: 'patient-1',
      slot: interval(utc('2026-06-02T09:00'), utc('2026-06-02T10:00')),
      createdAt: utc('2026-06-01T00:00'),
      status: 'CANCELLED',
      cancelledBy: 'patient',
      cancelledAt: utc('2026-06-01T12:00'),
    };
    expect(computeAvailability({ ...baseInput, appointments: [cancelled] })).toHaveLength(
      8,
    );
  });

  it('blocks BOTH slots held by a counter-proposed appointment', () => {
    const counterProposed: Appointment = {
      id: 'appt-cp',
      doctorId: 'doctor-1',
      patientId: 'patient-1',
      slot: interval(utc('2026-06-02T09:00'), utc('2026-06-02T09:30')),
      createdAt: utc('2026-06-01T00:00'),
      status: 'COUNTER_PROPOSED',
      proposedSlot: interval(utc('2026-06-02T11:00'), utc('2026-06-02T11:30')),
      proposedAt: utc('2026-06-01T12:00'),
    };
    const slots = computeAvailability({
      ...baseInput,
      appointments: [counterProposed],
    });
    expect(slots).toHaveLength(6);
    // Offering the proposed slot to someone else while the patient decides is a
    // guaranteed double booking the moment they accept.
    expect(slots.some((s) => s.start === utc('2026-06-02T11:00'))).toBe(false);
  });

  it('does not offer a slot partially blocked by an off-grid appointment', () => {
    // A 15-minute appointment at 08:15 sits inside the 08:00-08:30 slot. Chopping into
    // slots BEFORE subtracting would have left that slot bookable.
    const slots = computeAvailability({
      ...baseInput,
      appointments: [confirmedAppointment('2026-06-02T08:15', '2026-06-02T08:30')],
    });
    expect(slots.some((s) => s.start === utc('2026-06-02T08:00'))).toBe(false);
    expect(slots).toHaveLength(7);
  });

  it('merges overlapping rules instead of producing duplicate slots', () => {
    const overlapping: RecurringAvailabilityRule = {
      ...clinicRule,
      id: 'rule-2',
      startTime: { hour: 11, minute: 0 },
      endTime: { hour: 15, minute: 0 },
    };
    const slots = computeAvailability({
      ...baseInput,
      rules: [clinicRule, overlapping],
    });
    // 09:00-15:00 clinic time = 6 hours = 12 slots, not 8 + 8.
    expect(slots).toHaveLength(12);
    const starts = slots.map((s) => s.start);
    expect(new Set(starts).size).toBe(starts.length);
  });

  it('rejects a non-positive slot duration', () => {
    expect(() => computeAvailability({ ...baseInput, slotDurationMinutes: 0 })).toThrow();
  });
});

describe('computeAvailability — DST', () => {
  it('keeps clinic-local opening hours stable across a DST boundary', () => {
    // The clinic opens at 09:00 local in both June and January. The UTC instants differ
    // (08:00Z vs 09:00Z) but the number of slots and the LOCAL time must not.
    const january = interval(utc('2026-01-06T00:00'), utc('2026-01-07T00:00'));
    const winter = computeAvailability({ ...baseInput, range: january });
    const summer = computeAvailability(baseInput);

    expect(winter).toHaveLength(summer.length);
    expect(winter[0]?.start).toBe(utc('2026-01-06T09:00'));
    expect(summer[0]?.start).toBe(utc('2026-06-02T08:00'));

    // Both are 09:00 on the clinic's clock — which is the property that matters.
    for (const [slots, zone] of [
      [winter, 'Europe/Lisbon'],
      [summer, 'Europe/Lisbon'],
    ] as const) {
      expect(DateTime.fromMillis(slots[0]?.start ?? 0, { zone }).hour).toBe(9);
    }
  });

  it('yields an extra hour of slots on a fall-back day', () => {
    // New York, 2026-11-01: the clocks go back, so 00:30-04:30 local spans five real
    // hours. A clinic open those hours genuinely has an extra hour of capacity.
    const nyRule: RecurringAvailabilityRule = {
      id: 'rule-ny',
      doctorId: 'doctor-1',
      weekday: 7,
      startTime: { hour: 0, minute: 30 },
      endTime: { hour: 4, minute: 30 },
      timezone: 'America/New_York',
    };

    const fallBack = computeAvailability({
      ...baseInput,
      rules: [nyRule],
      range: interval(utc('2026-11-01T00:00'), utc('2026-11-02T00:00')),
    });
    const normal = computeAvailability({
      ...baseInput,
      rules: [nyRule],
      range: interval(utc('2026-11-08T00:00'), utc('2026-11-09T00:00')),
    });

    expect(normal).toHaveLength(8); // 4 hours
    expect(fallBack).toHaveLength(10); // 5 real hours
  });

  it('drops occurrences that fall in a spring-forward gap', () => {
    const gapRule: RecurringAvailabilityRule = {
      id: 'rule-gap',
      doctorId: 'doctor-1',
      weekday: 7,
      startTime: { hour: 2, minute: 30 },
      endTime: { hour: 3, minute: 30 },
      timezone: 'America/New_York',
    };
    expect(
      computeAvailability({
        ...baseInput,
        rules: [gapRule],
        range: interval(utc('2026-03-08T00:00'), utc('2026-03-09T00:00')),
      }),
    ).toEqual([]);
  });
});

describe('computeAvailabilityForDoctors', () => {
  it('partitions rules and appointments by doctor', () => {
    const doctorTwoRule: RecurringAvailabilityRule = {
      ...clinicRule,
      id: 'rule-d2',
      doctorId: 'doctor-2',
      startTime: { hour: 14, minute: 0 },
      endTime: { hour: 16, minute: 0 },
    };

    const result = computeAvailabilityForDoctors({
      doctorIds: ['doctor-1', 'doctor-2'],
      rules: [clinicRule, doctorTwoRule],
      exceptions: [],
      appointments: [
        confirmedAppointment('2026-06-02T09:00', '2026-06-02T10:00', 'doctor-1'),
      ],
      range: day,
      slotDurationMinutes: 30,
    });

    // doctor-1: 8 slots minus the 2 they are booked for.
    expect(result.get('doctor-1')).toHaveLength(6);
    // doctor-2: 2 clinic hours, and crucially UNAFFECTED by doctor-1's appointment.
    expect(result.get('doctor-2')).toHaveLength(4);
  });

  it('returns an empty list for a doctor with no rules', () => {
    const result = computeAvailabilityForDoctors({
      doctorIds: ['doctor-1', 'doctor-unknown'],
      rules: [clinicRule],
      exceptions: [],
      appointments: [],
      range: day,
      slotDurationMinutes: 30,
    });
    expect(result.get('doctor-unknown')).toEqual([]);
  });

  it('matches the single-doctor result exactly', () => {
    // The Map-bucketing optimisation must not change behaviour — only complexity.
    const many = computeAvailabilityForDoctors({
      doctorIds: ['doctor-1'],
      rules: [clinicRule],
      exceptions: [],
      appointments: [confirmedAppointment('2026-06-02T09:00', '2026-06-02T10:00')],
      range: day,
      slotDurationMinutes: 30,
    });
    const one = computeAvailability({
      ...baseInput,
      appointments: [confirmedAppointment('2026-06-02T09:00', '2026-06-02T10:00')],
    });
    expect(many.get('doctor-1')).toEqual(one);
  });
});

describe('isSlotAvailable', () => {
  it('is true for an exact free slot', () => {
    expect(
      isSlotAvailable(
        interval(utc('2026-06-02T08:00'), utc('2026-06-02T08:30')),
        baseInput,
      ),
    ).toBe(true);
  });

  it('is false for a slot that is taken', () => {
    expect(
      isSlotAvailable(interval(utc('2026-06-02T08:00'), utc('2026-06-02T08:30')), {
        ...baseInput,
        appointments: [confirmedAppointment('2026-06-02T08:00', '2026-06-02T08:30')],
      }),
    ).toBe(false);
  });

  it('is false for a slot that is free but off the grid', () => {
    // 08:15-08:45 sits inside working hours and overlaps nothing, but it is not a
    // bookable slot. Booking off-grid times is what would break the unique-index
    // guarantee in Phase 4.
    expect(
      isSlotAvailable(
        interval(utc('2026-06-02T08:15'), utc('2026-06-02T08:45')),
        baseInput,
      ),
    ).toBe(false);
  });
});

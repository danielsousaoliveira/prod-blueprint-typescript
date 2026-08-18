import { describe, expect, it } from 'vitest';
import { formatSlot, groupByViewerDay, weekRange } from './time';

/**
 * The frontend's timezone contract.
 *
 * Every test passes an explicit `viewerZone` rather than relying on the machine's zone —
 * a test that reads the system timezone passes on my laptop and fails in CI (which is
 * UTC), or worse, passes in both for different reasons.
 */

const LISBON = 'Europe/Lisbon';

describe('formatSlot', () => {
  it('renders in the VIEWER timezone, not the clinic one', () => {
    // 08:00Z is 09:00 in Lisbon (June, UTC+1) and 04:00 in New York (UTC-4).
    const formatted = formatSlot('2027-06-01T08:00:00.000Z', LISBON, 'America/New_York');

    // The number the patient reads is THEIR time.
    expect(formatted.viewerTime).toBe('04:00');
    // The clinic's clock is available alongside it.
    expect(formatted.clinicTime).toBe('09:00');
    expect(formatted.zonesDiffer).toBe(true);
  });

  it('does not clutter the UI when viewer and clinic agree', () => {
    const formatted = formatSlot('2027-06-01T08:00:00.000Z', LISBON, LISBON);

    expect(formatted.viewerTime).toBe('09:00');
    expect(formatted.zonesDiffer).toBe(false);
  });

  it('compares OFFSETS, not zone names, so identical clocks are not flagged', () => {
    // London and Lisbon share an offset year-round. Comparing zone identifiers would
    // wrongly report a difference and show a redundant "clinic time" on every slot.
    const formatted = formatSlot('2027-06-01T08:00:00.000Z', LISBON, 'Europe/London');

    expect(formatted.viewerTime).toBe(formatted.clinicTime);
    expect(formatted.zonesDiffer).toBe(false);
  });

  it('renders the SAME instant differently either side of a DST change', () => {
    // The clinic's 09:00 is 08:00Z in June (UTC+1) and 09:00Z in January (UTC+0). The
    // patient must read 09:00 in both cases — that is the whole point of the server
    // storing wall-clock rules rather than a fixed UTC time.
    const june = formatSlot('2027-06-01T08:00:00.000Z', LISBON, LISBON);
    const january = formatSlot('2027-01-05T09:00:00.000Z', LISBON, LISBON);

    expect(june.viewerTime).toBe('09:00');
    expect(january.viewerTime).toBe('09:00');
  });

  it('handles the week when Europe has changed clocks and the US has not', () => {
    // The gap between Lisbon and New York is normally 5 hours — UTC+1/UTC-4 in summer,
    // UTC+0/UTC-5 in winter. But the two regions change on DIFFERENT dates: the EU on the
    // last Sunday of October, the US on the first Sunday of November. For the week
    // between, the gap is 4 hours.
    //
    // Verified against real tz data rather than assumed — my first attempt at this test
    // picked 27 October, which is still inside EU summer time.
    const divergent = formatSlot('2027-11-02T09:00:00.000Z', LISBON, 'America/New_York');
    expect(divergent.clinicTime).toBe('09:00');
    expect(divergent.viewerTime).toBe('05:00'); // 4-hour gap

    const normal = formatSlot('2027-11-09T09:00:00.000Z', LISBON, 'America/New_York');
    expect(normal.clinicTime).toBe('09:00');
    expect(normal.viewerTime).toBe('04:00'); // back to the usual 5-hour gap

    // A client that hardcoded an offset would be an hour wrong for exactly one week a
    // year — the kind of bug that gets reported as "sometimes the times are wrong".
  });

  it('exposes a machine-readable instant for the time element', () => {
    const formatted = formatSlot('2027-06-01T08:00:00.000Z', LISBON, 'America/New_York');
    // Unambiguous regardless of how it is displayed — this is what a `<time datetime>`
    // attribute is for, and what a crawler or assistive tool reads.
    expect(formatted.machineReadable).toBe('2027-06-01T08:00:00.000Z');
  });
});

describe('groupByViewerDay', () => {
  it('groups by the VIEWER day, which can differ from the clinic day', () => {
    // 23:30 in Lisbon on 1 June is 07:30 on 2 June in Tokyo. A patient in Tokyo should
    // see it under 2 June, because that is the date they will write in their calendar.
    const groups = groupByViewerDay(
      [{ startsAt: '2027-06-01T22:30:00.000Z' }],
      'Asia/Tokyo',
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.day).toBe('2027-06-02');
  });

  it('keeps days in chronological order', () => {
    const groups = groupByViewerDay(
      [
        { startsAt: '2027-06-03T08:00:00.000Z' },
        { startsAt: '2027-06-01T08:00:00.000Z' },
        { startsAt: '2027-06-02T08:00:00.000Z' },
      ],
      LISBON,
    );

    expect(groups.map((g) => g.day)).toEqual(['2027-06-01', '2027-06-02', '2027-06-03']);
  });

  it('collects several slots into one day', () => {
    const groups = groupByViewerDay(
      [
        { startsAt: '2027-06-01T08:00:00.000Z' },
        { startsAt: '2027-06-01T08:30:00.000Z' },
        { startsAt: '2027-06-01T09:00:00.000Z' },
      ],
      LISBON,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.slots).toHaveLength(3);
  });

  it('returns nothing for no slots', () => {
    expect(groupByViewerDay([], LISBON)).toEqual([]);
  });
});

describe('weekRange', () => {
  it('spans seven days from the start of the given day', () => {
    const range = weekRange(new Date('2027-06-01T13:45:00.000Z'));

    expect(range.from).toBe('2027-06-01T00:00:00.000Z');
    expect(range.to).toBe('2027-06-08T00:00:00.000Z');
  });
});

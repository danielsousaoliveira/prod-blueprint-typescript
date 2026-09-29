import {
  InvalidIntervalError,
  chopIntoSlots,
  contains,
  interval,
  intersection,
  mergeIntervals,
  overlaps,
  subtractIntervals,
} from './interval';

// Readable fixtures: `h(9)` is 09:00 on an arbitrary day, in milliseconds. The algebra
// has no notion of days or zones, so any origin works — using hours keeps the
// assertions legible.
const HOUR = 3_600_000;
const h = (hours: number): number => hours * HOUR;
const iv = (startHour: number, endHour: number) => interval(h(startHour), h(endHour));

describe('interval()', () => {
  it('rejects an inverted interval', () => {
    expect(() => interval(h(10), h(9))).toThrow(InvalidIntervalError);
  });

  it('rejects a zero-length interval', () => {
    // Zero-length intervals are rejected at construction because they overlap nothing,
    // contain nothing, and silently disappear from subtraction.
    expect(() => interval(h(9), h(9))).toThrow(InvalidIntervalError);
  });
});

describe('overlaps()', () => {
  it('is false for disjoint intervals', () => {
    expect(overlaps(iv(9, 10), iv(11, 12))).toBe(false);
  });

  it('is FALSE for exactly touching intervals', () => {
    // The half-open property. 09:00-10:00 and 10:00-11:00 are back-to-back
    // appointments, not a double booking. If this ever flips to true, every
    // consecutive booking in the system becomes a conflict.
    expect(overlaps(iv(9, 10), iv(10, 11))).toBe(false);
    expect(overlaps(iv(10, 11), iv(9, 10))).toBe(false);
  });

  it('is true for partial overlap, in both argument orders', () => {
    expect(overlaps(iv(9, 11), iv(10, 12))).toBe(true);
    expect(overlaps(iv(10, 12), iv(9, 11))).toBe(true);
  });

  it('is true when one interval contains the other', () => {
    expect(overlaps(iv(9, 17), iv(12, 13))).toBe(true);
    expect(overlaps(iv(12, 13), iv(9, 17))).toBe(true);
  });

  it('is true for identical intervals', () => {
    expect(overlaps(iv(9, 10), iv(9, 10))).toBe(true);
  });

  it('is symmetric for every case', () => {
    const cases: [number, number, number, number][] = [
      [9, 10, 10, 11],
      [9, 12, 10, 11],
      [9, 10, 9, 10],
      [9, 10, 15, 16],
    ];
    for (const [aS, aE, bS, bE] of cases) {
      expect(overlaps(iv(aS, aE), iv(bS, bE))).toBe(overlaps(iv(bS, bE), iv(aS, aE)));
    }
  });
});

describe('contains() and intersection()', () => {
  it('contains is inclusive of shared boundaries', () => {
    expect(contains(iv(9, 17), iv(9, 17))).toBe(true);
    expect(contains(iv(9, 17), iv(9, 10))).toBe(true);
    expect(contains(iv(9, 17), iv(8, 10))).toBe(false);
  });

  it('intersection returns the overlapping portion', () => {
    expect(intersection(iv(9, 12), iv(11, 14))).toEqual(iv(11, 12));
  });

  it('intersection is null for touching intervals', () => {
    expect(intersection(iv(9, 10), iv(10, 11))).toBeNull();
  });
});

describe('mergeIntervals()', () => {
  it('returns empty for no input', () => {
    expect(mergeIntervals([])).toEqual([]);
  });

  it('returns a single interval unchanged', () => {
    expect(mergeIntervals([iv(9, 10)])).toEqual([iv(9, 10)]);
  });

  it('leaves disjoint intervals separate', () => {
    expect(mergeIntervals([iv(9, 10), iv(14, 15)])).toEqual([iv(9, 10), iv(14, 15)]);
  });

  it('sorts unsorted input', () => {
    expect(mergeIntervals([iv(14, 15), iv(9, 10)])).toEqual([iv(9, 10), iv(14, 15)]);
  });

  it('merges overlapping intervals', () => {
    expect(mergeIntervals([iv(9, 12), iv(11, 14)])).toEqual([iv(9, 14)]);
  });

  it('merges ADJACENT intervals into one contiguous block', () => {
    // Adjacent intervals do not overlap, but as free time they are continuous. Leaving
    // them split would stop a 2-hour appointment fitting into two touching 1-hour
    // blocks of availability.
    expect(mergeIntervals([iv(9, 10), iv(10, 11)])).toEqual([iv(9, 11)]);
  });

  it('does not shrink when a later interval is fully contained', () => {
    // The Math.max case: [9,17) followed by [10,11) must stay [9,17), not become [9,11).
    expect(mergeIntervals([iv(9, 17), iv(10, 11)])).toEqual([iv(9, 17)]);
  });

  it('collapses a chain of overlaps into one', () => {
    expect(mergeIntervals([iv(9, 11), iv(10, 13), iv(12, 15)])).toEqual([iv(9, 15)]);
  });

  it('does not mutate its input', () => {
    const input = [iv(14, 15), iv(9, 10)];
    const snapshot = [...input];
    mergeIntervals(input);
    expect(input).toEqual(snapshot);
  });
});

describe('subtractIntervals()', () => {
  it('returns the base unchanged when there are no blockers', () => {
    expect(subtractIntervals([iv(9, 17)], [])).toEqual([iv(9, 17)]);
  });

  it('punches a hole in the middle', () => {
    expect(subtractIntervals([iv(9, 17)], [iv(12, 13)])).toEqual([iv(9, 12), iv(13, 17)]);
  });

  it('trims the leading edge', () => {
    expect(subtractIntervals([iv(9, 17)], [iv(8, 10)])).toEqual([iv(10, 17)]);
  });

  it('trims the trailing edge', () => {
    expect(subtractIntervals([iv(9, 17)], [iv(16, 20)])).toEqual([iv(9, 16)]);
  });

  it('removes the region entirely when fully covered', () => {
    expect(subtractIntervals([iv(9, 17)], [iv(8, 18)])).toEqual([]);
  });

  it('ignores blockers that merely touch the boundary', () => {
    // Half-openness again: an appointment ending exactly at 09:00 blocks nothing from
    // a 09:00-17:00 working day.
    expect(subtractIntervals([iv(9, 17)], [iv(8, 9)])).toEqual([iv(9, 17)]);
    expect(subtractIntervals([iv(9, 17)], [iv(17, 18)])).toEqual([iv(9, 17)]);
  });

  it('handles multiple blockers in one region', () => {
    expect(subtractIntervals([iv(9, 17)], [iv(10, 11), iv(13, 14)])).toEqual([
      iv(9, 10),
      iv(11, 13),
      iv(14, 17),
    ]);
  });

  it('handles OVERLAPPING blockers without emitting inverted fragments', () => {
    // This is why blockers are merged before the sweep. Without merging, the second
    // blocker would carve a region the first had already removed and produce garbage.
    expect(subtractIntervals([iv(9, 17)], [iv(10, 13), iv(11, 14)])).toEqual([
      iv(9, 10),
      iv(14, 17),
    ]);
  });

  it('handles unsorted blockers', () => {
    expect(subtractIntervals([iv(9, 17)], [iv(13, 14), iv(10, 11)])).toEqual([
      iv(9, 10),
      iv(11, 13),
      iv(14, 17),
    ]);
  });

  it('applies blockers across multiple base regions', () => {
    expect(subtractIntervals([iv(9, 12), iv(14, 17)], [iv(10, 11), iv(15, 16)])).toEqual([
      iv(9, 10),
      iv(11, 12),
      iv(14, 15),
      iv(16, 17),
    ]);
  });

  it('never returns a zero-length or inverted interval', () => {
    const result = subtractIntervals([iv(9, 17)], [iv(9, 10), iv(10, 11), iv(11, 17)]);
    expect(result).toEqual([]);
    for (const r of result) expect(r.end).toBeGreaterThan(r.start);
  });
});

describe('chopIntoSlots()', () => {
  const THIRTY_MIN = 30 * 60_000;

  it('chops a region into equal slots', () => {
    expect(chopIntoSlots([iv(9, 11)], THIRTY_MIN)).toHaveLength(4);
  });

  it('discards a remainder shorter than one slot', () => {
    // 09:00-10:20 yields two 30-minute slots; the 20-minute tail is not bookable.
    const slots = chopIntoSlots([interval(h(9), h(9) + 80 * 60_000)], THIRTY_MIN);
    expect(slots).toHaveLength(2);
    expect(slots[1]?.end).toBe(h(10));
  });

  it('yields nothing when the region is shorter than a slot', () => {
    expect(chopIntoSlots([interval(h(9), h(9) + 10 * 60_000)], THIRTY_MIN)).toEqual([]);
  });

  it('aligns slots to each region start, not to a global grid', () => {
    const slots = chopIntoSlots([interval(h(9) + 15 * 60_000, h(11))], THIRTY_MIN);
    expect(slots[0]?.start).toBe(h(9) + 15 * 60_000);
  });

  it('rejects a non-positive slot duration', () => {
    expect(() => chopIntoSlots([iv(9, 10)], 0)).toThrow();
  });
});

/**
 * Interval algebra over instants.
 *
 * Deliberately knows nothing about timezones. An `Interval` is a pair of epoch
 * milliseconds — two points on the universal timeline — and every operation here is
 * plain arithmetic. Timezones are a property of how a wall-clock RULE is expanded into
 * instants (see `shared/time/clinic-time.ts`) and of how an instant is DISPLAYED. They
 * are not a property of the instant itself.
 *
 * That separation is the whole timezone strategy in one sentence: there is exactly one
 * place where a zone can be applied wrongly, and it is not this file. None of the
 * algorithms below can have a DST bug, because none of them can see a DST transition.
 *
 * All intervals are HALF-OPEN: `[start, end)`. The end instant is excluded. This is what
 * makes 09:00–10:00 and 10:00–11:00 adjacent rather than overlapping — with closed
 * intervals every back-to-back appointment would collide at its boundary.
 */

export interface Interval {
  /** Inclusive start, epoch milliseconds. */
  readonly start: number;
  /** Exclusive end, epoch milliseconds. */
  readonly end: number;
}

export class InvalidIntervalError extends Error {
  constructor(start: number, end: number) {
    super(`Invalid interval: end (${end}) must be strictly after start (${start})`);
    this.name = 'InvalidIntervalError';
  }
}

/**
 * Smart constructor. Empty and inverted intervals are rejected at creation rather than
 * tolerated downstream — a zero-length interval would satisfy neither `overlaps` nor
 * `contains` and would silently vanish from any subtraction, which is the kind of bug
 * that shows up as "the slot just isn't there" three layers away.
 */
export function interval(start: number, end: number): Interval {
  if (!(end > start)) throw new InvalidIntervalError(start, end);
  return { start, end };
}

/**
 * The single overlap predicate everything else is built on.
 *
 * `a.start < b.end && b.start < a.end`
 *
 * Worth being able to derive this out loud rather than memorising it. Two intervals fail
 * to overlap in exactly two ways: `a` ends before `b` begins (`a.end <= b.start`), or `b`
 * ends before `a` begins (`b.end <= a.start`). Overlap is the negation of that
 * disjunction, and De Morgan turns `!(a.end <= b.start || b.end <= a.start)` into
 * `a.end > b.start && b.end > a.start` — the expression below.
 *
 * The `<` rather than `<=` is what encodes half-openness: touching intervals
 * (`a.end === b.start`) do not overlap.
 */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/** True when `outer` fully contains `inner`. */
export function contains(outer: Interval, inner: Interval): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/** The overlapping portion of two intervals, or null when they are disjoint. */
export function intersection(a: Interval, b: Interval): Interval | null {
  if (!overlaps(a, b)) return null;
  return { start: Math.max(a.start, b.start), end: Math.min(a.end, b.end) };
}

/**
 * Merge overlapping and adjacent intervals — sort by start, then sweep once.
 *
 * O(n log n), dominated by the sort; the sweep itself is O(n) and touches each interval
 * exactly once. The naive alternative is comparing every pair and merging repeatedly,
 * which is O(n²) per pass and needs multiple passes to reach a fixed point.
 *
 * The sweep works because after sorting by start, any interval that overlaps the one
 * being accumulated must start within it. So a single "does this one start before the
 * current run ends?" test is sufficient — there is no need to look backwards.
 *
 * Adjacent intervals are merged too (`start <= current.end`, not `<`): 09:00–10:00 and
 * 10:00–11:00 become one 09:00–11:00 block of availability. They do not OVERLAP, but as
 * free time they are continuous, and leaving them split would let a 60-minute slot fail
 * to fit inside two hours of contiguous free time.
 */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  if (intervals.length === 0) return [];

  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];

  // noUncheckedIndexedAccess means sorted[0] is `Interval | undefined`. The length check
  // above proves it exists, but the compiler cannot know that — so we destructure
  // defensively rather than asserting with `!`, which would discard the guarantee the
  // flag exists to provide.
  const [first, ...rest] = sorted;
  if (!first) return [];

  let current: Interval = first;

  for (const next of rest) {
    if (next.start <= current.end) {
      // Overlapping or adjacent: extend the run. `Math.max` matters because `next` may
      // be fully CONTAINED in `current`, in which case the run must not shrink.
      current = { start: current.start, end: Math.max(current.end, next.end) };
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);

  return merged;
}

/**
 * `base − blockers`: the parts of `base` not covered by any interval in `blockers`.
 *
 * This is the core of the availability engine — free time is
 * `working hours − exceptions − existing appointments`, which is two applications of
 * this function.
 *
 * Both inputs are merged first. That is not just tidiness: merging makes both lists
 * sorted and non-overlapping, which is what lets the inner loop advance a single cursor
 * and `break` early instead of re-scanning. Without it, overlapping blockers could carve
 * the same region twice and emit inverted fragments.
 *
 * O(n log n + m log m) for the sorts, then a linear walk.
 */
export function subtractIntervals(
  base: readonly Interval[],
  blockers: readonly Interval[],
): Interval[] {
  const merged = mergeIntervals(base);
  if (blockers.length === 0) return merged;

  const obstacles = mergeIntervals(blockers);
  const result: Interval[] = [];

  for (const region of merged) {
    // `cursor` is the start of the not-yet-emitted remainder of this region.
    let cursor = region.start;

    for (const obstacle of obstacles) {
      // Obstacle ends at or before the cursor — already behind us, nothing to carve.
      if (obstacle.end <= cursor) continue;
      // Obstacles are sorted ascending and non-overlapping, so once one starts at or
      // after the region's end, every remaining obstacle does too.
      if (obstacle.start >= region.end) break;

      // Free gap between the cursor and this obstacle.
      if (obstacle.start > cursor) {
        result.push({ start: cursor, end: obstacle.start });
      }

      cursor = Math.max(cursor, obstacle.end);
      if (cursor >= region.end) break;
    }

    // Whatever survives after the last obstacle.
    if (cursor < region.end) {
      result.push({ start: cursor, end: region.end });
    }
  }

  return result;
}

/**
 * Chop free regions into a fixed grid of equal-length slots.
 *
 * Slots are aligned to each region's start and any remainder shorter than the slot
 * length is discarded — a 20-minute tail of a 50-minute gap is not a bookable
 * 30-minute appointment.
 *
 * The fixed grid is a deliberate design decision, not a simplification for its own sake:
 * it is what makes a unique index on `(doctorId, startsAt)` a real double-booking
 * guarantee in Phase 4. With variable-length appointments, two bookings could overlap
 * without sharing a start instant, and no unique index can express that — it becomes a
 * range-overlap constraint needing a transaction with a range query, or Postgres
 * `EXCLUDE ... USING gist`. See DECISIONS.md.
 */
export function chopIntoSlots(
  regions: readonly Interval[],
  slotDurationMs: number,
): Interval[] {
  if (slotDurationMs <= 0) {
    throw new Error(`slotDurationMs must be positive, received ${slotDurationMs}`);
  }

  const slots: Interval[] = [];

  for (const region of regions) {
    for (
      let start = region.start;
      start + slotDurationMs <= region.end;
      start += slotDurationMs
    ) {
      slots.push({ start, end: start + slotDurationMs });
    }
  }

  return slots;
}

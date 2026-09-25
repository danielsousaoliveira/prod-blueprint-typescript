import { DateTime } from 'luxon';

/**
 * The ONE place the frontend converts or formats an instant.
 *
 * ============================================================================
 * THE RENDERING RULE
 * ============================================================================
 *
 * Render in the VIEWER's timezone. Always label the CLINIC's. Show both when they differ.
 *
 * The classic bug is rendering in one zone and labelling with the other — a patient in
 * London sees "09:00 (Europe/Lisbon)" for a slot that is 09:00 in Lisbon and 08:00 for
 * them, and turns up an hour late. Stating the rule once and applying it in one module is
 * what prevents each component inventing its own answer.
 *
 * Everything the API returns is a UTC instant as an ISO string. The frontend NEVER does
 * timezone arithmetic — no adding offsets, no constructing local dates from parts. It
 * receives instants and formats them. All the hard timezone logic (DST gaps, repeated
 * hours, recurring rules) lives server-side in `shared/time/clinic-time.ts`, and
 * duplicating any of it here would mean two implementations that can disagree.
 * ============================================================================
 */

/** The viewer's zone, from the browser. Overridable so tests are not machine-dependent. */
export function viewerZone(override?: string): string {
  return override ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export interface FormattedSlot {
  /** Time in the viewer's zone — what the user reads. */
  readonly viewerTime: string;
  /** Time on the clinic's clock. */
  readonly clinicTime: string;
  /** True when the two differ, so the UI can show both without cluttering when they match. */
  readonly zonesDiffer: boolean;
  readonly clinicZone: string;
  readonly viewerZoneName: string;
  /** For a `<time datetime="...">` attribute — machine-readable, unambiguous. */
  readonly machineReadable: string;
}

export function formatSlot(
  isoInstant: string,
  clinicZone: string,
  viewerZoneOverride?: string,
): FormattedSlot {
  const zone = viewerZone(viewerZoneOverride);
  const instant = DateTime.fromISO(isoInstant, { zone: 'utc' });

  const inViewer = instant.setZone(zone);
  const inClinic = instant.setZone(clinicZone);

  return {
    viewerTime: inViewer.toFormat('HH:mm'),
    clinicTime: inClinic.toFormat('HH:mm'),
    // Compares the rendered OFFSET, not the zone identifier. A patient in Europe/London
    // and a clinic in Europe/Lisbon are the same clock most of the year but not all of
    // it, so comparing identifiers would nag about a difference that is not visible,
    // and comparing them only sometimes is exactly the DST-aware behaviour wanted.
    zonesDiffer: inViewer.offset !== inClinic.offset,
    clinicZone,
    viewerZoneName: zone,
    machineReadable: instant.toISO() ?? isoInstant,
  };
}

/** Day heading, in the viewer's zone. */
export function formatDayHeading(
  isoInstant: string,
  viewerZoneOverride?: string,
): string {
  return DateTime.fromISO(isoInstant, { zone: 'utc' })
    .setZone(viewerZone(viewerZoneOverride))
    .toFormat('cccc d LLLL');
}

/**
 * Group slots into days AS THE VIEWER SEES THEM.
 *
 * Grouping by the viewer's day rather than the clinic's is deliberate: a patient in Tokyo
 * booking with a Lisbon clinic should see slots under the date on their own calendar,
 * because that is the date they will write down. The clinic's date is still available per
 * slot via `clinicTime` when it matters.
 */
export function groupByViewerDay<T extends { startsAt: string }>(
  slots: readonly T[],
  viewerZoneOverride?: string,
): { day: string; label: string; slots: T[] }[] {
  const zone = viewerZone(viewerZoneOverride);
  const groups = new Map<string, T[]>();

  for (const slot of slots) {
    const day =
      DateTime.fromISO(slot.startsAt, { zone: 'utc' }).setZone(zone).toISODate() ?? '';
    const bucket = groups.get(day);
    if (bucket) bucket.push(slot);
    else groups.set(day, [slot]);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, daySlots]) => ({
      day,
      label: DateTime.fromISO(day, { zone }).toFormat('cccc d LLLL') || day,
      slots: daySlots,
    }));
}

/** The next N days from a starting instant, as an ISO range for the API. */
export function weekRange(from: Date, days = 7): { from: string; to: string } {
  const start = DateTime.fromJSDate(from).toUTC().startOf('day');
  return {
    from: start.toISO() ?? '',
    to: start.plus({ days }).toISO() ?? '',
  };
}

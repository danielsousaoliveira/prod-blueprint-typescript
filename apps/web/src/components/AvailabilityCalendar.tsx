import { useState } from 'react';
import type { ApiError, Slot } from '../api/client';
import { formatSlot, groupByViewerDay } from '../lib/time';

/**
 * Week view of a doctor's bookable slots.
 *
 * ACCESSIBILITY IS LOAD-BEARING HERE, not a nicety. Phase 8's Playwright suite is only
 * permitted `getByRole` and `getByLabel` locators — never CSS selectors — so any control
 * without an accessible name is a control the e2e tests cannot reach. Writing the markup
 * this way is what makes that constraint satisfiable rather than a fight later.
 *
 * It also means the tests break when the ACCESSIBLE name changes rather than when a
 * class name changes, which is the more meaningful signal: a renamed class is a
 * refactor, a renamed button is a user-visible change.
 */

export interface AvailabilityCalendarProps {
  readonly slots: readonly Slot[];
  readonly clinicZone: string;
  readonly onBook: (slot: Slot) => void;
  readonly pendingSlot?: string | null;
  readonly error?: ApiError | null;
  /** Test seam so rendering is not dependent on the machine's timezone. */
  readonly viewerZone?: string;
}

export function AvailabilityCalendar({
  slots,
  clinicZone,
  onBook,
  pendingSlot,
  error,
  viewerZone,
}: AvailabilityCalendarProps) {
  const days = groupByViewerDay(slots, viewerZone);

  // Whether the viewer is in a different zone from the clinic is decided ONCE from the
  // first slot, not per slot, so the banner does not flicker across a DST boundary
  // mid-week. Individual slots still render their own clinic time.
  const sample = slots[0] ? formatSlot(slots[0].startsAt, clinicZone, viewerZone) : null;

  return (
    <section
      aria-labelledby="availability-heading"
      className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
    >
      <h2
        id="availability-heading"
        className="text-lg font-semibold tracking-tight text-slate-900"
      >
        Available appointments
      </h2>

      {sample?.zonesDiffer && (
        // Told once, prominently, rather than relying on the user noticing two times on
        // every slot. This is the single most common source of a missed appointment.
        <p
          role="status"
          className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600"
        >
          Times are shown in your timezone ({sample.viewerZoneName}). The clinic is in{' '}
          {clinicZone}.
        </p>
      )}

      {error && (
        // `role="alert"` so a screen reader announces the conflict immediately — losing a
        // slot is exactly the case where silent failure is unacceptable.
        <p
          role="alert"
          className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {error.isSlotConflict
            ? 'That slot was just taken. Here are the times still available.'
            : error.problem.title}
        </p>
      )}

      {days.length === 0 && (
        <p className="mt-4 text-sm text-slate-500">
          No appointments available in this week.
        </p>
      )}

      {days.map((day) => (
        <div key={day.day} className="mt-5">
          <h3 className="text-sm font-medium text-slate-500">{day.label}</h3>
          {/* A list, so assistive tech announces how many slots there are. */}
          <ul
            aria-label={`Available times on ${day.label}`}
            className="mt-2 flex flex-wrap gap-2"
          >
            {day.slots.map((slot) => {
              const formatted = formatSlot(slot.startsAt, clinicZone, viewerZone);
              const isPending = pendingSlot === slot.startsAt;

              return (
                <li key={slot.startsAt}>
                  <button
                    type="button"
                    onClick={() => onBook(slot)}
                    disabled={isPending}
                    // The accessible name carries BOTH times when they differ, so the
                    // information is available to a screen-reader user who never sees the
                    // visual secondary label.
                    aria-label={
                      formatted.zonesDiffer
                        ? `Book ${formatted.viewerTime} on ${day.label} (${formatted.clinicTime} clinic time)`
                        : `Book ${formatted.viewerTime} on ${day.label}`
                    }
                    className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-800 transition hover:border-slate-900 hover:bg-slate-900 hover:text-white disabled:opacity-50 disabled:hover:bg-white disabled:hover:text-slate-800"
                  >
                    <time dateTime={formatted.machineReadable}>
                      {formatted.viewerTime}
                    </time>
                    {formatted.zonesDiffer && (
                      <span className="text-xs opacity-70">
                        {' '}
                        ({formatted.clinicTime} clinic time)
                      </span>
                    )}
                    {isPending && <span> — booking…</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

/**
 * Booking flow wrapper: confirm, then submit.
 *
 * A confirmation step rather than booking on the first click. Booking is not trivially
 * reversible — it notifies a doctor — and a mis-tap on a phone should not create an
 * appointment someone has to cancel.
 */
export interface BookingFlowProps {
  readonly slots: readonly Slot[];
  readonly clinicZone: string;
  readonly onConfirm: (slot: Slot) => void;
  readonly isPending: boolean;
  readonly error?: ApiError | null;
  readonly viewerZone?: string;
  /**
   * Increments on each successful booking.
   *
   * The dialog dismisses itself when this changes. A counter rather than a boolean
   * because two successive bookings both need to close it, and a boolean that is already
   * `true` produces no change for the effect to react to.
   *
   * Found by driving the real UI in a browser: the booking succeeded and the slot
   * vanished from the list, but the confirmation dialog stayed open over it — none of
   * the component tests caught it, because each one only ever booked once and never
   * observed the success transition.
   */
  readonly successCount?: number;
}

export function BookingFlow({
  slots,
  clinicZone,
  onConfirm,
  isPending,
  error,
  viewerZone,
  successCount = 0,
}: BookingFlowProps) {
  const [selected, setSelected] = useState<Slot | null>(null);
  const [lastSuccess, setLastSuccess] = useState(successCount);

  // Derived-state-during-render rather than an effect. An effect would render the stale
  // dialog once before closing it, producing a visible flash; this closes it in the same
  // commit as the update that reports success.
  if (successCount !== lastSuccess) {
    setLastSuccess(successCount);
    if (selected) setSelected(null);
  }

  return (
    <>
      <AvailabilityCalendar
        slots={slots}
        clinicZone={clinicZone}
        onBook={setSelected}
        pendingSlot={isPending && selected ? selected.startsAt : null}
        error={error ?? null}
        {...(viewerZone ? { viewerZone } : {})}
      />

      {selected && (
        // A real dialog role with a label, so it is announced and reachable by
        // `getByRole('dialog')` rather than by a class name.
        /*
         * STYLED AS A MODAL, STILL CONDITIONALLY MOUNTED.
         *
         * The overlay below is rendered only when `selected` is set, exactly as before.
         * The tempting refactor — always render it and toggle `opacity-0` for a fade —
         * would break `expect(dialog).toBeHidden()` in the e2e suite, because Playwright
         * considers an opacity-0 element visible. It would also leave a focus-trappable
         * dialog in the DOM permanently, which is an accessibility regression as well as
         * a test failure.
         */
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-heading"
            className="w-full max-w-sm rounded-lg bg-white p-6 shadow-xl"
          >
            <h2
              id="confirm-heading"
              className="text-lg font-semibold tracking-tight text-slate-900"
            >
              Confirm your appointment
            </h2>
            <ConfirmationDetails
              slot={selected}
              clinicZone={clinicZone}
              {...(viewerZone ? { viewerZone } : {})}
            />
            <div className="mt-6 flex gap-2">
              <button
                type="button"
                onClick={() => onConfirm(selected)}
                disabled={isPending}
                className="flex-1 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
              >
                {isPending ? 'Requesting…' : 'Confirm booking'}
              </button>
              <button
                type="button"
                onClick={() => setSelected(null)}
                disabled={isPending}
                className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
              >
                Back
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ConfirmationDetails({
  slot,
  clinicZone,
  viewerZone,
}: {
  slot: Slot;
  clinicZone: string;
  viewerZone?: string;
}) {
  const formatted = formatSlot(slot.startsAt, clinicZone, viewerZone);

  return (
    <dl className="mt-4 space-y-2 text-sm">
      <dt className="text-slate-500">Your time</dt>
      <dd className="font-medium text-slate-900">
        <time dateTime={formatted.machineReadable}>{formatted.viewerTime}</time> (
        {formatted.viewerZoneName})
      </dd>
      {formatted.zonesDiffer && (
        <>
          <dt className="text-slate-500">Clinic time</dt>
          <dd className="font-medium text-slate-900">
            {formatted.clinicTime} ({clinicZone})
          </dd>
        </>
      )}
    </dl>
  );
}

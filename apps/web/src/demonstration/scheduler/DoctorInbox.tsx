import { useState } from 'react';
import type { Appointment, Slot } from '../api/client';
import { formatSlot } from '../lib/time';

/**
 * The doctor's inbox: pending requests, with accept / decline / propose-a-new-time.
 *
 * Mirrors the state machine exactly — the available actions are derived from the
 * appointment's status rather than hardcoded per section, so a status the UI does not
 * know about renders no actions instead of rendering ones the server will reject.
 */

export interface DoctorInboxProps {
  readonly appointments: readonly Appointment[];
  readonly clinicZone: string;
  readonly onAccept: (id: string) => void;
  readonly onDecline: (id: string) => void;
  readonly onPropose: (id: string, slot: Slot) => void;
  readonly pendingId?: string | null;
  readonly viewerZone?: string;
}

export function DoctorInbox({
  appointments,
  clinicZone,
  onAccept,
  onDecline,
  onPropose,
  pendingId,
  viewerZone,
}: DoctorInboxProps) {
  const pending = appointments.filter((a) => a.status === 'REQUESTED');
  const awaitingPatient = appointments.filter((a) => a.status === 'COUNTER_PROPOSED');
  const confirmed = appointments.filter((a) => a.status === 'CONFIRMED');

  return (
    <section
      aria-labelledby="inbox-heading"
      className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
    >
      <h2
        id="inbox-heading"
        className="text-lg font-semibold tracking-tight text-slate-900"
      >
        Appointment requests
      </h2>

      <section aria-labelledby="pending-heading">
        <h3 id="pending-heading" className="mt-5 text-sm font-medium text-slate-500">
          Awaiting your response ({pending.length})
        </h3>
        {pending.length === 0 && (
          <p className="mt-2 text-sm text-slate-500">No new requests.</p>
        )}
        <ul aria-label="Pending requests" className="mt-2 divide-y divide-slate-100">
          {pending.map((appointment) => (
            <li key={appointment.id} className="py-3">
              <RequestRow
                appointment={appointment}
                clinicZone={clinicZone}
                {...(viewerZone ? { viewerZone } : {})}
              />
              <RequestActions
                appointment={appointment}
                clinicZone={clinicZone}
                onAccept={onAccept}
                onDecline={onDecline}
                onPropose={onPropose}
                isPending={pendingId === appointment.id}
                {...(viewerZone ? { viewerZone } : {})}
              />
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="awaiting-heading">
        <h3 id="awaiting-heading" className="mt-5 text-sm font-medium text-slate-500">
          Awaiting patient ({awaitingPatient.length})
        </h3>
        <ul
          aria-label="Awaiting patient response"
          className="mt-2 divide-y divide-slate-100"
        >
          {awaitingPatient.map((appointment) => (
            <li key={appointment.id} className="py-3">
              <RequestRow
                appointment={appointment}
                clinicZone={clinicZone}
                {...(viewerZone ? { viewerZone } : {})}
              />
              {appointment.proposedStartsAt && (
                <p>
                  You proposed{' '}
                  <time
                    dateTime={
                      formatSlot(appointment.proposedStartsAt, clinicZone, viewerZone)
                        .machineReadable
                    }
                  >
                    {
                      formatSlot(appointment.proposedStartsAt, clinicZone, viewerZone)
                        .viewerTime
                    }
                  </time>
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="confirmed-heading">
        <h3 id="confirmed-heading" className="mt-5 text-sm font-medium text-slate-500">
          Confirmed ({confirmed.length})
        </h3>
        <ul
          aria-label="Confirmed appointments"
          className="mt-2 divide-y divide-slate-100"
        >
          {confirmed.map((appointment) => (
            <li key={appointment.id} className="py-3">
              <RequestRow
                appointment={appointment}
                clinicZone={clinicZone}
                {...(viewerZone ? { viewerZone } : {})}
              />
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}

function RequestRow({
  appointment,
  clinicZone,
  viewerZone,
}: {
  appointment: Appointment;
  clinicZone: string;
  viewerZone?: string;
}) {
  const formatted = formatSlot(appointment.startsAt, clinicZone, viewerZone);

  return (
    // A <p> holding spans, so any flex layout has to go here rather than on a wrapper —
    // adding one would change the DOM shape the component tests assert on.
    <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-slate-800">
      <span className="font-medium">Patient {appointment.patientId}</span>{' '}
      <time dateTime={formatted.machineReadable}>{formatted.viewerTime}</time>
      {formatted.zonesDiffer && (
        <span className="text-xs text-slate-500">
          {' '}
          ({formatted.clinicTime} clinic time)
        </span>
      )}
    </p>
  );
}

function RequestActions({
  appointment,
  clinicZone,
  onAccept,
  onDecline,
  onPropose,
  isPending,
  viewerZone,
}: {
  appointment: Appointment;
  clinicZone: string;
  onAccept: (id: string) => void;
  onDecline: (id: string) => void;
  onPropose: (id: string, slot: Slot) => void;
  isPending: boolean;
  viewerZone?: string;
}) {
  const [proposing, setProposing] = useState(false);
  const [proposedTime, setProposedTime] = useState('');

  const formatted = formatSlot(appointment.startsAt, clinicZone, viewerZone);
  // Each button's accessible name includes the time, so a page with several requests has
  // no ambiguous "Accept" — both for screen readers and for Playwright's strict-mode
  // locators, which fail loudly on a name that matches more than one element.
  const context = `${formatted.viewerTime} request from patient ${appointment.patientId}`;

  const actionClass =
    'rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50';

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      <button
        type="button"
        onClick={() => onAccept(appointment.id)}
        disabled={isPending}
        aria-label={`Accept ${context}`}
        className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
      >
        Accept
      </button>
      <button
        type="button"
        onClick={() => onDecline(appointment.id)}
        disabled={isPending}
        aria-label={`Decline ${context}`}
        className={actionClass}
      >
        Decline
      </button>
      <button
        type="button"
        onClick={() => setProposing((open) => !open)}
        disabled={isPending}
        aria-label={`Propose a new time for ${context}`}
        aria-expanded={proposing}
        className={actionClass}
      >
        Propose new time
      </button>

      {proposing && (
        <form
          className="mt-2 w-full"
          onSubmit={(event) => {
            event.preventDefault();
            if (!proposedTime) return;
            const start = new Date(proposedTime);
            onPropose(appointment.id, {
              startsAt: start.toISOString(),
              // Same 30-minute duration as the original request. The server rejects
              // anything off the slot grid anyway, so the client does not duplicate that
              // rule — it just does not invent a different one.
              endsAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
            });
            setProposing(false);
          }}
        >
          {/* A real label element, so getByLabel finds it. */}
          <label
            htmlFor={`proposed-time-${appointment.id}`}
            className="block text-xs font-medium text-slate-600"
          >
            New time (your timezone)
          </label>
          <input
            id={`proposed-time-${appointment.id}`}
            type="datetime-local"
            value={proposedTime}
            onChange={(event) => setProposedTime(event.target.value)}
            required
            className="mt-1 rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-900 outline-none focus:border-slate-900"
          />
          <button
            type="submit"
            disabled={isPending}
            className="ml-2 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
          >
            Send proposal
          </button>
        </form>
      )}
    </div>
  );
}

/**
 * The patient's side of a counter-proposal.
 *
 * Shows BOTH the original request and the doctor's alternative. Showing only the proposal
 * would leave the patient unable to remember what they asked for, which matters when the
 * two are close together.
 */
export interface PatientProposalsProps {
  readonly appointments: readonly Appointment[];
  readonly clinicZone: string;
  readonly onAccept: (id: string) => void;
  readonly onDecline: (id: string) => void;
  readonly pendingId?: string | null;
  readonly viewerZone?: string;
}

export function PatientProposals({
  appointments,
  clinicZone,
  onAccept,
  onDecline,
  pendingId,
  viewerZone,
}: PatientProposalsProps) {
  const proposals = appointments.filter((a) => a.status === 'COUNTER_PROPOSED');

  if (proposals.length === 0) return null;

  return (
    // Still returns null when there are no proposals (above) — no unconditional wrapper,
    // because a component test asserts the container is empty in that case.
    <section
      aria-labelledby="proposals-heading"
      className="rounded-lg border border-amber-200 bg-amber-50 p-5"
    >
      <h2
        id="proposals-heading"
        className="text-lg font-semibold tracking-tight text-amber-900"
      >
        The doctor proposed a different time
      </h2>
      <ul aria-label="Proposed alternative times" className="mt-3 space-y-3">
        {proposals.map((appointment) => {
          const requested = formatSlot(
            appointment.requestedStartsAt,
            clinicZone,
            viewerZone,
          );
          const proposed = appointment.proposedStartsAt
            ? formatSlot(appointment.proposedStartsAt, clinicZone, viewerZone)
            : null;

          return (
            <li key={appointment.id}>
              <p className="text-sm text-amber-900">
                You asked for{' '}
                <time dateTime={requested.machineReadable}>{requested.viewerTime}</time>.
                {proposed && (
                  <>
                    {' '}
                    The doctor proposed{' '}
                    <time dateTime={proposed.machineReadable}>{proposed.viewerTime}</time>
                    {proposed.zonesDiffer && ` (${proposed.clinicTime} clinic time)`}.
                  </>
                )}
              </p>
              <button
                type="button"
                onClick={() => onAccept(appointment.id)}
                disabled={pendingId === appointment.id}
                aria-label={`Accept the proposed time of ${proposed?.viewerTime ?? 'the appointment'}`}
                className="mt-2 rounded-md bg-amber-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-amber-800 disabled:opacity-50"
              >
                Accept new time
              </button>
              <button
                type="button"
                onClick={() => onDecline(appointment.id)}
                disabled={pendingId === appointment.id}
                aria-label={`Decline the proposed time of ${proposed?.viewerTime ?? 'the appointment'}`}
                className="mt-2 ml-2 rounded-md border border-amber-300 px-3 py-1.5 text-sm font-medium text-amber-900 transition hover:bg-amber-100 disabled:opacity-50"
              >
                Decline
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

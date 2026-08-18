import { useState } from 'react';
import { ApiError } from './api/client';
import {
  useAcceptAppointment,
  useCalendar,
  useDeclineAppointment,
  useLogout,
  usePatientAcceptProposal,
  usePatientDeclineProposal,
  useProposeNewTime,
  useRequestAppointment,
  useSession,
} from './api/hooks';
import { BookingFlow } from './components/AvailabilityCalendar';
import { DoctorInbox, PatientProposals } from './components/DoctorInbox';
import { LoginPage } from './components/LoginPage';
import { weekRange } from './lib/time';

/**
 * The app shell.
 *
 * ============================================================================
 * THE TAB TOGGLE IS GONE, AND ITS REMOVAL IS THE POINT
 * ============================================================================
 *
 * Until Phase 10 this rendered a tablist letting anyone switch between the patient view
 * and the doctor inbox, because identity came from a query parameter and "who you are"
 * was a client-side preference.
 *
 * With real sessions, one browser session is one identity. A patient cannot look at a
 * doctor's inbox — not because the UI hides the button, but because the API would refuse
 * every request it made. Keeping the toggle would mean rendering a view the server
 * answers with 403s: worse than not offering it, because it looks like a bug rather than
 * a boundary.
 *
 * So the session decides. This is the standard shape of the change when authentication is
 * added to something built without it: view-switching becomes identity, and any UI that
 * assumed the user could be either party has to pick one.
 * ============================================================================
 */
export function App() {
  const session = useSession();

  if (session.isPending) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <p role="status" className="text-slate-500">
          Loading…
        </p>
      </main>
    );
  }

  // No session, or the query failed because we are signed out. Either way: sign in.
  if (!session.data) return <LoginPage />;

  return <Scheduler role={session.data.role} profileId={session.data.profileId} />;
}

function Scheduler({
  role,
  profileId,
}: {
  role: 'doctor' | 'patient';
  profileId: string;
}) {
  // A monotonic counter, not a boolean: two successive bookings must BOTH dismiss the
  // dialog, and a flag that is already true produces no change to react to.
  const [bookingSuccesses, setBookingSuccesses] = useState(0);
  const range = weekRange(new Date());

  /**
   * Which doctor's calendar to show.
   *
   * A doctor sees their own. A patient needs to choose one, and there is no doctor
   * directory in this project — so the query parameter survives for THIS purpose only.
   * That is a genuine client decision (which doctor do I want to see?), not an identity
   * claim, which is exactly the distinction Phase 10 is drawing: `?doctorId=` choosing
   * whose availability to browse is fine; `?patientId=` choosing who you are was not.
   */
  const [doctorId] = useState(
    () =>
      (role === 'doctor'
        ? profileId
        : new URLSearchParams(window.location.search).get('doctorId')) ?? 'doctor-1',
  );

  const calendar = useCalendar(doctorId, range);
  const logout = useLogout();

  const requestAppointment = useRequestAppointment();
  const accept = useAcceptAppointment();
  const decline = useDeclineAppointment();
  const propose = useProposeNewTime();
  const patientAccept = usePatientAcceptProposal();
  const patientDecline = usePatientDeclineProposal();

  const clinicZone = calendar.data?.availabilityFor?.timezone ?? 'UTC';
  const appointments = calendar.data?.appointments ?? [];

  const bookingError =
    requestAppointment.error instanceof ApiError ? requestAppointment.error : null;

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
      <header className="mb-8 flex flex-wrap items-baseline justify-between gap-3 border-b border-slate-200 pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Appointment scheduler
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Signed in as {role} · {profileId}
          </p>
        </div>
        <button
          type="button"
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
        >
          {logout.isPending ? 'Signing out…' : 'Sign out'}
        </button>
      </header>

      {calendar.isPending && (
        <p role="status" className="text-slate-500">
          Loading availability…
        </p>
      )}

      {calendar.isError && (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          Could not load availability.{' '}
          <button
            type="button"
            onClick={() => void calendar.refetch()}
            className="font-medium underline underline-offset-2"
          >
            Try again
          </button>
        </p>
      )}

      {calendar.data && role === 'patient' && (
        <div className="space-y-8">
          <PatientProposals
            // No client-side filter by patient id any more: the server returns only this
            // patient's appointments, so filtering here would be re-implementing a rule
            // the API already enforces — and doing it in the one place it cannot matter.
            appointments={appointments}
            clinicZone={clinicZone}
            onAccept={(id) => patientAccept.mutate(id)}
            onDecline={(id) => patientDecline.mutate(id)}
            pendingId={
              patientAccept.isPending || patientDecline.isPending
                ? (patientAccept.variables ?? patientDecline.variables ?? null)
                : null
            }
          />

          <BookingFlow
            slots={calendar.data.availabilityFor?.slots ?? []}
            clinicZone={clinicZone}
            isPending={requestAppointment.isPending}
            error={bookingError}
            // Incremented only on a real server confirmation, so the dialog closes when
            // the booking actually succeeded — not when the request was sent, and not on
            // a 409 where the user needs to stay and pick another slot.
            successCount={bookingSuccesses}
            onConfirm={(slot) =>
              requestAppointment.mutate(
                {
                  doctorId,
                  // No patientId: the server takes it from the session.
                  startsAt: slot.startsAt,
                  endsAt: slot.endsAt,
                },
                { onSuccess: () => setBookingSuccesses((count) => count + 1) },
              )
            }
          />
        </div>
      )}

      {calendar.data && role === 'doctor' && (
        <DoctorInbox
          appointments={appointments}
          clinicZone={clinicZone}
          onAccept={(id) => accept.mutate(id)}
          onDecline={(id) => decline.mutate(id)}
          onPropose={(id, slot) => propose.mutate({ id, slot })}
          pendingId={
            accept.isPending
              ? (accept.variables ?? null)
              : decline.isPending
                ? (decline.variables ?? null)
                : propose.isPending
                  ? (propose.variables?.id ?? null)
                  : null
          }
        />
      )}
    </main>
  );
}

import { useState } from 'react';
import { ApiError } from '../../starter/api/client';
import { useSession } from '../../starter/api/hooks';
import {
  useAcceptAppointment,
  useCalendar,
  useDeclineAppointment,
  usePatientAcceptProposal,
  usePatientDeclineProposal,
  useProposeNewTime,
  useRequestAppointment,
} from '../api/hooks';
import { weekRange } from '../lib/time';
import { BookingFlow } from './AvailabilityCalendar';
import { DoctorInbox, PatientProposals } from './DoctorInbox';

/**
 * The example doctor-scheduling screen — booking calendar for a patient, request inbox
 * for a doctor, chosen by the signed-in session's role.
 *
 * ============================================================================
 * THE TAB TOGGLE IS GONE, AND ITS REMOVAL IS THE POINT
 * ============================================================================
 *
 * This used to render a tablist letting anyone switch between the patient view and the
 * doctor inbox, because identity came from a query parameter and "who you are" was a
 * client-side preference.
 *
 * With real sessions, one browser session is one identity. A patient cannot look at a
 * doctor's inbox — not because the UI hides the button, but because the API would refuse
 * every request it made. So the session decides.
 * ============================================================================
 */
export function SchedulerPage() {
  const session = useSession();
  if (!session.data) return null;
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
   * claim: `?doctorId=` choosing whose availability to browse is fine; choosing who you
   * are is not.
   */
  const [doctorId] = useState(
    () =>
      (role === 'doctor'
        ? profileId
        : new URLSearchParams(window.location.search).get('doctorId')) ?? 'doctor-1',
  );

  const calendar = useCalendar(doctorId, range);

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
    <div>
      <p className="mb-6 text-sm text-slate-500">
        Signed in as {role} · {profileId}
      </p>

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
    </div>
  );
}

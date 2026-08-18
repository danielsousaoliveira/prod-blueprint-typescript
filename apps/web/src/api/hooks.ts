import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type Appointment,
  type Slot,
  acceptAppointment,
  cancelAppointment,
  declineAppointment,
  fetchCalendar,
  listAppointments,
  login,
  logout,
  fetchSession,
  patientAcceptProposal,
  patientDeclineProposal,
  proposeNewTime,
  requestAppointment,
} from './client';

/**
 * Query keys as a single structured object.
 *
 * Hand-written string keys drift — one component invalidates `['calendar']` while another
 * queried `['calendar', doctorId]`, and the invalidation silently matches nothing. A
 * factory means every key has exactly one definition, and the hierarchy is what lets
 * `invalidateQueries({ queryKey: keys.calendar.all })` clear every window at once, which
 * mirrors the server's per-doctor cache invalidation.
 */
export const keys = {
  calendar: {
    all: ['calendar'] as const,
    forDoctor: (doctorId: string, from: string, to: string) =>
      ['calendar', doctorId, from, to] as const,
  },
  appointments: {
    all: ['appointments'] as const,
    // No id in the key: the server scopes the list to the session, so there is only ever
    // one list per signed-in user. Keying by an id the client supplied would suggest a
    // filter that no longer exists.
    mine: ['appointments', 'mine'] as const,
  },
  session: ['session'] as const,
};

/**
 * How often to poll for updates.
 *
 * POLLING, not the GraphQL subscription — a deliberate reversal of the obvious choice,
 * for the reason documented in design rationale. Cloud Run bills for connection duration,
 * caps request timeout and has no session affinity by default, and the in-process PubSub
 * does not fan out across instances anyway. A doctor's inbox tolerates ten seconds of
 * latency perfectly well; an appointment request is not a chat message.
 *
 * The subscription exists in the API and works. Choosing not to use it from the browser
 * is a deployment decision, not an admission that it is broken.
 */
const POLL_INTERVAL_MS = 10_000;

export function useCalendar(doctorId: string, range: { from: string; to: string }) {
  return useQuery({
    queryKey: keys.calendar.forDoctor(doctorId, range.from, range.to),
    queryFn: () => fetchCalendar(doctorId, range),
    // Availability changes when anyone books, so a cached value is stale almost
    // immediately. Short staleTime plus polling keeps it honest without hammering.
    staleTime: 5_000,
    refetchInterval: POLL_INTERVAL_MS,
    // Someone returning to the tab after lunch should not see a stale calendar.
    refetchOnWindowFocus: true,
  });
}

/** The signed-in user's appointments, whichever party they are. */
export function useMyAppointments() {
  return useQuery({
    queryKey: keys.appointments.mine,
    queryFn: () => listAppointments(),
    refetchInterval: POLL_INTERVAL_MS,
  });
}

/**
 * Who am I?
 *
 * `retry: false` because a 401 here is an ANSWER, not a failure — it means "signed out",
 * and retrying it three times just delays the login screen.
 */
export function useSession() {
  return useQuery({
    queryKey: keys.session,
    queryFn: fetchSession,
    retry: false,
    staleTime: Infinity,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      login(input.email, input.password),
    onSuccess: (session) => {
      // Seed the cache directly rather than invalidating: the login response already IS
      // the session, so refetching it would be a second round trip for data in hand.
      queryClient.setQueryData(keys.session, session);
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: logout,
    onSuccess: () => {
      /**
       * ============================================================================
       * ORDER MATTERS, AND `queryClient.clear()` IS THE WRONG TOOL HERE
       * ============================================================================
       *
       * The obvious implementation is `queryClient.clear()` — wipe everything, the user
       * is gone. It empties the cache correctly, and the UI does not update at all.
       *
       * `clear()` DESTROYS the query objects that mounted observers are bound to. The
       * `useSession` observer in `App` is left holding a destroyed query: it neither
       * refetches nor resets, and keeps reporting the last data it saw. A subsequent
       * `setQueryData` then creates a BRAND NEW query that nothing is observing, so it
       * notifies nobody.
       *
       * The symptom was a logout that worked perfectly on the server — cookie cleared,
       * session destroyed, every later request 401 — while the browser carried on
       * rendering the signed-in shell full of "could not load availability" errors. The
       * user is signed out and the app will not admit it. Nothing throws, and the network
       * tab looks exactly right, which is what made it slow to find.
       *
       * So: write the session value FIRST, through the live query the observer is
       * actually watching. That notifies it and re-renders straight to the login page.
       * Then drop the data caches, whose observers have unmounted by then.
       * ============================================================================
       */
      queryClient.setQueryData(keys.session, null);

      // Everything cached belongs to the user who just signed out. Leaving their
      // appointments in memory for whoever signs in next on this browser is a data leak,
      // and invalidation would serve the stale data once while refetching.
      queryClient.removeQueries({ queryKey: keys.calendar.all });
      queryClient.removeQueries({ queryKey: keys.appointments.all });
    },
  });
}

/**
 * Invalidate everything a write could have changed.
 *
 * Broad on purpose. A booking changes availability for that doctor, the doctor's list and
 * the patient's list, and being precise about which would mean encoding the server's
 * invalidation rules in the client — two places to keep in step. Over-invalidating costs
 * one refetch; under-invalidating shows stale data, which is the failure users notice.
 */
function useInvalidateAll() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.calendar.all }),
      queryClient.invalidateQueries({ queryKey: keys.appointments.all }),
    ]);
}

/**
 * Book a slot.
 *
 * NO optimistic update, deliberately. A booking can lose the race and return 409, and
 * rolling back an optimistic update means showing someone their appointment and then
 * taking it away — worse than a half-second pending state. Optimistic updates belong
 * where the server almost never rejects; this is the opposite case by design.
 */
export function useRequestAppointment() {
  const invalidate = useInvalidateAll();

  return useMutation({
    mutationFn: (input: { doctorId: string; startsAt: string; endsAt: string }) =>
      requestAppointment({
        ...input,
        // One key per attempt. A retry of the SAME attempt is deduplicated by the server;
        // a genuinely new booking gets a new key and is allowed through.
        idempotencyKey: crypto.randomUUID(),
      }),
    // Refetch on failure too: a 409 means someone else took the slot, so the calendar on
    // screen is already wrong and the user needs to see what is actually left.
    onSettled: invalidate,
  });
}

function useTransition<TArgs>(mutationFn: (args: TArgs) => Promise<Appointment>) {
  const invalidate = useInvalidateAll();
  return useMutation({ mutationFn, onSettled: invalidate });
}

export const useAcceptAppointment = () =>
  useTransition((id: string) => acceptAppointment(id));

export const useDeclineAppointment = () =>
  useTransition((id: string) => declineAppointment(id));

export const useProposeNewTime = () =>
  useTransition((args: { id: string; slot: Slot }) => proposeNewTime(args.id, args.slot));

export const usePatientAcceptProposal = () =>
  useTransition((id: string) => patientAcceptProposal(id));

export const usePatientDeclineProposal = () =>
  useTransition((id: string) => patientDeclineProposal(id));

export const useCancelAppointment = () =>
  useTransition((args: { id: string; reason?: string }) =>
    cancelAppointment(args.id, args.reason),
  );

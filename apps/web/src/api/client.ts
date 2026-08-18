/**
 * Two transports, one client, no GraphQL library.
 *
 * ============================================================================
 * WHY BOTH — AND WHY NO APOLLO
 * ============================================================================
 *
 * GraphQL for the CALENDAR read: it fetches availability, the doctor, and existing
 * appointments in one round trip, which is the documented design choice that makes GraphQL's
 * genuine win. REST for MUTATIONS: they need status codes (409 for a lost race) and the
 * `Idempotency-Key` header, both of which GraphQL flattens into a 200 with an errors array.
 *
 * Deliberately NO Apollo Client or urql. TanStack Query already provides caching,
 * deduplication, background refetch and invalidation; adding a GraphQL client means a
 * SECOND cache with its own invalidation rules, and keeping two caches consistent is a
 * real source of "why is this stale" bugs. A GraphQL query is a POST with a JSON body —
 * `fetch` handles it in ten lines.
 * ============================================================================
 */

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: { path: string; message: string }[];
}

/**
 * A failed request, carrying the parsed problem+json.
 *
 * `problem.type` is the stable identifier — the UI branches on it, never on the message,
 * because messages get reworded and a URI does not.
 */
export class ApiError extends Error {
  constructor(readonly problem: ProblemDetails) {
    super(problem.title);
    this.name = 'ApiError';
  }

  get isSlotConflict(): boolean {
    return (
      this.problem.type.includes('slot-taken') ||
      this.problem.type.includes('slot-unavailable') ||
      this.problem.type.includes('contended')
    );
  }
}

async function parseProblem(response: Response): Promise<ProblemDetails> {
  try {
    return (await response.json()) as ProblemDetails;
  } catch {
    // A non-JSON error body (a proxy 502, an HTML error page) must not crash the client
    // with a parse error that hides the real status.
    return {
      type: 'about:blank',
      title: response.statusText || 'Request failed',
      status: response.status,
    };
  }
}

/**
 * `credentials: 'include'` on every request.
 *
 * The session lives in an httpOnly cookie, which the browser attaches automatically —
 * but only if the request asks for it. `fetch`'s default is `same-origin`, which happens
 * to work here (the Vite proxy makes the API same-origin in development, and production
 * serves both behind one ingress) and would silently stop working the day the API moves
 * to its own hostname. Every request would then be a 401 with nothing in the code
 * indicating why.
 *
 * Being explicit costs nothing and states the intent: this client is cookie-authenticated.
 */
async function rest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...init.headers },
  });

  if (!response.ok) throw new ApiError(await parseProblem(response));
  if (response.status === 204) return undefined as T;

  /**
   * An empty 200 body is not an error.
   *
   * `GET /v1/auth/me` answers 200 with NO body for a signed-out caller — a Nest handler
   * returning `null` serialises to nothing at all. Calling `response.json()` on that
   * throws a `SyntaxError`, so "you are signed out" arrived at the UI as a failed query
   * rather than as an answer, and the difference between "no session" and "the network is
   * broken" was lost.
   *
   * Reading the text first and returning `undefined` for an empty one keeps the
   * distinction. It also makes every other 200-with-no-body endpoint safe by default,
   * rather than each one being a latent crash.
   */
  const text = await response.text();
  if (text.length === 0) return undefined as T;
  return JSON.parse(text) as T;
}

/**
 * GraphQL over plain fetch.
 *
 * Note the error handling: GraphQL returns HTTP 200 even for failures, so checking
 * `response.ok` is not enough — the `errors` array has to be inspected explicitly. That
 * is one of REST's advantages made concrete (documented design choice): every proxy and monitoring
 * tool in the path sees a successful request.
 */
export async function graphql<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch('/graphql', {
    method: 'POST',
    // Both transports build their headers independently, so both need this. Setting it in
    // only one is the kind of asymmetry that produces "reads work, writes 401".
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });

  const body = (await response.json()) as {
    data?: T;
    errors?: { message: string; extensions?: { code?: string } }[];
  };

  if (body.errors?.length) {
    const first = body.errors[0];
    throw new ApiError({
      // The resolver's error codes deliberately mirror the REST problem URIs, so the UI
      // branches on one vocabulary regardless of which transport produced the failure.
      type: `graphql/${first?.extensions?.code ?? 'UNKNOWN'}`,
      title: first?.message ?? 'GraphQL request failed',
      status: 400,
    });
  }

  if (!body.data)
    throw new ApiError({ type: 'about:blank', title: 'No data', status: 500 });
  return body.data;
}

// ---------------------------------------------------------------------------
// Types mirroring the API contract.
// ---------------------------------------------------------------------------

export type AppointmentStatus =
  'REQUESTED' | 'CONFIRMED' | 'COUNTER_PROPOSED' | 'DECLINED' | 'CANCELLED' | 'COMPLETED';

export interface Appointment {
  id: string;
  doctorId: string;
  patientId: string;
  status: AppointmentStatus;
  startsAt: string;
  endsAt: string;
  requestedStartsAt: string;
  requestedEndsAt: string;
  proposedStartsAt: string | null;
  proposedEndsAt: string | null;
  createdAt: string;
}

export interface Slot {
  startsAt: string;
  endsAt: string;
}

export interface Availability {
  doctorId: string;
  timezone: string;
  slots: Slot[];
}

// ---------------------------------------------------------------------------
// The calendar query — GraphQL, one round trip.
// ---------------------------------------------------------------------------

const CALENDAR_QUERY = `
  query Calendar($input: AvailabilityInputGql!) {
    availabilityFor(input: $input) {
      doctorId
      timezone
      slots { startsAt endsAt }
    }
    # No arguments: the server scopes this to the signed-in user. The doctorId argument
    # was removed from the schema, so passing one is now a validation error rather than a
    # silently-ignored filter.
    appointments {
      id
      status
      startsAt
      endsAt
      requestedStartsAt
      requestedEndsAt
      proposedStartsAt
      proposedEndsAt
      createdAt
      doctorId
      patientId
      doctor { id name specialty }
    }
  }
`;

export interface CalendarData {
  availabilityFor: Availability | null;
  appointments: (Appointment & {
    doctor: { id: string; name: string; specialty: string } | null;
  })[];
}

export function fetchCalendar(
  doctorId: string,
  range: { from: string; to: string },
): Promise<CalendarData> {
  // Availability AND appointments AND the doctor, in ONE request. In REST this is three
  // round trips or a bespoke `?expand=` parameter.
  return graphql<CalendarData>(CALENDAR_QUERY, {
    input: { doctorId, from: range.from, to: range.to },
  });
}

// ---------------------------------------------------------------------------
// Mutations — REST, for status codes and idempotency.
// ---------------------------------------------------------------------------

export function requestAppointment(input: {
  doctorId: string;
  startsAt: string;
  endsAt: string;
  idempotencyKey: string;
}): Promise<Appointment> {
  const { idempotencyKey, ...body } = input;
  return rest<Appointment>('/v1/appointments', {
    method: 'POST',
    // Generated per booking ATTEMPT, not per retry, so a network-level retry of the same
    // attempt is deduplicated while a genuinely new booking gets a new key.
    headers: { 'idempotency-key': idempotencyKey },
    body: JSON.stringify(body),
  });
}

const transition = (id: string, action: string, body?: unknown) =>
  rest<Appointment>(`/v1/appointments/${id}/${action}`, {
    method: 'POST',
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

export const acceptAppointment = (id: string) => transition(id, 'accept');
// `by` is no longer sent: the server derives it from the session, because a client that
// can write the audit trail can write whatever it likes into it.
export const declineAppointment = (id: string) => transition(id, 'decline');
export const proposeNewTime = (id: string, slot: Slot) => transition(id, 'propose', slot);
export const patientAcceptProposal = (id: string) => transition(id, 'patient-accept');
export const patientDeclineProposal = (id: string) => transition(id, 'patient-decline');
export const cancelAppointment = (id: string, reason?: string) =>
  transition(id, 'cancel', reason ? { reason } : {});

/**
 * The caller's appointments. No filter parameters, because the server scopes by session —
 * `doctorId`/`patientId` were removed from the endpoint entirely (they used to let anyone
 * read the whole database).
 */
export const listAppointments = () => rest<Appointment[]>('/v1/appointments');

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface SessionInfo {
  readonly role: 'doctor' | 'patient';
  readonly profileId: string;
}

export const login = (email: string, password: string) =>
  rest<SessionInfo>('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });

export const logout = () => rest<void>('/v1/auth/logout', { method: 'POST' });

/**
 * Returns `null` when signed out rather than throwing.
 *
 * `/v1/auth/me` is deliberately public and answers 200 with an empty body for an
 * anonymous caller, so "not signed in" is a normal answer rather than an error the client
 * has to special-case on first paint.
 */
export const fetchSession = async (): Promise<SessionInfo | null> => {
  const session = await rest<SessionInfo | undefined>('/v1/auth/me');
  // `?? null` rather than returning undefined: TanStack Query treats an `undefined`
  // resolution as "no data yet" and warns about it, so a signed-out user would leave the
  // query permanently pending. `null` is a value, and it means "signed out".
  return session && 'role' in session ? session : null;
};

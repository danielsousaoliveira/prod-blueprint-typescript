import DataLoader from 'dataloader';
import type {
  Doctor,
  DoctorRepository,
  Patient,
  PatientRepository,
} from '../doctors/domain/doctor.repository';

/**
 * Per-request DataLoaders.
 *
 * ============================================================================
 * WHAT PROBLEM THIS SOLVES — N+1
 * ============================================================================
 *
 * GraphQL resolvers run per field, per object. A query for 50 appointments that also asks
 * for `doctor { name }` calls the doctor resolver 50 times, once per appointment. Naively
 * that is 50 database round trips on top of the 1 that fetched the appointments — the
 * "+1" and the "N".
 *
 * The problem is structural, not a coding mistake: each resolver only sees ITS OWN parent
 * object, so no individual resolver can know that 49 others are about to ask for
 * something similar.
 *
 * DataLoader fixes it by deferring. Every `.load(id)` call within one tick of the event
 * loop is collected into a batch, and once the tick drains, the batch function is called
 * ONCE with all the accumulated ids. Fifty `.load()` calls become one `$in` query. The
 * resolvers are unchanged and still look like they fetch one record each.
 *
 * ============================================================================
 * WHY THIS IS CREATED PER REQUEST — AND WHY A GLOBAL LOADER IS A SECURITY BUG
 * ============================================================================
 *
 * DataLoader has a memoisation cache as well as a batching queue. That cache is what makes
 * the per-request lifetime mandatory rather than a stylistic preference.
 *
 * A loader created once at module scope and shared across requests would cache a doctor
 * or patient record loaded during ONE user's request and serve it from cache during
 * ANOTHER user's request. The consequences:
 *
 *   1. **Data leak.** Once field-level authorisation exists, whether a record is visible
 *      depends on WHO is asking. A cached value skips the resolver that would have
 *      checked, so user B receives data that was authorised for user A. This is the
 *      failure that matters, and it is silent — no error, correct-looking response.
 *   2. **Unbounded memory.** A process-lifetime cache with no eviction is a leak.
 *   3. **Permanent staleness.** A record updated after being cached is never re-read, so
 *      the API serves stale data until the process restarts.
 *
 * The cache is scoped to the request precisely because a request is the unit of
 * authorisation. Getting this wrong looks like a performance win and is a disclosure bug,
 * which is why it gets this much comment.
 * ============================================================================
 */
export interface Loaders {
  readonly doctor: DataLoader<string, Doctor | null>;
  readonly patient: DataLoader<string, Patient | null>;
}

/**
 * Called once per request. Never memoise the result of this function.
 */
export function createLoaders(
  doctors: DoctorRepository,
  patients: PatientRepository,
): Loaders {
  return {
    doctor: new DataLoader<string, Doctor | null>(async (ids) => {
      const found = await doctors.findByIds(ids);
      // DataLoader REQUIRES the returned array to align exactly with the input ids —
      // same length, same order. A missing record must become `null` in its position
      // rather than being omitted, or every subsequent result shifts by one and each
      // appointment gets the wrong doctor. Mapping over the input ids (rather than over
      // the query results) makes that alignment structural.
      return ids.map((id) => found.get(id) ?? null);
    }),

    patient: new DataLoader<string, Patient | null>(async (ids) => {
      const found = await patients.findByIds(ids);
      return ids.map((id) => found.get(id) ?? null);
    }),
  };
}

/** Shape of the per-request GraphQL context. */
export interface GraphQLContext {
  readonly loaders: Loaders;
  /**
   * The underlying HTTP request, so the global `AuthGuard` and `@CurrentActor()` can
   * reach it during a GraphQL operation. `unknown` rather than Express's `Request`
   * because this file is shared with the subscription path, where there is no Express
   * request at all — the consumers narrow it.
   */
  readonly req?: unknown;
}

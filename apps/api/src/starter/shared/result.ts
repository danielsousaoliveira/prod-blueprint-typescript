/**
 * A Result type, so the domain layer can report failure without throwing.
 *
 * Domain rule violations ("you cannot complete an appointment that was declined") are
 * expected outcomes, not exceptions. Modelling them as values means the compiler forces
 * every caller to handle them — an unhandled `err` is a type error, whereas an unhandled
 * `throw` is a 500 discovered in production.
 *
 * Exceptions stay reserved for genuine programmer error and infrastructure failure.
 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

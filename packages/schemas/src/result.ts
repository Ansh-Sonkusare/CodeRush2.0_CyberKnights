/**
 * Result<T, E> — returned across every package boundary instead of throwing.
 *
 * Use ok() and err() helpers to construct results.
 * Never use `as Result<T,E>` — construct with helpers.
 */

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** Unwrap or throw — only use at top-level boundaries (e.g. HTTP handlers). */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw result.error;
}

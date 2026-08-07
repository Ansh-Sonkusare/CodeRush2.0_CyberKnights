/**
 * Serialize a value to JSON, converting bigint leaves to decimal strings.
 *
 * In-process values keep MicroAlgo as bigint (see branded.ts); the wire format
 * (HTTP / WS / SSE boundaries) carries money as decimal strings. Use this at
 * the boundary only — never inside business logic.
 */
export function jsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
}

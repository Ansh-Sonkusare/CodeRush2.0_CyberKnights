/**
 * Money display helpers.
 *
 * Money crosses the wire as decimal strings and is stored as bigint; it is
 * only ever formatted for display here (the UI boundary). No arithmetic on
 * money happens outside this file.
 */

export function parseMicroAlgo(value: string): bigint {
  return BigInt(value);
}

/** e.g. 12345 → "12,345 µA" */
export function formatMicroAlgo(value: bigint | string): string {
  const n = typeof value === "bigint" ? value : BigInt(value);
  return `${n.toLocaleString("en-US")} µA`;
}

/** 0..1 fraction of spent+reserved vs cap, clamped — for the budget bar. */
export function budgetFraction(spent: bigint, reserved: bigint, cap: bigint): number {
  if (cap <= 0n) return 0;
  const used = spent + reserved;
  const fraction = Number((used * 100n) / cap) / 100;
  return Math.min(1, Math.max(0, fraction));
}

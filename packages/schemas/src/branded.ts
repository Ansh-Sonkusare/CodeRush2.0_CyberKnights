/**
 * Branded primitives.
 *
 * Use the constructor helpers (microAlgo, taskNodeId, etc.) to brand values.
 * Never cast with `as MicroAlgo` outside this file — use the helpers so the
 * brand origin is always traceable.
 */

// On-chain amounts — bigint so arithmetic never loses precision.
// Never stored as plain number in business logic.
export type MicroAlgo = bigint & { readonly __brand: "MicroAlgo" };
export const microAlgo = (n: bigint): MicroAlgo => n as MicroAlgo;
export const microAlgoFromNumber = (n: number): MicroAlgo =>
  BigInt(Math.round(n)) as MicroAlgo;

// Task / node identifiers
export type TaskId = string & { readonly __brand: "TaskId" };
export const taskId = (s: string): TaskId => s as TaskId;

export type TaskNodeId = string & { readonly __brand: "TaskNodeId" };
export const taskNodeId = (s: string): TaskNodeId => s as TaskNodeId;

// Idempotency key — generated once per (task, node, provider) triple
export type IdempotencyKey = string & { readonly __brand: "IdempotencyKey" };
export const idempotencyKey = (taskId: string, nodeId: string, providerId: string): IdempotencyKey =>
  `ik-${taskId}-${nodeId}-${providerId}` as IdempotencyKey;

// Algorand wallet address
export type WalletAddress = string & { readonly __brand: "WalletAddress" };
export const walletAddress = (s: string): WalletAddress => s as WalletAddress;

// Scoped capability token — issued by treasury, consumed by x402-client
export type ScopedCapabilityToken = string & { readonly __brand: "ScopedCapabilityToken" };

export interface ScopedCapability {
  readonly token: ScopedCapabilityToken;
  readonly taskId: TaskId;
  readonly nodeId: TaskNodeId;
  readonly providerId: string;
  readonly maxAmount: MicroAlgo;
}

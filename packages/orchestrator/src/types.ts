import type { ProviderAdapter } from "@sentinel/schemas";
import type { Treasury } from "@sentinel/treasury";
import type { X402Client } from "@sentinel/x402-client";
import type { Router } from "@sentinel/router";
import type { LedgerStore } from "@sentinel/ledger";

/**
 * Everything a NodeMachine/TaskMachine needs to execute a paid node.
 *
 * These are the engines the machines invoke as promises — the same objects
 * apps/service-orchestrator wires together at boot. `treasury` is replaced
 * per task (one budget per run); the rest are shared singletons. Shared
 * mutable state (x402 idempotency map, ledger rows) lives here so every actor
 * in a task run sees the same budget and the same settlement map.
 */
export interface OrchestratorDeps {
  treasury: Treasury;
  x402: X402Client;
  ledger: LedgerStore;
  router: Router;
  /** Routeable catalog adapters (used for the demo forced-provider knob). */
  adapters: ProviderAdapter[];
}

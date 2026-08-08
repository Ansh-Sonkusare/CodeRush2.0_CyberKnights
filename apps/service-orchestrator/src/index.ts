import { serve } from "@hono/node-server";
import { hc } from "hono/client";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig, resolveLedgerPath } from "@sentinel/config";
import { createLedgerStore } from "@sentinel/ledger";
import { createX402Client } from "@sentinel/x402-client";
import { createRouter, resolveWeights } from "@sentinel/router";
import {
  RemoteProviderAdapter,
  X402ProviderAdapter,
  fromWire,
} from "@sentinel/providers";
import {
  PlanOutcomeSchema,
  type PlanOutcome,
  type PlannerRoutes,
  type ProviderAdapter,
  type ProviderRoutes,
} from "@sentinel/schemas";
import { createOrchestratorApp } from "./app.js";

function serviceUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function main(): Promise<void> {
  const config = loadConfig();

  const ledgerPath = resolveLedgerPath(config);
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const ledger = createLedgerStore(ledgerPath);

  const planner = hc<PlannerRoutes>(serviceUrl(config.ports.planner));
  const providers = hc<ProviderRoutes>(serviceUrl(config.ports.providers));

  const plan = async (goal: string, taskId: string): Promise<PlanOutcome> => {
    const res = await planner.planner.plan.$post({ json: { goal, task_id: taskId } });
    if (!res.ok) throw new Error(`planner upstream failed: HTTP ${res.status}`);
    const parsed = PlanOutcomeSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new Error("planner returned a plan that failed schema validation");
    }
    return parsed.data;
  };

  // Payment layer: simulated (no funds, the safe default) unless the operator
  // sets X402_MODE=algorand with a TestNet ALGO_MNEMONIC. The signer stays
  // inside @sentinel/x402-client — nothing else sees the mnemonic. Created
  // before refreshProviders because x402 catalog entries are built around it.
  const x402 = createX402Client({
    mode: config.x402Mode,
    ...(config.algoMnemonic ? { mnemonic: config.algoMnemonic } : {}),
  });

  // Routeable catalog, rebuilt from the provider registry on every run.
  // A provider catalog entry is untrusted wire input — fromWire validates it.
  // Entries marked `failed` (the registry's demo fail/recover knob) are
  // excluded from routing so the router/fallback path can be demoed live.
  // The router itself is built per-run (with goal-derived weights) — no shared
  // singleton needed here.
  let currentAdapters: ProviderAdapter[] = [];

  async function refreshProviders(): Promise<void> {
    try {
      const res = await providers.providers.$get();
      if (!res.ok) {
        console.warn(`[orchestrator] provider registry returned HTTP ${res.status}`);
        return;
      }
      const next: ProviderAdapter[] = [];
      for (const entry of await res.json()) {
        // Include all providers — failed ones stay in the routing pool and fail
        // at the HTTP layer (503 from the mock routes / unreachable for real
        // remotes). The node machine's retry/fallback path handles the failure.
        // Only skip entries that can't be parsed as valid catalog entries.
        try {
          // integration === "x402" → a real x402 resource server: pay + fetch
          // via the x402 client (which caches the paid body), not the plain
          // /quote + /deliver wire contract.
          if (entry.integration === "x402") {
            next.push(new X402ProviderAdapter(fromWire(entry), x402));
          } else {
            next.push(new RemoteProviderAdapter(fromWire(entry)));
          }
        } catch {
          // skip invalid catalog entries — the registry is external input
        }
      }
      currentAdapters = next;
    } catch (err) {
      // Registry unreachable mid-run — keep the previous catalog rather than
      // wiping it; runs will fail to route only if nothing is ever loaded.
      console.warn(
        `[orchestrator] provider registry unreachable at :${config.ports.providers}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  await refreshProviders();
  if (currentAdapters.length === 0) {
    console.warn("[orchestrator] no providers loaded — runs will fail to route");
  }

  const { app } = createOrchestratorApp({
    plan,
    ledger,
    x402,
    refreshProviders,
    /**
     * Goal-aware router factory: each run starts with goal-heuristic weights,
     * and the task machine replaces the router once the plan's route_profile
     * is known (via rebuildRouter, injected by createTaskRunner).
     */
    router: (goal) => createRouter(currentAdapters, {
      weights: resolveWeights(goal),
    }),
    adapters: () => currentAdapters,
  });

  serve({ fetch: app.fetch, port: config.ports.orchestrator }, (info) => {
    console.log(`[orchestrator] listening on :${info.port}`);
  });
}

main().catch((err) => {
  console.error("[orchestrator] failed to start:", err);
  process.exitCode = 1;
});

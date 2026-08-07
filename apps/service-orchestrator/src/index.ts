import { serve } from "@hono/node-server";
import { hc } from "hono/client";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig } from "@sentinel/config";
import { createLedgerStore } from "@sentinel/ledger";
import { SimulatedX402Client } from "@sentinel/x402-client";
import { createRouter } from "@sentinel/router";
import { RemoteProviderAdapter, fromWire } from "@sentinel/providers";
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

  const ledgerPath = resolve(config.ledgerPath);
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

  // Build routeable adapters from the provider registry (service-providers).
  // A provider catalog entry is untrusted wire input — fromWire validates it.
  let adapters: ProviderAdapter[] = [];
  try {
    const res = await providers.providers.$get();
    if (res.ok) {
      for (const entry of await res.json()) {
        try {
          adapters.push(new RemoteProviderAdapter(fromWire(entry)));
        } catch {
          // skip invalid catalog entries — the registry is external input
        }
      }
    }
  } catch (err) {
    console.warn(
      `[orchestrator] provider registry unreachable at :${config.ports.providers}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (adapters.length === 0) {
    console.warn("[orchestrator] no providers loaded — runs will fail to route");
  }

  const x402 = new SimulatedX402Client();
  const router = createRouter(adapters);

  const { app } = createOrchestratorApp({ plan, ledger, x402, router, adapters });

  serve({ fetch: app.fetch, port: config.ports.orchestrator }, (info) => {
    console.log(`[orchestrator] listening on :${info.port}`);
  });
}

main().catch((err) => {
  console.error("[orchestrator] failed to start:", err);
  process.exitCode = 1;
});

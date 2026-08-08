import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { zValidator } from "@hono/zod-validator";
import { hc } from "hono/client";
import { z } from "zod";
import {
  ApproveRequestSchema,
  CapabilitySchema,
  CreateLedgerRowRequestSchema,
  PlanRequestSchema,
  RegisterProviderRequestSchema,
  RejectRequestSchema,
  RunRequestSchema,
  SetFailModeRequestSchema,
  ValidateRequestSchema,
  type GatewayEnv,
  type GatewaySchema,
  type OrchestratorRoutes,
  type PlannerRoutes,
  type ProviderRoutes,
} from "@sentinel/schemas";
import type { AppConfig } from "@sentinel/config";
import { toReconciliationWire, type LedgerStore } from "@sentinel/ledger";

// ─── Gateway (Phase 10) ───────────────────────────────────────────────────────
// Single public entry point on :4000. Planner + provider + orchestrator routes
// delegate to the microservices via typed hc<> clients (service URLs derived
// from config ports); ledger routes are served in-process from packages/ledger.
// The /ws hub lives in wsHub.ts and tails the orchestrator's SSE stream.

function serviceUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

// Forward an upstream hc response verbatim (status + content-type + body).
// hc returns a ClientResponse (a Response subclass), so a plain Response is the
// common supertype for the passthrough helper.
async function passthrough(res: Response): Promise<Response> {
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("Content-Type") ?? "application/json",
    },
  });
}

// Run one hc call, turning "upstream down" (fetch throw) into a 502.
async function proxyJson(c: Context, call: () => Promise<Response>): Promise<Response> {
  try {
    return await passthrough(await call());
  } catch {
    return c.json({ message: "upstream service unreachable" }, 502);
  }
}

const paramId = z.object({ id: z.string().min(1) });
const paramCapability = z.object({ capability: CapabilitySchema });
const paramLedgerId = z.object({ ledgerId: z.string().min(1) });
const paramTaskId = z.object({ taskId: z.string().min(1) });
const paramNodeId = z.object({ nodeId: z.string().min(1) });

export function createGatewayApp(config: AppConfig, ledger: LedgerStore) {
  const app = new Hono<GatewayEnv, GatewaySchema>();
  app.use("/api/*", cors());

  const planner = hc<PlannerRoutes>(serviceUrl(config.ports.planner));
  const providers = hc<ProviderRoutes>(serviceUrl(config.ports.providers));
  const orchestrator = hc<OrchestratorRoutes>(serviceUrl(config.ports.orchestrator));

  // ─── /api/planner/* → service-planner (:4040) ──────────────────────────────

  app.post("/api/planner/plan", zValidator("json", PlanRequestSchema), (c) => {
    const body = c.req.valid("json");
    return proxyJson(c, () => planner.planner.plan.$post({ json: body }));
  });

  app.get("/api/planner/fallback", (c) =>
    proxyJson(c, () => planner.planner.fallback.$get()),
  );

  app.post("/api/planner/validate", zValidator("json", ValidateRequestSchema), (c) => {
    const body = c.req.valid("json");
    return proxyJson(c, () => planner.planner.validate.$post({ json: body }));
  });

  // ─── /api/providers/* → service-providers (:4020) ──────────────────────────

  app.get("/api/providers", (c) => proxyJson(c, () => providers.providers.$get()));

  app.post(
    "/api/providers/register",
    zValidator("json", RegisterProviderRequestSchema),
    (c) => {
      const body = c.req.valid("json");
      return proxyJson(c, () => providers.providers.register.$post({ json: body }));
    },
  );

  app.get(
    "/api/providers/catalog/:capability",
    zValidator("param", paramCapability),
    (c) => {
      const { capability } = c.req.valid("param");
      return proxyJson(c, () =>
        providers.providers.catalog[":capability"].$get({ param: { capability } }),
      );
    },
  );

  app.get("/api/providers/:id/health", zValidator("param", paramId), (c) => {
    const { id } = c.req.valid("param");
    return proxyJson(c, () => providers.providers[":id"].health.$get({ param: { id } }));
  });

  app.post("/api/providers/:id/fail", zValidator("param", paramId), (c) => {
    const { id } = c.req.valid("param");
    return proxyJson(c, () => providers.providers[":id"].fail.$post({ param: { id } }));
  });

  app.post("/api/providers/:id/recover", zValidator("param", paramId), (c) => {
    const { id } = c.req.valid("param");
    return proxyJson(c, () => providers.providers[":id"].recover.$post({ param: { id } }));
  });

  app.post(
    "/api/providers/:id/fail-mode",
    zValidator("param", paramId),
    zValidator("json", SetFailModeRequestSchema),
    (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      return proxyJson(c, () =>
        providers.providers[":id"]["fail-mode"].$post({ param: { id }, json: body }),
      );
    },
  );

  // ─── /api/ledger/* → in-process packages/ledger ────────────────────────────

  app.get("/api/ledger/rows", async (c) => c.json(await ledger.all()));

  app.post(
    "/api/ledger/rows",
    zValidator("json", CreateLedgerRowRequestSchema),
    async (c) => {
      const body = c.req.valid("json");
      try {
        return c.json(await ledger.insert(body), 201);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "ledger insert failed";
        return c.json({ message: msg }, 500);
      }
    },
  );

  app.get("/api/ledger/row/:ledgerId", zValidator("param", paramLedgerId), async (c) => {
    const row = await ledger.get(c.req.valid("param").ledgerId);
    return row ? c.json(row) : c.json({ message: "ledger row not found" }, 404);
  });

  app.get("/api/ledger/task/:taskId", zValidator("param", paramTaskId), async (c) => {
    return c.json(await ledger.findByTaskId(c.req.valid("param").taskId));
  });

  app.get("/api/ledger/task/:taskId/export", zValidator("param", paramTaskId), async (c) => {
    try {
      return c.json(await ledger.exportTask(c.req.valid("param").taskId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "ledger export failed";
      return c.json({ message: msg }, 500);
    }
  });

  app.get("/api/ledger/task/:taskId/reconcile", zValidator("param", paramTaskId), async (c) => {
    try {
      const report = await ledger.exportTaskReconciliation(c.req.valid("param").taskId);
      return c.json(toReconciliationWire(report));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "ledger reconciliation failed";
      return c.json({ message: msg }, 500);
    }
  });

  app.get("/api/ledger/node/:nodeId", zValidator("param", paramNodeId), async (c) => {
    const row = await ledger.findByNodeId(c.req.valid("param").nodeId);
    return row ? c.json(row) : c.json({ message: "ledger row not found" }, 404);
  });

  app.post("/api/ledger/reset", async (c) => {
    await ledger.reset();
    return c.json({ ok: true });
  });

  // ─── /api/orchestrator/* → service-orchestrator (:4010) ─────────────────────

  app.post(
    "/api/orchestrator/run",
    zValidator("json", RunRequestSchema),
    (c) => {
      const body = c.req.valid("json");
      return proxyJson(c, () => orchestrator.orchestrator.run.$post({ json: body }));
    },
  );

  app.post(
    "/api/orchestrator/approve",
    zValidator("json", ApproveRequestSchema),
    (c) => {
      const body = c.req.valid("json");
      return proxyJson(c, () => orchestrator.orchestrator.approve.$post({ json: body }));
    },
  );

  app.post(
    "/api/orchestrator/reject",
    zValidator("json", RejectRequestSchema),
    (c) => {
      const body = c.req.valid("json");
      return proxyJson(c, () => orchestrator.orchestrator.reject.$post({ json: body }));
    },
  );

  app.get(
    "/api/orchestrator/status/:taskId",
    zValidator("param", paramTaskId),
    (c) => {
      const { taskId } = c.req.valid("param");
      return proxyJson(c, () =>
        orchestrator.orchestrator.status[":taskId"].$get({ param: { taskId } }),
      );
    },
  );

  app.get(
    "/api/orchestrator/nodes/:taskId",
    zValidator("param", paramTaskId),
    (c) => {
      const { taskId } = c.req.valid("param");
      return proxyJson(c, () =>
        orchestrator.orchestrator.nodes[":taskId"].$get({ param: { taskId } }),
      );
    },
  );

  return app;
}

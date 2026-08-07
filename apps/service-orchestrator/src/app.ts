import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { stream } from "hono/streaming";
import { z } from "zod";
import {
  ApproveRequestSchema,
  RejectRequestSchema,
  RunRequestSchema,
  jsonStringify,
  microAlgo,
  type OrchestratorEnv,
  type OrchestratorSchema,
  type PlanOutcome,
  type ProviderAdapter,
  type RejectResponse,
  type WsMessage,
} from "@sentinel/schemas";
import { createTaskRunner } from "@sentinel/orchestrator";
import type { LedgerStore } from "@sentinel/ledger";
import type { Router } from "@sentinel/router";
import type { X402Client } from "@sentinel/x402-client";

/**
 * apps/service-orchestrator — XState task execution (:4010).
 *
 * Wires the engines (ledger, x402 client, router, catalog adapters) into
 * createTaskRunner and exposes the run/approve/reject/status/nodes HTTP API
 * plus a `GET /orchestrator/events` SSE stream. The SSE stream is consumed by
 * the gateway's WS hub so the UI sees live NodeState/task events — every frame
 * is a serialized WsMessage (the same discriminated union the machines emit).
 *
 * Money leaves this boundary as decimal strings (jsonStringify) — the same
 * rule as every other HTTP/WS boundary in the repo.
 */

export interface OrchestratorAppDeps {
  /** Planner call (apps/service-orchestrator wraps hc<PlannerRoutes>). */
  plan: (goal: string, taskId: string) => Promise<PlanOutcome>;
  ledger: LedgerStore;
  x402: X402Client;
  /**
   * Re-read the routeable catalog from the provider registry before a run so
   * the fail/recover demo knobs take effect on the next run.
   */
  refreshProviders: () => Promise<void>;
  /** Router resolved at run() time (rebuilt after each refresh). */
  router: () => Router;
  /** Routeable catalog adapters resolved at run() time (excludes failed). */
  adapters: () => ProviderAdapter[];
}

export interface OrchestratorService {
  app: Hono<OrchestratorEnv, OrchestratorSchema>;
  /** Push a WsMessage to every connected SSE subscriber (TaskRunner broadcast). */
  emit: (msg: WsMessage) => void;
}

const taskIdParam = z.object({ taskId: z.string().min(1) });

/** Serialize a response body with bigint leaves as decimal strings. */
function jsonBody(c: Context, data: unknown, status: 200 | 404 = 200): Response {
  return c.body(jsonStringify(data), status, { "Content-Type": "application/json" });
}

export function createOrchestratorApp(deps: OrchestratorAppDeps): OrchestratorService {
  const subscribers = new Set<(frame: string) => void>();

  const emit: (msg: WsMessage) => void = (msg) => {
    const frame = `data: ${jsonStringify(msg)}\n\n`;
    for (const send of subscribers) send(frame);
  };

  const runner = createTaskRunner({
    x402: deps.x402,
    ledger: deps.ledger,
    router: deps.router,
    adapters: deps.adapters,
    plan: deps.plan,
    broadcast: emit,
  });

  const app = new Hono<OrchestratorEnv, OrchestratorSchema>();

  app.post(
    "/orchestrator/run",
    zValidator("json", RunRequestSchema),
    async (c) => {
      // Re-read the catalog first so provider fail/recover knobs (set via
      // POST /api/providers/:id/fail) are reflected in this run's routing.
      await deps.refreshProviders();
      return c.json(await runner.run(c.req.valid("json")));
    },
  );

  app.post(
    "/orchestrator/approve",
    zValidator("json", ApproveRequestSchema),
    async (c) => {
      const { taskId, delta } = c.req.valid("json");
      const status = await runner.approve(taskId, microAlgo(BigInt(delta)));
      if (status === undefined) return c.json({ message: "task not found" }, 404);
      return jsonBody(c, status);
    },
  );

  app.post(
    "/orchestrator/reject",
    zValidator("json", RejectRequestSchema),
    (c) => {
      const { taskId } = c.req.valid("json");
      runner.reject(taskId);
      const body: RejectResponse = { ok: true };
      return c.json(body);
    },
  );

  app.get(
    "/orchestrator/status/:taskId",
    zValidator("param", taskIdParam),
    (c) => {
      const status = runner.status(c.req.valid("param").taskId);
      if (status === undefined) return c.json({ message: "task not found" }, 404);
      return jsonBody(c, status);
    },
  );

  app.get(
    "/orchestrator/nodes/:taskId",
    zValidator("param", taskIdParam),
    (c) => {
      const nodes = runner.nodes(c.req.valid("param").taskId);
      if (nodes === undefined) return c.json({ message: "task not found" }, 404);
      return jsonBody(c, nodes);
    },
  );

  // SSE event stream — consumed by the gateway WS hub and re-broadcast to the
  // UI. Kept alive by a heartbeat; subscribers are removed on abort.
  app.get("/orchestrator/events", (c) => {
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");
    return stream(c, async (s) => {
      const send = (frame: string): void => {
        void s.write(frame).catch(() => undefined);
      };
      subscribers.add(send);
      try {
        while (!s.aborted) await s.sleep(15_000);
      } finally {
        subscribers.delete(send);
      }
    });
  });

  return { app, emit };
}

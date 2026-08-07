import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  PlanRequestSchema,
  ValidateRequestSchema,
  validateGraph,
  type PlannerEnv,
  type PlannerSchema,
} from "@sentinel/schemas";
import type { LLMClient } from "@sentinel/llm-client";
import { planWithFallback } from "./planner.js";
import { FALLBACK_GRAPH } from "./fallback.js";

export function createPlannerApp(client: LLMClient) {
  const app = new Hono<PlannerEnv, PlannerSchema>();

  app.post(
    "/planner/plan",
    zValidator("json", PlanRequestSchema),
    async (c) => {
      const { goal, task_id } = c.req.valid("json");
      const options = task_id === undefined ? {} : { task_id };
      return c.json(await planWithFallback(client, goal, options));
    },
  );

  app.get("/planner/fallback", (c) => c.json(FALLBACK_GRAPH));

  app.post(
    "/planner/validate",
    zValidator("json", ValidateRequestSchema),
    (c) => {
      const { graph } = c.req.valid("json");
      const result = validateGraph(graph);
      return c.json(result.ok ? { ok: true } : { ok: false, errors: result.errors });
    },
  );

  return app;
}

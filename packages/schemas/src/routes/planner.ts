import type { Hono } from "hono";
import type { JsonGet, JsonPost } from "./common.js";
import type {
  PlanOutcome,
  PlanRequest,
  PlannerGraph,
  ValidateRequest,
  ValidateResponse,
} from "../planner.js";

// ─── apps/service-planner typed route contract (Phase 8) ─────────────────────
// Used by the service (new Hono<Env, PlannerSchema>()) to match its routes and
// by the gateway via hc<PlannerRoutes>(url). Request/response shapes live in
// ../planner.ts. Endpoint-shaped helpers live in ./common.ts.

// NOTE: keys intentionally NOT intersected with hono's broad `Schema` — keeping
// the path keys literal lets hc build a typed nested client (see providers.ts).

export type PlannerSchema = {
  "/planner/plan": {
    $post: JsonPost<PlanRequest, PlanOutcome, 200>;
  };
  "/planner/fallback": {
    $get: JsonGet<PlannerGraph>;
  };
  "/planner/validate": {
    $post: JsonPost<ValidateRequest, ValidateResponse, 200>;
  };
};

/** Environment the planner service runs with (no variables — the LLM client is
 * injected via the createPlannerApp closure, not read from c.env). */
export interface PlannerEnv {
  Variables: Record<string, never>;
}

/**
 * App type for apps/service-planner. The service builds its Hono instance as
 * `new Hono<PlannerEnv, PlannerSchema>()` and the gateway calls it via
 * `hc<PlannerRoutes>(url)`.
 */
export type PlannerRoutes = Hono<PlannerEnv, PlannerSchema>;

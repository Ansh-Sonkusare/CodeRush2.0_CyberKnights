import type { Hono } from "hono";
import type { JsonPost, ParamGet } from "./common.js";
import type {
  ApproveRequest,
  RejectRequest,
  RejectResponse,
  RunRequest,
  RunResponse,
} from "../orchestrator.js";
import type { BudgetStatus, ExecutionStatus, NodeState } from "../node-state.js";

// ─── apps/service-orchestrator typed route contract (Phase 9) ────────────────
// Used by the service (new Hono<OrchestratorEnv, OrchestratorSchema>()) to match
// its routes and by the gateway via hc<OrchestratorRoutes>(url). Request/response
// shapes live in ../orchestrator.ts + ../node-state.ts. Endpoint-shaped helpers
// live in ./common.ts.
//
// NOTE: money leaves the boundary as decimal strings (jsonStringify), so wire
// responses for BudgetStatus/ExecutionStatus/NodeState carry bigint fields as
// strings. The typed client contract keeps the branded bigint types for
// in-process correctness; the web/UI layer treats them as strings.

export type OrchestratorSchema = {
  "/orchestrator/run": {
    $post: JsonPost<RunRequest, RunResponse, 200>;
  };
  "/orchestrator/approve": {
    $post: JsonPost<ApproveRequest, BudgetStatus, 200>;
  };
  "/orchestrator/reject": {
    $post: JsonPost<RejectRequest, RejectResponse, 200>;
  };
  "/orchestrator/status/:taskId": {
    $get: ParamGet<{ taskId: string }, ExecutionStatus>;
  };
  "/orchestrator/nodes/:taskId": {
    $get: ParamGet<{ taskId: string }, NodeState[]>;
  };
};

/** Environment the orchestrator service runs with (no variables — deps are
 * injected via the createOrchestratorApp closure, not read from c.env). */
export interface OrchestratorEnv {
  Variables: Record<string, never>;
}

/**
 * App type for apps/service-orchestrator. The service builds its Hono instance
 * as `new Hono<OrchestratorEnv, OrchestratorSchema>()` and the gateway calls it
 * via `hc<OrchestratorRoutes>(url)`.
 */
export type OrchestratorRoutes = Hono<OrchestratorEnv, OrchestratorSchema>;

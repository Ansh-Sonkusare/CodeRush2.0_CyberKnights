import type { Hono } from "hono";
import type { JsonGet, JsonPost, ParamGet, ParamPost } from "./common.js";
import type {
  LedgerExport,
  LedgerRow,
  CreateLedgerRowRequest,
} from "../ledger.js";
import type {
  PlanOutcome,
  PlanRequest,
  PlannerGraph,
  ValidateRequest,
  ValidateResponse,
} from "../planner.js";
import type {
  ProviderCatalogEntryWire,
  ProviderHealthResponse,
  ProviderStatusResponse,
  RegisterProviderRequest,
} from "../provider.js";

// ─── apps/gateway typed route contract (Phase 10) ─────────────────────────────
// The single public entry point for apps/web. Planner/provider routes proxy to
// their services via hc<PlannerRoutes>/hc<ProviderRoutes>; ledger routes are
// served in-process from packages/ledger. Request/response shapes reuse the
// service contracts (the gateway is a thin passthrough, not a new API).
// Orchestrator proxy + WS hub land with Phase 9.

export type GatewaySchema = {
  "/api/planner/plan": {
    $post: JsonPost<PlanRequest, PlanOutcome, 200>;
  };
  "/api/planner/fallback": {
    $get: JsonGet<PlannerGraph>;
  };
  "/api/planner/validate": {
    $post: JsonPost<ValidateRequest, ValidateResponse, 200>;
  };
  "/api/providers": {
    $get: JsonGet<ProviderCatalogEntryWire[]>;
  };
  "/api/providers/register": {
    $post: JsonPost<RegisterProviderRequest, ProviderCatalogEntryWire, 201>;
  };
  "/api/providers/catalog/:capability": {
    $get: ParamGet<{ capability: string }, ProviderCatalogEntryWire[]>;
  };
  "/api/providers/:id/health": {
    $get: ParamGet<{ id: string }, ProviderHealthResponse>;
  };
  "/api/providers/:id/fail": {
    $post: ParamPost<{ id: string }, ProviderStatusResponse>;
  };
  "/api/providers/:id/recover": {
    $post: ParamPost<{ id: string }, ProviderStatusResponse>;
  };
  "/api/ledger/rows": {
    $get: JsonGet<LedgerRow[]>;
    $post: JsonPost<CreateLedgerRowRequest, LedgerRow, 201>;
  };
  "/api/ledger/row/:ledgerId": {
    $get: ParamGet<{ ledgerId: string }, LedgerRow>;
  };
  "/api/ledger/task/:taskId": {
    $get: ParamGet<{ taskId: string }, LedgerRow[]>;
  };
  "/api/ledger/task/:taskId/export": {
    $get: ParamGet<{ taskId: string }, LedgerExport>;
  };
  "/api/ledger/node/:nodeId": {
    $get: ParamGet<{ nodeId: string }, LedgerRow>;
  };
  "/api/ledger/reset": {
    $post: JsonPost<Record<string, never>, { ok: true }, 200>;
  };
};

/** Environment the gateway runs with (no variables — upstream clients and the
 * ledger store are injected via the createGatewayApp closure). */
export interface GatewayEnv {
  Variables: Record<string, never>;
}

/**
 * App type for apps/gateway. The gateway builds its Hono instance as
 * `new Hono<GatewayEnv, GatewaySchema>()` and apps/web calls it via
 * `hc<GatewayRoutes>(url)`.
 */
export type GatewayRoutes = Hono<GatewayEnv, GatewaySchema>;

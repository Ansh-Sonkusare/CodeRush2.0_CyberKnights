import type { Hono } from "hono";
import type { JsonGet, JsonPost, ParamGet, ParamJsonPost, ParamPost } from "./common.js";
import type {
  ProviderCatalogEntryWire,
  ProviderHealthResponse,
  ProviderRegistry,
  ProviderStatusResponse,
  RegisterProviderRequest,
  SetFailModeRequest,
  SetFailModeResponse,
} from "../provider.js";

// ─── apps/service-providers typed route contract (Phase 7) ────────────────────
// Used by the service (new Hono<Env, ProviderSchema>()) to match its routes and
// by the gateway via hc<ProviderSchema>(url). Wire shapes live in ../provider.ts.
// Endpoint-shaped helpers (JsonGet/JsonPost/ParamGet/ParamPost) live in ./common.ts.

// NOTE: intentionally NOT intersected with hono's broad `Schema` (which has a
// `[Path: string]` index signature). Keeping the keys literal lets hc build a
// typed nested client; a broad index signature would collapse every path.

export type ProviderSchema = {
  "/providers": {
    $get: JsonGet<ProviderCatalogEntryWire[]>;
  };
  "/providers/register": {
    $post: JsonPost<RegisterProviderRequest, ProviderCatalogEntryWire, 201>;
  };
  "/providers/catalog/:capability": {
    $get: ParamGet<{ capability: string }, ProviderCatalogEntryWire[]>;
  };
  "/providers/:id/health": {
    $get: ParamGet<{ id: string }, ProviderHealthResponse>;
  };
  "/providers/:id/fail": {
    $post: ParamPost<{ id: string }, ProviderStatusResponse>;
  };
  "/providers/:id/recover": {
    $post: ParamPost<{ id: string }, ProviderStatusResponse>;
  };
  "/providers/:id/fail-mode": {
    $post: ParamJsonPost<{ id: string }, SetFailModeRequest, SetFailModeResponse, 200>;
  };
};

/** Environment the providers service runs with (registry injected via middleware). */
export interface ProviderEnv {
  Variables: {
    registry: ProviderRegistry;
  };
}

/**
 * App type for apps/service-providers. The service builds its Hono instance as
 * `new Hono<ProviderEnv, ProviderSchema>()` and the gateway calls it via
 * `hc<ProviderRoutes>(url)`.
 */
export type ProviderRoutes = Hono<ProviderEnv, ProviderSchema>;

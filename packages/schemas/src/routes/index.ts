/**
 * Typed route contracts for Hono's hc<T>() typed RPC client.
 *
 * Each service exports its route schema here so the gateway can call it with
 * full type safety — request shapes, response shapes, and URL paths are all
 * checked at compile time.
 *
 * The actual Hono app instances live under apps/service-* (each in
 * src/app.ts) and use these schemas (new Hono<Env, XRoutes>()) to ensure they
 * match. Stubs remain until their phase is implemented.
 */

export type { ProviderRoutes, ProviderSchema, ProviderEnv } from "./providers.js";
export type { PlannerRoutes, PlannerSchema, PlannerEnv } from "./planner.js";
export type { GatewayRoutes, GatewaySchema, GatewayEnv } from "./gateway.js";
export type { OrchestratorRoutes } from "./orchestrator.js";

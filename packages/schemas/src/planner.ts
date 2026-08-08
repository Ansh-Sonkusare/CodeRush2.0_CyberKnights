import { z } from "zod";
import { ROUTEABLE_CAPABILITIES, RouteableCapabilitySchema } from "./capability.js";

// ─── Task graph ───────────────────────────────────────────────────────────────

export const TaskStepSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    capability: RouteableCapabilitySchema,
    dependsOn: z.array(z.string()).default([]),
  })
  .strict();

export type TaskStep = z.infer<typeof TaskStepSchema>;

export const TaskGraphSchema = z
  .object({
    task_id: z.string(),
    name: z.string(),
    // budget_cap is intentionally absent here — treasury owns it.
    // It is set by the orchestrator after planning, never from planner output.
    goal: z.string(),
    steps: z.array(TaskStepSchema).min(1),
  })
  .strict();

export type TaskGraph = z.infer<typeof TaskGraphSchema>;

// ─── Route profile ────────────────────────────────────────────────────────────
// The routing preference a run should favor. The planner (or a keyword
// heuristic) proposes a profile; optional everywhere — absence means the
// router falls back to its defaults (balanced).

export const RouteProfileSchema = z.enum([
  "price",
  "quality",
  "latency",
  "balanced",
]);
export type RouteProfile = z.infer<typeof RouteProfileSchema>;

export const RouteProfileResolutionSchema = z
  .object({
    profile: RouteProfileSchema,
    source: z.enum(["llm", "heuristic"]),
  })
  .strict();

export type RouteProfileResolution = z.infer<typeof RouteProfileResolutionSchema>;

// ─── Planner output (LLM-facing) ─────────────────────────────────────────────
// Separate from TaskGraph: planner output is untrusted LLM input and must be
// validated before being converted to a TaskGraph. budget_cap / scope / wallet
// are forbidden keys — the forbidden key check runs before schema parse.

export const PlannerStepSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    capability: RouteableCapabilitySchema,
    dependsOn: z.array(z.string()).default([]),
  })
  .strict();

export type PlannerStep = z.infer<typeof PlannerStepSchema>;

export const PlannerGraphSchema = z
  .object({
    task_id: z.string(),
    name: z.string(),
    goal: z.string(),
    steps: z.array(PlannerStepSchema).min(1),
    route_profile: RouteProfileResolutionSchema.optional(),
  })
  .strict();

export type PlannerGraph = z.infer<typeof PlannerGraphSchema>;

// JSON Schema version for LLM structured output (Gemini / Ollama format)
// capability is constrained to ROUTEABLE_CAPABILITIES — the planner may only
// propose steps for capabilities that have registered providers, otherwise the
// plan would route to nothing and fail end-to-end.
export const PLANNER_GRAPH_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["task_id", "name", "goal", "steps"],
  properties: {
    task_id: { type: "string" },
    name: { type: "string" },
    goal: { type: "string" },
    steps: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "capability", "dependsOn"],
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          capability: { type: "string", enum: [...ROUTEABLE_CAPABILITIES] },
          dependsOn: { type: "array", items: { type: "string" } },
        },
      },
    },
    route_profile: {
      type: "object",
      additionalProperties: false,
      required: ["profile", "source"],
      properties: {
        profile: { type: "string", enum: ["price", "quality", "latency", "balanced"] },
        source: { type: "string", enum: ["llm", "heuristic"] },
      },
    },
  },
};

// Fields the planner must never emit (budget/scope owned by treasury)
const FORBIDDEN_KEYS = new Set([
  "budget", "budget_cap", "cap", "raise_cap", "approve_overspend",
  "scope", "scope_token", "wallet_scope", "grant_access", "allowed_wallets",
  "key", "secret", "seed", "token", "credential",
  "instruction", "__instruction", "__override", "agent_instruction",
]);

export function containsForbiddenKeys(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = containsForbiddenKeys(value[i]);
      if (hit !== null) return `[${i}]${hit}`;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) return `.${key}`;
      const hit = containsForbiddenKeys(val);
      if (hit !== null) return `.${key}${hit}`;
    }
  }
  return null;
}

// ─── Graph validation ─────────────────────────────────────────────────────────
// Structural checks that zod can't express: duplicate ids, unknown/self
// dependencies, and cycles. Returns the (validated) graph on success so callers
// can chain plannerGraphToTaskGraph without re-checking.

export function validateGraph(
  graph: PlannerGraph,
): { ok: true; graph: PlannerGraph } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const step of graph.steps) {
    if (ids.has(step.id)) errors.push(`duplicate step id "${step.id}"`);
    ids.add(step.id);
    for (const dep of step.dependsOn) {
      if (dep === step.id) errors.push(`step "${step.id}" depends on itself`);
      else if (!ids.has(dep) && !graph.steps.some((s) => s.id === dep))
        errors.push(`step "${step.id}" depends on unknown "${dep}"`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(graph.steps.map((s) => [s.id, s]));
  const hasCycle = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (hasCycle(dep)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const step of graph.steps) {
    if (hasCycle(step.id)) {
      errors.push("task graph contains a dependency cycle");
      break;
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, graph };
}

// ─── Planner output → TaskGraph ───────────────────────────────────────────────
// Planner output and TaskGraph have identical shapes today (budget_cap lives on
// the orchestrator's runtime state, not in the schema — see TaskGraphSchema).

export function plannerGraphToTaskGraph(
  graph: PlannerGraph,
  options: { task_id?: string } = {},
): TaskGraph {
  return {
    task_id: options.task_id ?? graph.task_id,
    name: graph.name,
    goal: graph.goal,
    steps: graph.steps.map((step) => ({
      id: step.id,
      label: step.label,
      capability: step.capability,
      dependsOn: step.dependsOn,
    })),
  };
}

// ─── API request/response shapes (apps/service-planner) ──────────────────────

export const PlanOutcomeSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("planner"),
      graph: TaskGraphSchema,
      route_profile: RouteProfileResolutionSchema.optional(),
    })
    .strict(),
  z
    .object({
      source: z.literal("fallback"),
      graph: TaskGraphSchema,
      reason: z.string(),
      route_profile: RouteProfileResolutionSchema.optional(),
    })
    .strict(),
]);

export type PlanOutcome = z.infer<typeof PlanOutcomeSchema>;

export const PlanRequestSchema = z
  .object({
    goal: z.string().min(1),
    task_id: z.string().optional(),
  })
  .strict();

export type PlanRequest = z.infer<typeof PlanRequestSchema>;

export const ValidateRequestSchema = z
  .object({
    graph: PlannerGraphSchema,
  })
  .strict();

export type ValidateRequest = z.infer<typeof ValidateRequestSchema>;

export const ValidateResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      errors: z.array(z.string()),
    })
    .strict(),
]);

export type ValidateResponse = z.infer<typeof ValidateResponseSchema>;

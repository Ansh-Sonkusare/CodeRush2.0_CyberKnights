import { z } from "zod";
import { Capability, TaskGraph, TaskStep } from "../types.js";

export const PLANNER_CAPABILITIES = [
  "search",
  "extract",
  "translate",
  "rank",
  "verify",
] as const;

export const CAPABILITY_SCHEMA = z.enum(PLANNER_CAPABILITIES);

export const PLANNER_STEP_SCHEMA = z
  .object({
    id: z.string(),
    label: z.string(),
    capability: CAPABILITY_SCHEMA,
    dependsOn: z.array(z.string()).default([]),
  })
  .strict();

export const PLANNER_GRAPH_SCHEMA = z
  .object({
    task_id: z.string(),
    name: z.string(),
    goal: z.string(),
    steps: z.array(PLANNER_STEP_SCHEMA).min(1),
  })
  .strict();

export type PlannerStep = z.infer<typeof PLANNER_STEP_SCHEMA>;
export type PlannerGraph = z.infer<typeof PLANNER_GRAPH_SCHEMA>;

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
          capability: { type: "string", enum: [...PLANNER_CAPABILITIES] },
          dependsOn: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

const FORBIDDEN_KEYS = new Set([
  "budget",
  "budget_cap",
  "cap",
  "raise_cap",
  "approve_overspend",
  "scope",
  "scope_token",
  "wallet_scope",
  "grant_access",
  "allowed_wallets",
  "key",
  "secret",
  "seed",
  "token",
  "credential",
  "instruction",
  "__instruction",
  "__override",
  "agent_instruction",
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

export function plannerGraphToTaskGraph(
  graph: PlannerGraph,
  options: { budget_cap: number; task_id?: string },
): TaskGraph {
  const steps: TaskStep[] = graph.steps.map((step) => ({
    id: step.id,
    label: step.label,
    capability: step.capability as Capability,
    dependsOn: step.dependsOn,
  }));
  return {
    task_id: options.task_id ?? graph.task_id,
    name: graph.name,
    budget_cap: options.budget_cap,
    goal: graph.goal,
    steps,
  };
}

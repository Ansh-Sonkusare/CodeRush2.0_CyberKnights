import {
  PlannerGraphSchema,
  ROUTEABLE_CAPABILITIES,
  containsForbiddenKeys,
  plannerGraphToTaskGraph,
  validateGraph,
  type PlanOutcome,
  type PlannerGraph,
} from "@sentinel/schemas";
import type { LLMClient } from "@sentinel/llm-client";
import { profileForGoal } from "@sentinel/router";
import { fallbackGraphForGoal } from "./fallback.js";

export const SYSTEM_PROMPT = `You are the task planner for a policy-driven agent payment router.
You decompose a user goal into a dependency-aware task graph of paid capability calls.

The only capabilities providers sell are: ${ROUTEABLE_CAPABILITIES.join(", ")}.

Respond with a single JSON object:
{ "task_id": string, "name": string, "goal": string, "steps": [ { "id": string, "label": string, "capability": one of the capabilities above, "dependsOn": string[] } ], "route_profile"?: { "profile": "price" | "quality" | "latency" | "balanced", "source": "llm" } }

Rules:
- Every step must use exactly one of the capabilities above.
- Step ids are unique; dependsOn may only reference other step ids (a DAG — no cycles).
- Parallel steps share no dependency; a step must not depend on itself.
- Labels are imperative and under 8 words.
- route_profile is OPTIONAL. It only expresses the routing tradeoff this goal favors (price, quality, latency, or balanced); if present, "source" must be "llm". Omit it when the goal gives no clear tradeoff.
- You propose task structure ONLY. Never include any budget, price, amount, cap, scope, wallet, token, key, secret, or credential fields anywhere in the JSON. The treasury owns the budget — not you.`;

export async function planWithFallback(
  client: LLMClient,
  goal: string,
  options: { task_id?: string } = {},
): Promise<PlanOutcome> {
  const result = await client.generate<PlannerGraph>(
    `${SYSTEM_PROMPT}\n\nTask:\n${goal}`,
    PlannerGraphSchema,
  );
  if (!result.ok) {
    return {
      source: "fallback",
      graph: fallbackGraphForGoal(goal),
      reason: `planner unavailable: ${result.error.message}`,
      route_profile: { profile: profileForGoal(goal), source: "heuristic" },
    };
  }

  const forbidden = containsForbiddenKeys(result.value);
  if (forbidden !== null) {
    return {
      source: "fallback",
      graph: fallbackGraphForGoal(goal),
      reason: `planner emitted forbidden field "${forbidden.slice(1)}" — budget/scope are treasury-owned`,
      route_profile: { profile: profileForGoal(goal), source: "heuristic" },
    };
  }

  const validated = validateGraph(result.value);
  if (!validated.ok) {
    return {
      source: "fallback",
      graph: fallbackGraphForGoal(goal),
      reason: `planner graph invalid: ${validated.errors.join("; ")}`,
      route_profile: { profile: profileForGoal(goal), source: "heuristic" },
    };
  }

  // plannerGraphToTaskGraph strips route_profile, so extract it from the
  // validated graph before converting. The schema already validated it; when
  // the LLM omitted it, fall back to the goal-based heuristic.
  const routeProfile =
    validated.graph.route_profile ?? { profile: profileForGoal(goal), source: "heuristic" };
  const opts = options.task_id === undefined ? {} : { task_id: options.task_id };
  return {
    source: "planner",
    graph: plannerGraphToTaskGraph(validated.graph, opts),
    route_profile: routeProfile,
  };
}

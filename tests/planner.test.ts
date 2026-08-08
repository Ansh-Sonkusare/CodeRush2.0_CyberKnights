import { describe, expect, it } from "vitest";
import { TaskGraphSchema, z, type PlannerGraph } from "@sentinel/schemas";
import type { LLMClient } from "@sentinel/llm-client";
import { FALLBACK_GRAPH, fallbackGraphForGoal } from "../apps/service-planner/src/fallback.js";
import { planWithFallback } from "../apps/service-planner/src/planner.js";

// ─── Stubs ────────────────────────────────────────────────────────────────────
// Minimal typed stubs satisfying LLMClient — no `any`. The ok-variant stub
// parses its fixture through the caller-supplied schema (same as the real
// clients) so the generic signature is genuinely satisfied.

const failingStub: LLMClient = {
  provider: "ollama",
  model: "stub",
  generate: async () => ({
    ok: false,
    error: { kind: "unknown", message: "planner down", provider: "stub" },
  }),
};

const qualityGraph: PlannerGraph = {
  task_id: "t-9",
  name: "Rank & Verify",
  goal: "rank top 10 sources on Algorand vs Ethereum",
  steps: [
    { id: "n-search", label: "Search the web", capability: "search", dependsOn: [] },
    {
      id: "n-extract",
      label: "Extract key sources",
      capability: "extract",
      dependsOn: ["n-search"],
    },
    {
      id: "n-rank",
      label: "Rank sources",
      capability: "rank",
      dependsOn: ["n-extract"],
    },
  ],
  route_profile: { profile: "quality", source: "llm" },
};

const qualityStub: LLMClient = {
  provider: "ollama",
  model: "stub",
  generate: async <T>(_prompt: string, schema: z.ZodType<T>) => {
    const parsed = schema.safeParse(qualityGraph);
    return parsed.success
      ? { ok: true as const, value: parsed.data }
      : { ok: false as const, error: { kind: "schema", message: "stub graph invalid", provider: "stub" } };
  },
};

const idsOf = (graph: { steps: { id: string }[] }): string[] => graph.steps.map((s) => s.id);
const capsOf = (graph: { steps: { capability: string }[] }): string[] =>
  graph.steps.map((s) => s.capability);

describe("fallbackGraphForGoal", () => {
  it("builds a schema-valid search → extract → verify graph for research prompts", () => {
    const graph = fallbackGraphForGoal("research the growth of DeFi in 2026");
    expect(TaskGraphSchema.safeParse(graph).success).toBe(true);
    expect(capsOf(graph)).toEqual(["search", "extract", "verify"]);
    expect(idsOf(graph)).toEqual(["n-search", "n-extract", "n-verify"]);
    const byId = new Map(graph.steps.map((s) => [s.id, s]));
    expect(byId.get("n-search")?.dependsOn).toEqual([]);
    expect(byId.get("n-extract")?.dependsOn).toEqual(["n-search"]);
    expect(byId.get("n-verify")?.dependsOn).toEqual(["n-extract"]);
    expect(graph.goal).toContain("research the growth of DeFi in 2026");
  });

  it("keeps the 3-step wallet graph for wallet prompts", () => {
    const graph = fallbackGraphForGoal("assess wallet ALGO-TEST-000");
    expect(TaskGraphSchema.safeParse(graph).success).toBe(true);
    expect(graph).toEqual(FALLBACK_GRAPH);
    expect(capsOf(graph)).toEqual(["fetch_wallet_data", "generate_summary", "score_credit"]);
  });

  it("builds the 5-step parallel demo graph for top/rank prompts", () => {
    const graph = fallbackGraphForGoal("rank top 10 sources on Algorand vs Ethereum");
    expect(TaskGraphSchema.safeParse(graph).success).toBe(true);
    expect(idsOf(graph)).toEqual([
      "n-search",
      "n-extract",
      "n-translate",
      "n-rank",
      "n-verify",
    ]);
    expect(capsOf(graph)).toEqual(["search", "extract", "translate", "rank", "verify"]);
    const byId = new Map(graph.steps.map((s) => [s.id, s]));
    expect(byId.get("n-search")?.dependsOn).toEqual([]);
    expect(byId.get("n-extract")?.dependsOn).toEqual(["n-search"]);
    expect(byId.get("n-translate")?.dependsOn).toEqual(["n-search"]);
    expect(byId.get("n-rank")?.dependsOn).toEqual(["n-extract", "n-translate"]);
    expect(byId.get("n-verify")?.dependsOn).toEqual(["n-rank"]);
    expect(graph.goal).toBe("Rank and verify the top sources for: rank top 10 sources on Algorand vs Ethereum");
  });

  it("checks rank keywords before research keywords", () => {
    const graph = fallbackGraphForGoal("research and rank the best articles");
    expect(idsOf(graph)).toEqual([
      "n-search",
      "n-extract",
      "n-translate",
      "n-rank",
      "n-verify",
    ]);
  });

  it("matches keywords case-insensitively", () => {
    const graph = fallbackGraphForGoal("RANK TOP 5 DEFI PROJECTS");
    expect(idsOf(graph)).toEqual([
      "n-search",
      "n-extract",
      "n-translate",
      "n-rank",
      "n-verify",
    ]);
  });
});

describe("planWithFallback — fallback path", () => {
  it("falls back to the wallet graph with a heuristic balanced profile on planner failure", async () => {
    const outcome = await planWithFallback(failingStub, "assess wallet ALGO-TEST-000");
    expect(outcome.source).toBe("fallback");
    expect(outcome.graph).toEqual(FALLBACK_GRAPH);
    expect(outcome.route_profile).toEqual({ profile: "balanced", source: "heuristic" });
  });

  it("derives a price profile from a cost-focused goal on planner failure", async () => {
    const outcome = await planWithFallback(failingStub, "find the cheapest provider");
    expect(outcome.source).toBe("fallback");
    expect(outcome.route_profile).toEqual({ profile: "price", source: "heuristic" });
  });

  it("falls back to a goal-driven research graph with a heuristic profile", async () => {
    const outcome = await planWithFallback(failingStub, "research DeFi lending protocols");
    expect(outcome.source).toBe("fallback");
    expect(capsOf(outcome.graph)).toEqual(["search", "extract", "verify"]);
    expect(outcome.route_profile).toEqual({ profile: "balanced", source: "heuristic" });
  });
});

describe("planWithFallback — LLM path", () => {
  it("carries the LLM-emitted route_profile onto the planner outcome", async () => {
    const outcome = await planWithFallback(qualityStub, "rank top 10 sources on Algorand vs Ethereum");
    expect(outcome.source).toBe("planner");
    expect(outcome.route_profile).toEqual({ profile: "quality", source: "llm" });
    expect(TaskGraphSchema.safeParse(outcome.graph).success).toBe(true);
    expect(outcome.graph.task_id).toBe("t-9");
    expect(capsOf(outcome.graph)).toEqual(["search", "extract", "rank"]);
    // route_profile is stripped by plannerGraphToTaskGraph — never on the TaskGraph
    expect(outcome.graph).not.toHaveProperty("route_profile");
  });
});

import { TaskGraphSchema, type TaskGraph } from "@sentinel/schemas";

// Fallback graph used when the LLM planner is unreachable, returns malformed
// output, or tries to emit a budget/scope field. Parsed once at module load so
// a malformed fallback graph fails at boot, not mid-demo.
export const FALLBACK_GRAPH: TaskGraph = TaskGraphSchema.parse({
  task_id: "t-1",
  name: "Wallet Assessment",
  goal: "Assess this Algorand wallet: fetch its on-chain data, summarize the activity, and produce a credit score.",
  steps: [
    {
      id: "n-wallet",
      label: "Fetch wallet data",
      capability: "fetch_wallet_data",
      dependsOn: [],
    },
    {
      id: "n-summary",
      label: "Summarize activity",
      capability: "generate_summary",
      dependsOn: ["n-wallet"],
    },
    {
      id: "n-credit",
      label: "Score creditworthiness",
      capability: "score_credit",
      dependsOn: ["n-summary"],
    },
  ],
});

// Keyword sets driving goal-specific fallback graphs. Matched case-insensitively
// against the user goal; RANK_KEYWORDS are checked first so "rank"/"top" prompts
// keep the parallel demo graph instead of the sequential research one.
const RANK_KEYWORDS = ["top", "rank", "best", "compare", "versus", "vs"];
const RESEARCH_KEYWORDS = [
  "research",
  "news",
  "report",
  "article",
  "read",
  "study",
  "analyze",
];

// MVD 5-step parallel demo graph: search → extract ‖ translate → rank → verify.
// Static structure parsed at module load; the goal text is per-run.
const RANK_FALLBACK_GRAPH: TaskGraph = TaskGraphSchema.parse({
  task_id: "t-3",
  name: "Rank & Verify Sources",
  goal: "Rank and verify the top sources for this goal.",
  steps: [
    { id: "n-search", label: "Search the web", capability: "search", dependsOn: [] },
    {
      id: "n-extract",
      label: "Extract key sources",
      capability: "extract",
      dependsOn: ["n-search"],
    },
    {
      id: "n-translate",
      label: "Translate sources",
      capability: "translate",
      dependsOn: ["n-search"],
    },
    {
      id: "n-rank",
      label: "Rank sources",
      capability: "rank",
      dependsOn: ["n-extract", "n-translate"],
    },
    { id: "n-verify", label: "Verify findings", capability: "verify", dependsOn: ["n-rank"] },
  ],
});

// Sequential research graph: search → extract → verify.
const RESEARCH_FALLBACK_GRAPH: TaskGraph = TaskGraphSchema.parse({
  task_id: "t-2",
  name: "Research & Verify",
  goal: "Research and verify sources for this topic.",
  steps: [
    { id: "n-search", label: "Search the web", capability: "search", dependsOn: [] },
    {
      id: "n-extract",
      label: "Extract key sources",
      capability: "extract",
      dependsOn: ["n-search"],
    },
    {
      id: "n-verify",
      label: "Verify findings",
      capability: "verify",
      dependsOn: ["n-extract"],
    },
  ],
});

/**
 * Goal-driven fallback graph for when the LLM planner is unavailable or its
 * output can't be trusted. Rank/compare goals get the MVD 5-step parallel graph
 * (search → extract ‖ translate → rank → verify); research/news goals get a
 * sequential search → extract → verify; everything else (default: wallet
 * assessment) keeps the static 3-step FALLBACK_GRAPH. All structures are parsed
 * through TaskGraphSchema at module load, so a malformed graph fails at boot.
 */
export function fallbackGraphForGoal(goal: string): TaskGraph {
  const lower = goal.toLowerCase();
  if (RANK_KEYWORDS.some((k) => lower.includes(k))) {
    return { ...RANK_FALLBACK_GRAPH, goal: `Rank and verify the top sources for: ${goal}` };
  }
  if (RESEARCH_KEYWORDS.some((k) => lower.includes(k))) {
    return { ...RESEARCH_FALLBACK_GRAPH, goal: `Research and verify sources for: ${goal}` };
  }
  return FALLBACK_GRAPH;
}

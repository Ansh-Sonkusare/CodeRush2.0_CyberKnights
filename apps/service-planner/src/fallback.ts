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

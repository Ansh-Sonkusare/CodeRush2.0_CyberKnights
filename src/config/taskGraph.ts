import { TaskGraph } from "../types.js";

export const TASK_GRAPH: TaskGraph = {
  task_id: "t-1",
  name: "Research & Translation Report",
  budget_cap: 0.5,
  goal: "Search the web for the latest x402 payment specs, extract + translate the top result into English, rank the sources by relevance, and verify the final answer.",
  steps: [
    {
      id: "n-search",
      label: "Search sources",
      capability: "search",
      dependsOn: [],
    },
    {
      id: "n-extract",
      label: "Extract top result",
      capability: "extract",
      dependsOn: ["n-search"],
    },
    {
      id: "n-translate",
      label: "Translate to English",
      capability: "translate",
      dependsOn: ["n-search"],
    },
    {
      id: "n-rank",
      label: "Rank sources",
      capability: "rank",
      dependsOn: ["n-extract", "n-translate"],
    },
    {
      id: "n-verify",
      label: "Verify answer",
      capability: "verify",
      dependsOn: ["n-rank"],
    },
  ],
};

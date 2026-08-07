import { startAllProviders, stopAllProviders, ServerHandle } from "./start-providers.js";
import { Ledger } from "../src/ledger/ledger.js";
import { SimulatedWallet } from "../src/wallet/wallet.js";
import { Treasury } from "../src/treasury/treasury.js";
import { TaskExecutor, ExecutionSummary } from "../src/engine/executor.js";
import { BanditOptimizer } from "../src/engine/banditOptimizer.js";
import { TASK_GRAPH } from "../src/config/taskGraph.js";

const LINE = "─".repeat(78);
const money = (n: number) => `$${n.toFixed(4)}`;

function printSummary(summary: ExecutionSummary, label: string): void {
  console.log(`\n  ${label}: status=${summary.status}  spent=${money(summary.budget.spent)}`);
  console.log(`  ${"node".padEnd(12)}${"provider".padEnd(12)}status`);
  for (const e of summary.steps) {
    console.log(`${e.step.id.padEnd(12)}${(e.providerId ?? "-").padEnd(12)}${e.status}`);
  }
}

async function runOnce(
  ledger: Ledger,
  label: string,
  useBandit: boolean | BanditOptimizer,
): Promise<ExecutionSummary> {
  const wallet = new SimulatedWallet();
  const treasury = new Treasury(TASK_GRAPH.task_id, TASK_GRAPH.budget_cap);
  const ex = new TaskExecutor({ ledger, wallet, treasury, graph: TASK_GRAPH, useBandit });
  const summary = await ex.run();
  printSummary(summary, label);
  return summary;
}

async function main(): Promise<void> {
  console.log("=== PHASE 5 — UCB1 bandit wired into the executor (real HTTP, live learning) ===");
  let handles: ServerHandle[] = [];
  try {
    handles = await startAllProviders({ tolerateBusy: true });
    console.log("providers up:", handles.map((h) => `${h.providerId}@${h.port}`).join(", "));

    const ledger = new Ledger(true);
    await ledger.init();

    console.log(`\n${LINE}`);
    console.log("RUN 1 — baseline (static weighted routing, no learning)");
    await ledger.reset();
    const baseline = await runOnce(ledger, "baseline", false);
    console.log("\n  baseline route reasons:");
    for (const e of baseline.steps) {
      console.log(`    ${e.step.id.padEnd(12)}${e.routeReason}`);
    }

    console.log(`\n${LINE}`);
    console.log("RUNS 2..7 — bandit mode, ONE shared BanditOptimizer (learns across runs)");
    const shared = new BanditOptimizer();
    const picksByRun: string[][] = [];
    let lastBandit: ExecutionSummary | undefined;
    for (let i = 2; i <= 7; i++) {
      await ledger.reset();
      const summary = await runOnce(ledger, `bandit run ${i}`, shared);
      picksByRun.push(summary.steps.map((e) => e.providerId ?? "-"));
      lastBandit = summary;
    }

    console.log(`\n${LINE}`);
    console.log("  bandit picks per run  (explore -> exploit):");
    console.log(`  ${"run".padEnd(7)}${"n-search".padEnd(12)}${"n-extract".padEnd(12)}${"n-translate".padEnd(13)}${"n-rank".padEnd(12)}${"n-verify".padEnd(10)}`);
    picksByRun.forEach((picks, i) => {
      console.log(`  run${(i + 2).toString().padEnd(3)}${picks.map((p) => p.padEnd(12)).join("")}`);
    });

    console.log(`\n${LINE}`);
    console.log("  final bandit route reasons (should show UCB1 scores, not EXPLORING):");
    for (const e of lastBandit?.steps ?? []) {
      console.log(`    ${e.step.id.padEnd(12)}${e.routeReason}`);
    }

    console.log(`\n${LINE}`);
    console.log("  bandit arm stats after 6 real tasks (learned from wall-clock latency + price):");
    for (const [cap, arms] of Object.entries(shared.getStats())) {
      const line = Object.entries(arms)
        .map(([pid, a]) => `${pid}: ${a.n_pulls} pulls, mean_reward=${a.mean_reward.toFixed(4)}`)
        .join("   ");
      console.log(`    ${cap.padEnd(10)}${line}`);
    }

    console.log(`\n${LINE}`);
    console.log("PHASE 5 checkpoint: executor routed with useBandit, learned across runs.");
    console.log(`  evidence: ${picksByRun.length} bandit tasks completed; shared bandit holds ${Object.keys(shared.getStats()).length} capabilities of arm stats.`);
  } finally {
    if (handles.length) await stopAllProviders(handles);
  }
}

main().catch((err) => {
  console.error("phase 5 demo failed:", err);
  process.exitCode = 1;
});

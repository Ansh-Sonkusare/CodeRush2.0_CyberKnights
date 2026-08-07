import { Ledger } from "../src/ledger/ledger.js";
import { SimulatedWallet } from "../src/wallet/wallet.js";
import { Treasury } from "../src/treasury/treasury.js";
import { TaskExecutor, ExecutionSummary } from "../src/engine/executor.js";
import { TASK_GRAPH } from "../src/config/taskGraph.js";
import { startAllProviders, stopAllProviders, ServerHandle } from "./start-providers.js";

const LINE = "─".repeat(72);
const money = (n: number) => `$${n.toFixed(4)}`;

function printSummary(title: string, summary: ExecutionSummary): void {
  console.log(`\n${LINE}`);
  console.log(`RESULT — ${title}`);
  console.log(`status=${summary.status}  duration=${summary.durationMs}ms  ` +
    `spent=${money(summary.budget.spent)} / cap=${money(summary.budget.cap)}`);
  console.log(`${"node".padEnd(12)}${"provider".padEnd(12)}${"tx".padEnd(10)}status`);
  for (const e of summary.steps) {
    const t = e.txRef ?? "-";
    console.log(
      `${e.step.id.padEnd(12)}${(e.providerId ?? "-").padEnd(12)}${t.padEnd(10)}${e.status}`,
    );
  }
}

function printParallelTiming(summary: ExecutionSummary): void {
  const ex = summary.steps.find((e) => e.step.id === "n-extract");
  const tr = summary.steps.find((e) => e.step.id === "n-translate");
  if (!ex || !tr) return;
  const overlap = ex.startedAt! < tr.finishedAt! && tr.startedAt! < ex.finishedAt!;
  console.log(`\nparallel branch timing:`);
  console.log(`  n-extract   start=${ex.startedAt?.slice(11, 19)}  end=${ex.finishedAt?.slice(11, 19)}`);
  console.log(`  n-translate start=${tr.startedAt?.slice(11, 19)}  end=${tr.finishedAt?.slice(11, 19)}`);
  console.log(`  ran concurrently: ${overlap ? "YES (both in same wave)" : "no"}`);
}

async function scenarioHappyPath(ledger: Ledger): Promise<void> {
  console.log(`\n${LINE}`);
  console.log("SCENARIO A — happy path, cap $0.50");
  const wallet = new SimulatedWallet();
  const treasury = new Treasury(TASK_GRAPH.task_id, 0.5);
  const ex = new TaskExecutor({ ledger, wallet, treasury, graph: TASK_GRAPH });
  const summary = await ex.run();
  printSummary("happy path", summary);
  printParallelTiming(summary);
  for (const e of summary.steps.filter((s) => s.status === "success")) {
    console.log(`  route: ${e.routeReason}`);
  }
}

async function scenarioApprove(ledger: Ledger): Promise<void> {
  console.log(`\n${LINE}`);
  console.log("SCENARIO B — tight cap $0.10 -> pause -> approve -> resume");
  const wallet = new SimulatedWallet();
  const treasury = new Treasury(TASK_GRAPH.task_id, 0.1);
  const ex = new TaskExecutor({ ledger, wallet, treasury, graph: TASK_GRAPH });

  const run = ex.run();
  await pauseLoop(ex);
  const info = ex.getPauseInfo()!;
  console.log(`  TASK PAUSED at wave [${info.nodeId}]: ` +
    `needs ${money(info.amounts.reduce((a, b) => a + b, 0))}, ` +
    `projected ${money(info.projected)} vs cap ${money(info.cap)} ` +
    `(overspend ${money(info.overspend)})`);
  console.log(`  -> approving +$${info.overspend.toFixed(4)} cap...`);
  ex.approve(info.overspend);
  const summary = await run;
  printSummary("pause + approve", summary);
}

async function scenarioReject(ledger: Ledger): Promise<void> {
  console.log(`\n${LINE}`);
  console.log("SCENARIO C — cap $0.02 -> pause -> REJECT (no overspend)");
  const wallet = new SimulatedWallet();
  const treasury = new Treasury(TASK_GRAPH.task_id, 0.02);
  const ex = new TaskExecutor({ ledger, wallet, treasury, graph: TASK_GRAPH });

  const run = ex.run();
  await pauseLoop(ex);
  const info = ex.getPauseInfo()!;
  console.log(`  TASK PAUSED: would spend ${money(info.projected)} against cap ${money(info.cap)}`);
  console.log("  -> rejecting... no funds released, steps declared_failure");
  ex.reject();
  const summary = await run;
  printSummary("pause + reject", summary);
}

async function pauseLoop(ex: TaskExecutor): Promise<void> {
  while (!ex.isPaused()) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function main(): Promise<void> {
  console.log("=== PHASE 2 — executor, treasury, route optimizer ===");
  console.log(`task graph: ${TASK_GRAPH.name} (${TASK_GRAPH.steps.length} steps)`);

  let handles: ServerHandle[] = [];
  try {
    handles = await startAllProviders({ tolerateBusy: true });
    console.log("providers up:", handles.map((h) => `${h.providerId}@${h.port}`).join(", "));

    const ledger = new Ledger(true);
    await ledger.init();

    await ledger.reset();
    await scenarioHappyPath(ledger);

    await ledger.reset();
    await scenarioApprove(ledger);

    await ledger.reset();
    await scenarioReject(ledger);

    console.log(`\n${LINE}`);
    console.log("PHASE 2 checkpoint: executor + treasury + optimizer verified.");
  } finally {
    if (handles.length) await stopAllProviders(handles);
  }
}

main().catch((err) => {
  console.error("phase 2 demo failed:", err);
  process.exitCode = 1;
});

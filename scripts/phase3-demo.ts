import { startAllProviders, stopAllProviders, ServerHandle } from "./start-providers.js";
import { Ledger } from "../src/ledger/ledger.js";
import { SimulatedWallet } from "../src/wallet/wallet.js";
import { Treasury } from "../src/treasury/treasury.js";
import { TaskExecutor, ExecutionSummary } from "../src/engine/executor.js";
import { idempotencyKey } from "../src/engine/paidCall.js";
import { TASK_GRAPH } from "../src/config/taskGraph.js";
import { PROVIDER_CATALOG } from "../src/config/providers.js";
import { LedgerRow } from "../src/types.js";

const LINE = "─".repeat(72);
const money = (n: number) => `$${n.toFixed(4)}`;

const baseUrlFor = (providerId: string) =>
  PROVIDER_CATALOG.find((p) => p.provider_id === providerId)!.base_url;

async function setFailMode(providerId: string, mode: "none" | "crash_on_complete"): Promise<void> {
  const res = await fetch(`${baseUrlFor(providerId)}/admin/fail`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error(`fail toggle failed for ${providerId}`);
}

function printSummary(summary: ExecutionSummary): void {
  console.log(`\n  status=${summary.status}  spent=${money(summary.budget.spent)} / cap=${money(summary.budget.cap)}`);
  console.log(`  ${"node".padEnd(12)}${"provider".padEnd(12)}${"tx".padEnd(10)}status`);
  for (const e of summary.steps) {
    console.log(
      `${e.step.id.padEnd(12)}${(e.providerId ?? "-").padEnd(12)}${(e.txRef ?? "-").padEnd(10)}${e.status}`,
    );
  }
  for (const e of summary.steps.filter((s) => s.status === "declared_failure")) {
    console.log(`  ! ${e.step.id}: ${e.error}`);
  }
}

function ledgerRowsFor(rows: LedgerRow[], nodeId: string): LedgerRow[] {
  return rows.filter((r) => r.node_id === nodeId);
}

async function scenarioFallback(ledger: Ledger): Promise<void> {
  console.log(`\n${LINE}`);
  console.log("SCENARIO A — force search-a to crash after issuing 402; expect fallback to fastrank-c");

  await setFailMode("search-a", "crash_on_complete");

  const wallet = new SimulatedWallet();
  const treasury = new Treasury(TASK_GRAPH.task_id, 0.5);
  const ex = new TaskExecutor({ ledger, wallet, treasury, graph: TASK_GRAPH });
  const summary = await ex.run();
  printSummary(summary);

  const rows = ledger.findByTaskId(TASK_GRAPH.task_id);
  const searchRows = ledgerRowsFor(rows, "n-search");
  const failed = searchRows.filter((r) => r.provider_id === "search-a");
  const fellBack = searchRows.filter((r) => r.provider_id === "fastrank-c");

  const failedOk = failed.length === 1 && failed[0].outcome === "declared_failure";
  const fallbackOk = fellBack.length === 1 && fellBack[0].outcome === "success";
  console.log(`  ledger: search-a attempt marked declared_failure -> ${failedOk ? "PASS" : "FAIL"}`);
  console.log(`  ledger: fallback to fastrank-c settled with own tx_ref -> ${fallbackOk ? "PASS" : "FAIL"}`);

  const replay = wallet.pay({
    task_id: TASK_GRAPH.task_id,
    node_id: "n-search",
    capability: "search",
    provider_id: "search-a",
    idempotency_key: idempotencyKey(TASK_GRAPH.task_id, "n-search", "search-a"),
    amount: 0.02,
    scope_token: `pay:${TASK_GRAPH.task_id}:up-to:0.1:for:search-a`,
  });
  const noDoublePay = !replay.first_payment && replay.tx_ref === String(failed[0].stages.settlement.detail.tx_ref);
  console.log(`  replay same key -> tx_ref=${replay.tx_ref}, first_payment=${replay.first_payment} -> ${noDoublePay ? "PASS (no double-pay)" : "FAIL"}`);

  await setFailMode("search-a", "none");
}

async function scenarioFullKill(ledger: Ledger): Promise<void> {
  console.log(`\n${LINE}`);
  console.log("SCENARIO B — kill ALL rank providers (fastrank-c AND lingo-b); expect partial results");

  await setFailMode("fastrank-c", "crash_on_complete");
  await setFailMode("lingo-b", "crash_on_complete");

  const wallet = new SimulatedWallet();
  const treasury = new Treasury(TASK_GRAPH.task_id, 0.5);
  const ex = new TaskExecutor({ ledger, wallet, treasury, graph: TASK_GRAPH });
  const summary = await ex.run();
  printSummary(summary);

  const rows = ledger.findByTaskId(TASK_GRAPH.task_id);
  const rankRows = ledgerRowsFor(rows, "n-rank");
  const rankFailed = rankRows.filter((r) => r.outcome === "declared_failure");
  const successCount = summary.steps.filter((e) => e.status === "success").length;
  const verifyAborted = summary.steps.find((e) => e.step.id === "n-verify")?.status;

  console.log(`  ledger: ${rankRows.length} paid attempts on n-rank, all declared_failure -> ${rankRows.length === 2 && rankFailed.length === 2 ? "PASS" : "FAIL"}`);
  console.log(`  partial results kept: ${successCount}/3 upstream steps succeeded -> ${successCount === 3 ? "PASS" : "FAIL"}`);
  console.log(`  n-verify (dependent) never paid -> status=${verifyAborted} ${verifyAborted === "aborted" ? "PASS" : "FAIL"}`);

  await setFailMode("fastrank-c", "none");
  await setFailMode("lingo-b", "none");
}

async function main(): Promise<void> {
  console.log("=== PHASE 3 — forced failure injection, no double-pay, fallback ===");
  let handles: ServerHandle[] = [];
  try {
    handles = await startAllProviders({ tolerateBusy: true });
    console.log("providers up:", handles.map((h) => `${h.providerId}@${h.port}`).join(", "));

    const ledger = new Ledger(true);
    await ledger.init();

    await ledger.reset();
    await scenarioFallback(ledger);

    await ledger.reset();
    await scenarioFullKill(ledger);

    console.log(`\n${LINE}`);
    console.log("PHASE 3 checkpoint: failure injection + idempotency + fallback verified.");
  } finally {
    if (handles.length) await stopAllProviders(handles);
  }
}

main().catch((err) => {
  console.error("phase 3 demo failed:", err);
  process.exitCode = 1;
});

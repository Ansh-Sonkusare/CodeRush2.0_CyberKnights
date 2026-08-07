import { startAllProviders, stopAllProviders, ServerHandle } from "./start-providers.js";
import { Ledger } from "../src/ledger/ledger.js";
import { SCHEMA_VERSION } from "../src/ledger/schema.js";
import { SimulatedWallet } from "../src/wallet/wallet.js";
import { TASK_GRAPH } from "../src/config/taskGraph.js";
import { pickProvider } from "../src/engine/routeOptimizer.js";
import { runPaidCall, idempotencyKey } from "../src/engine/paidCall.js";
import { LedgerRow } from "../src/types.js";

function printTable(rows: LedgerRow[]): void {
  const header = ["NODE", "PROVIDER", "TX_REF", "OUTCOME"].join("\t");
  const lines = rows.map((r) => {
    const tx = r.stages.settlement.detail.tx_ref ?? "-";
    return [r.node_id, r.provider_id, String(tx), r.outcome].join("\t");
  });
  console.log(header);
  console.log(lines.join("\n"));
}

async function main(): Promise<void> {
  let handles: ServerHandle[] = [];
  try {
    console.log(`=== Phase 1 smoke test (schema v${SCHEMA_VERSION}) ===`);
    handles = await startAllProviders({ tolerateBusy: true });
    console.log(
      "providers up:",
      handles.map((h) => `${h.providerId}@${h.port}`).join(", "),
    );

    const ledger = new Ledger(true);
    await ledger.init();
    await ledger.reset();
    const wallet = new SimulatedWallet();

    for (const step of TASK_GRAPH.steps) {
      const decision = pickProvider(step.capability);
      await runPaidCall({
        ledger,
        wallet,
        task_id: TASK_GRAPH.task_id,
        node_id: step.id,
        capability: step.capability,
        goal: TASK_GRAPH.goal,
        provider_id: decision.provider.provider_id,
        scope_token: `pay:${TASK_GRAPH.task_id}:up-to:0.1:for:${decision.provider.provider_id}`,
        scope_max: 0.1,
        route_reason: decision.reason,
      });
    }

    // ---- Idempotency assertion: replay a payment, must not double-settle ----
    const replay = wallet.pay({
      task_id: TASK_GRAPH.task_id,
      node_id: "n-search",
      capability: "search",
      provider_id: "search-a",
      idempotency_key: idempotencyKey(TASK_GRAPH.task_id, "n-search", "search-a"),
      amount: 0.02,
      scope_token: `pay:${TASK_GRAPH.task_id}:up-to:0.1:for:search-a`,
    });
    const idemOk = !replay.first_payment && replay.tx_ref === "sim-0001";
    console.log(`idempotency replay: first_payment=${replay.first_payment}, tx_ref=${replay.tx_ref} -> ${idemOk ? "PASS (no double-pay)" : "FAIL"}`);

    const scopeSpent =
      wallet.getScope(`pay:${TASK_GRAPH.task_id}:up-to:0.1:for:search-a`)?.spent ?? 0;
    console.log(`scope spent for search-a: $${scopeSpent.toFixed(4)} (max $0.10)`);

    const rows = ledger.findByTaskId(TASK_GRAPH.task_id);
    console.log(`\nledger rows for ${TASK_GRAPH.task_id}: ${rows.length}`);
    printTable(rows);

    const trace = await ledger.exportTask(
      TASK_GRAPH.task_id,
      `data/trace-${TASK_GRAPH.task_id}.json`,
    );
    console.log(`\ntrace exported (${trace.length} bytes) -> data/trace-${TASK_GRAPH.task_id}.json`);
  } finally {
    if (handles.length) await stopAllProviders(handles);
  }
}

main().catch((err) => {
  console.error("smoke test failed:", err);
  process.exitCode = 1;
});

import { startAllProviders, stopAllProviders, ServerHandle } from "./start-providers.js";
import { Ledger } from "../src/ledger/ledger.js";
import { SimulatedWallet } from "../src/wallet/wallet.js";
import { TASK_GRAPH } from "../src/config/taskGraph.js";
import { pickProvider } from "../src/engine/routeOptimizer.js";
import { runPaidCall, PaidCallResult } from "../src/engine/paidCall.js";

const LINE = "─".repeat(72);

function money(n: number): string {
  return `$${n.toFixed(4)}`;
}

async function main(): Promise<void> {
  let handles: ServerHandle[] = [];
  try {
    console.log(LINE);
    console.log(`PREVIEW  ${TASK_GRAPH.name}`);
    console.log(`task: ${TASK_GRAPH.task_id}   budget cap: ${money(TASK_GRAPH.budget_cap)}`);
    console.log(`goal: ${TASK_GRAPH.goal}`);
    console.log(LINE);

    handles = await startAllProviders({ tolerateBusy: true });
    console.log(
      `mock x402 providers online: ${handles.map((h) => `${h.providerId}@${h.port}`).join(", ")}`,
    );

    const ledger = new Ledger(true);
    await ledger.init();
    await ledger.reset();
    const wallet = new SimulatedWallet();

    let totalSpent = 0;

    for (const step of TASK_GRAPH.steps) {
      const decision = pickProvider(step.capability);
      const provider = decision.provider;
      const scopeToken = `pay:${TASK_GRAPH.task_id}:up-to:0.1:for:${provider.provider_id}`;
      console.log(`\n${LINE}`);
      console.log(`STEP [${step.id}] ${step.label}  ->  ${provider.provider_id} (${provider.capability})`);
      console.log(`route reason: ${decision.reason}`);

      const res: PaidCallResult = await runPaidCall({
        ledger,
        wallet,
        task_id: TASK_GRAPH.task_id,
        node_id: step.id,
        capability: step.capability,
        goal: TASK_GRAPH.goal,
        provider_id: provider.provider_id,
        scope_token: scopeToken,
        scope_max: 0.1,
        route_reason: decision.reason,
      });
      totalSpent += res.settlement.amount;

      console.log(`  1. invoice  -> HTTP 402: price=${money(Number(res.terms.price))}, schema=${res.terms.schema}`);
      console.log(`  2. payment  -> scope token ok, sent ${money(res.settlement.amount)}`);
      console.log(`  3. settle   -> tx_ref=${res.settlement.tx_ref} (first_payment=${res.settlement.first_payment})`);
      console.log(`  4. response -> ${JSON.stringify(res.response)}`);
      console.log(`  5. receipt  -> ${JSON.stringify(res.receipt)}`);
      console.log(`  ledger row: ${res.ledgerId}  outcome=success`);
    }

    // Idempotency demo: replay the first payment with the same idempotency key
    console.log(`\n${LINE}`);
    console.log("IDEMPOTENCY DEMO — replaying the search payment with the same key:");
    const replay = wallet.pay({
      task_id: TASK_GRAPH.task_id,
      node_id: "n-search",
      capability: "search",
      provider_id: "search-a",
      idempotency_key: `ik-${TASK_GRAPH.task_id}-n-search-search-a`,
      amount: 0.02,
      scope_token: `pay:${TASK_GRAPH.task_id}:up-to:0.1:for:search-a`,
    });
    console.log(`  replay returned tx_ref=${replay.tx_ref} with first_payment=${replay.first_payment}`);
    console.log(`  -> ${replay.first_payment ? "DOUBLE PAY (BAD)" : "NO double-pay: original settlement returned (GOOD)"}`);

    const rows = ledger.findByTaskId(TASK_GRAPH.task_id);
    console.log(`\n${LINE}`);
    console.log(`LEDGER SUMMARY — ${rows.length} paid calls for task ${TASK_GRAPH.task_id}`);
    console.log(`${"node".padEnd(12)}${"provider".padEnd(12)}${"tx_ref".padEnd(10)}outcome`);
    for (const r of rows) {
      console.log(
        `${r.node_id.padEnd(12)}${r.provider_id.padEnd(12)}${String(r.stages.settlement.detail.tx_ref ?? "-").padEnd(10)}${r.outcome}`,
      );
    }
    console.log(`\ntotal spent: ${money(totalSpent)}  (budget cap: ${money(TASK_GRAPH.budget_cap)})`);

    const trace = await ledger.exportTask(
      TASK_GRAPH.task_id,
      `data/trace-${TASK_GRAPH.task_id}.json`,
    );
    console.log(`\ntrace exported (${trace.length} bytes) -> data/trace-${TASK_GRAPH.task_id}.json`);
    console.log(LINE);
  } finally {
    if (handles.length) await stopAllProviders(handles);
  }
}

main().catch((err) => {
  console.error("preview failed:", err);
  process.exitCode = 1;
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Capability,
  type DeliverResponse,
  type MicroAlgo,
  type PlanOutcome,
  type ProviderAdapter,
  type QuoteResponse,
  type WsMessage,
  microAlgo,
  type NodeState,
} from "@sentinel/schemas";
import { createLedgerStore, type LedgerStore } from "@sentinel/ledger";
import { createRouter } from "@sentinel/router";
import { createTaskRunner, type TaskRunner } from "@sentinel/orchestrator";
import { SimulatedX402Client } from "@sentinel/x402-client";

// ─── MVD — 5-step parallel pipeline (search → extract ‖ translate → rank → verify) ──
// End-to-end runs against in-process engines using the same createTaskRunner
// entry point as apps/service-orchestrator. Covers the MVD criteria:
//   1. 5-step parallel run with timestamps showing extract ‖ translate overlap
//   2. fail-after-402 reroute → backup with a FRESH idempotency key (no double-spend)
//   3. sub-budget pause → operator approve → full settlement
//   4. reconcile: every paid request tied to a result or a declared failure
//   5. stale-quote and >25% price-drift guards at pay time → exclude + re-route
//   6. "upto" payment scheme wired into the invoice + settlement stage detail

const MVD_GOAL =
  "Research the top Algorand DeFi protocols: search, extract, translate, rank, and verify every claim.";

const MVD_GRAPH_STEPS: { id: string; label: string; capability: Capability; dependsOn: string[] }[] = [
  { id: "n-search", label: "Search the web", capability: "search", dependsOn: [] },
  { id: "n-extract", label: "Extract key sources", capability: "extract", dependsOn: ["n-search"] },
  { id: "n-translate", label: "Translate sources", capability: "translate", dependsOn: ["n-search"] },
  {
    id: "n-rank",
    label: "Rank sources",
    capability: "rank",
    dependsOn: ["n-extract", "n-translate"],
  },
  { id: "n-verify", label: "Verify findings", capability: "verify", dependsOn: ["n-rank"] },
];

const PRIMARY = [
  { providerId: "mock-search", capability: "search" as Capability, price: 2n },
  { providerId: "mock-extract", capability: "extract" as Capability, price: 3n },
  { providerId: "mock-translate", capability: "translate" as Capability, price: 3n },
  { providerId: "mock-rank", capability: "rank" as Capability, price: 4n },
  { providerId: "mock-verify", capability: "verify" as Capability, price: 2n },
];

const BACKUP = [
  { providerId: "mock-search-backup", capability: "search" as Capability, price: 5n },
  { providerId: "mock-extract-backup", capability: "extract" as Capability, price: 4n },
  { providerId: "mock-translate-backup", capability: "translate" as Capability, price: 5n },
  { providerId: "mock-rank-backup", capability: "rank" as Capability, price: 6n },
  { providerId: "mock-verify-backup", capability: "verify" as Capability, price: 4n },
];

type ResultFactory = (
  invoiceId: string,
  paymentRef: string,
  input: Record<string, unknown>,
) => Record<string, unknown>;

function defaultResult(capability: Capability): ResultFactory {
  return () => {
    switch (capability) {
      case "search":
        return { urls: ["https://algorand.foundation/"], snippets: ["Algorand — official site"] };
      case "extract":
        return { title: "Algorand", body: "A carbon-negative proof-of-stake blockchain.", word_count: 5 };
      case "translate":
        return { original: "hello", translated: "hola", language: "es" };
      case "rank":
        return { ranked: [{ url: "https://algorand.foundation/", score: 0.9 }], sources_considered: [] };
      case "verify":
        return { verified: true, confidence: 0.99, checks: ["source-check"] };
      default:
        return {};
    }
  };
}

interface MvdProviderOverrides {
  role?: "primary" | "backup";
  qualityScore?: number;
  latencyHintMs?: number;
  scheme?: "exact" | "upto";
  uptoActual?: bigint;
  failMode?: "after_402";
  /** Quote with already-expired terms (pay-time stale-quote guard). */
  staleQuote?: boolean;
  /** Quote a different price than the advertised hint (price-drift guard). */
  driftPrice?: bigint;
  result?: ResultFactory;
}

function mvdProvider(
  providerId: string,
  capability: Capability,
  price: bigint,
  overrides: MvdProviderOverrides = {},
): ProviderAdapter {
  const {
    role = "primary",
    qualityScore = 0.9,
    latencyHintMs = 60,
    scheme,
    uptoActual,
    failMode,
    staleQuote,
    driftPrice,
    result,
  } = overrides;
  const produce = result ?? defaultResult(capability);

  return {
    providerId,
    capability,
    priceHint: microAlgo(price),
    latencyHintMs,
    qualityScore,
    baseUrl: `https://mock.${providerId}.invalid`,
    role,
    ...(scheme !== undefined ? { scheme } : {}),
    ...(uptoActual !== undefined ? { uptoActual } : {}),
    ...(failMode !== undefined ? { failMode } : {}),
    async quote(): Promise<{ ok: true; value: QuoteResponse }> {
      return {
        ok: true,
        value: {
          invoice_id: `inv-${providerId}`,
          provider_id: providerId,
          capability,
          price: Number(driftPrice ?? price),
          currency: "uAlgo",
          schema: "x402@0.1",
          terms_expires_at: staleQuote
            ? new Date(Date.now() - 5_000).toISOString()
            : new Date(Date.now() + 60_000).toISOString(),
          payment_required: true,
        },
      };
    },
    async deliver(
      invoiceId: string,
      paymentRef: string,
      input?: Record<string, unknown>,
    ): Promise<{ ok: true; value: DeliverResponse }> {
      return {
        ok: true,
        value: {
          result: produce(invoiceId, paymentRef, input ?? {}),
          receipt: {
            receipt_id: `r-${paymentRef}`,
            tx_ref: paymentRef,
            provider_id: providerId,
            settled_at: new Date().toISOString(),
            already_settled: false,
          },
        },
      };
    },
    async health() {
      return { ok: true };
    },
  };
}

function defaultProviders(): ProviderAdapter[] {
  return [
    ...PRIMARY.map(({ providerId, capability, price }) => mvdProvider(providerId, capability, price)),
    ...BACKUP.map(({ providerId, capability, price }) =>
      mvdProvider(providerId, capability, price, { role: "backup", qualityScore: 0.8 }),
    ),
  ];
}

function planGraph(taskIdValue: string): PlanOutcome {
  return {
    source: "planner",
    graph: {
      task_id: taskIdValue,
      name: "rank-and-verify",
      goal: MVD_GOAL,
      steps: MVD_GRAPH_STEPS,
    },
  };
}

interface MvdFixture {
  runner: TaskRunner;
  ledger: LedgerStore;
  messages: WsMessage[];
  tmpDir: string;
}

function makeFixture(adapters: ProviderAdapter[]): MvdFixture {
  const tmpDir = mkdtempSync(join(tmpdir(), "sentinel-mvd-"));
  const ledger = createLedgerStore(join(tmpDir, "ledger.db"));
  const messages: WsMessage[] = [];
  const router = createRouter(adapters);
  const runner = createTaskRunner({
    x402: new SimulatedX402Client(),
    ledger,
    router: () => router,
    adapters: () => adapters,
    plan: async (goal, taskIdValue) => planGraph(taskIdValue),
    broadcast: (msg) => messages.push(msg),
  });
  return { runner, ledger, messages, tmpDir };
}

async function waitForTerminal(
  runner: TaskRunner,
  taskIdValue: string,
  timeoutMs = 10_000,
): Promise<"completed" | "aborted"> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = runner.status(taskIdValue);
    if (status && status.status !== "planning" && status.status !== "executing" && status.status !== "paused") {
      return status.status as "completed" | "aborted";
    }
    if (Date.now() > deadline) {
      throw new Error(
        `task ${taskIdValue} did not reach a terminal state: ${JSON.stringify(status)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function waitForStatus(
  runner: TaskRunner,
  taskIdValue: string,
  status: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = runner.status(taskIdValue);
    if (current?.status === status) return;
    if (Date.now() > deadline) {
      throw new Error(`task ${taskIdValue} never reached "${status}": ${JSON.stringify(current)}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** First `at` timestamp of a node_state broadcast for `nodeId` in `kind`. */
function firstNodeStateAt(
  messages: WsMessage[],
  nodeId: string,
  kind: NodeState["kind"],
): number | undefined {
  const hit = messages.find(
    (m) => m.event === "node_state" && m.nodeId === nodeId && m.state.kind === kind,
  );
  if (hit?.event !== "node_state") return undefined;
  return new Date(hit.at).getTime();
}

describe("MVD — 5-step parallel pipeline", () => {
  it("settles all five steps; extract and translate run in parallel after search", async () => {
    const fixture = makeFixture(defaultProviders());
    try {
      const { runner, ledger, messages } = fixture;
      const { taskId: runTaskId } = await runner.run({ goal: MVD_GOAL, cap: "1000" });
      const final = await waitForTerminal(runner, runTaskId);
      expect(final).toBe("completed");

      const nodes = runner.status(runTaskId)?.nodes ?? {};
      expect(Object.keys(nodes)).toHaveLength(5);
      expect(Object.values(nodes).every((n) => n.kind === "settled")).toBe(true);
      if (Object.values(nodes).every((n) => n.kind === "settled")) {
        expect(Object.values(nodes).map((n) => n.txRef).every(Boolean)).toBe(true);
      }

      const status = runner.status(runTaskId);
      expect(status?.budget.spent).toBe(microAlgo(14n));
      expect(status?.budget.reserved).toBe(microAlgo(0n));

      const rows = await ledger.findByTaskId(runTaskId);
      expect(rows).toHaveLength(5);
      expect(rows.every((r) => r.outcome === "success")).toBe(true);

      // Parallelism proof from the WS stream: the two branches that depend only
      // on search (extract, translate) produce their first states at ~the same
      // wall-clock time, while rank waits for BOTH of them to settle.
      const extractQuoted = firstNodeStateAt(messages, "n-extract", "quoted");
      const translateQuoted = firstNodeStateAt(messages, "n-translate", "quoted");
      expect(extractQuoted).toBeDefined();
      expect(translateQuoted).toBeDefined();
      if (extractQuoted !== undefined && translateQuoted !== undefined) {
        expect(Math.abs(extractQuoted - translateQuoted)).toBeLessThan(1_000);
      }

      const extractSettled = firstNodeStateAt(messages, "n-extract", "settled");
      const translateSettled = firstNodeStateAt(messages, "n-translate", "settled");
      const rankQuoted = firstNodeStateAt(messages, "n-rank", "quoted");
      expect(extractSettled).toBeDefined();
      expect(translateSettled).toBeDefined();
      expect(rankQuoted).toBeDefined();
      if (extractSettled !== undefined && translateSettled !== undefined && rankQuoted !== undefined) {
        expect(rankQuoted).toBeGreaterThanOrEqual(Math.max(extractSettled, translateSettled));
      }

      const rankSettled = firstNodeStateAt(messages, "n-rank", "settled");
      const verifyQuoted = firstNodeStateAt(messages, "n-verify", "quoted");
      expect(rankSettled).toBeDefined();
      expect(verifyQuoted).toBeDefined();
      if (rankSettled !== undefined && verifyQuoted !== undefined) {
        expect(verifyQuoted).toBeGreaterThanOrEqual(rankSettled);
      }
    } finally {
      rmSync(fixture.tmpDir, { recursive: true, force: true });
    }
  });
});

describe("MVD — fail-after-402 reroute", () => {
  it("declares the paid failure, re-routes to the backup with a fresh idempotency key", async () => {
    const adapters = defaultProviders().map((a) =>
      a.providerId === "mock-search" ? mvdProvider("mock-search", "search", 2n, { failMode: "after_402" }) : a,
    );
    const fixture = makeFixture(adapters);
    try {
      const { runner, ledger } = fixture;
      const { taskId: runTaskId } = await runner.run({ goal: MVD_GOAL, cap: "1000" });
      const final = await waitForTerminal(runner, runTaskId);
      expect(final).toBe("completed");

      const search = (runner.status(runTaskId)?.nodes ?? {})["n-search"];
      expect(search?.kind).toBe("settled");
      if (search?.kind === "settled") {
        expect(search.providerId).toBe("mock-search-backup");
      }

      // One row for the paid-then-failed primary, one for the backup. Distinct
      // idempotency keys — the reroute must NOT reuse the failed key.
      const searchRows = (await ledger.findByTaskId(runTaskId)).filter((r) => r.node_id === "n-search");
      expect(searchRows).toHaveLength(2);
      const failed = searchRows.find((r) => r.provider_id === "mock-search");
      const settled = searchRows.find((r) => r.provider_id === "mock-search-backup");
      expect(failed?.outcome).toBe("declared_failure");
      expect(settled?.outcome).toBe("success");
      expect(failed?.idempotency_key).toMatch(/mock-search$/);
      expect(settled?.idempotency_key).toMatch(/mock-search-backup$/);
      expect(failed?.idempotency_key).not.toBe(settled?.idempotency_key);

      // No double-spend: the failed attempt never settled (no tx), the backup did.
      expect(settled?.stages.settlement?.detail.tx_ref).toBeTruthy();

      const rows = await ledger.findByTaskId(runTaskId);
      expect(rows).toHaveLength(6);
      expect(rows.filter((r) => r.outcome === "success")).toHaveLength(5);

      const status = runner.status(runTaskId);
      expect(status?.budget.spent).toBe(microAlgo(17n));
      expect(status?.budget.reserved).toBe(microAlgo(0n));
    } finally {
      rmSync(fixture.tmpDir, { recursive: true, force: true });
    }
  });
});

describe("MVD — sub-budget pause → operator approve", () => {
  it("pauses at the cap, resumes after approve, and settles everything", async () => {
    const fixture = makeFixture(defaultProviders());
    try {
      const { runner, ledger } = fixture;
      const { taskId: runTaskId } = await runner.run({ goal: MVD_GOAL, cap: "10" });

      // search(2) + extract(3) + translate(3) = 8 settle; rank(4) would make 12 > 10.
      await waitForStatus(runner, runTaskId, "paused");
      const paused = runner.status(runTaskId);
      expect(paused?.pauseInfo?.overspend).toBe(microAlgo(2n));
      expect(paused?.budget.spent).toBe(microAlgo(8n));

      const budget = await runner.approve(runTaskId, microAlgo(4n));
      expect(budget?.cap).toBe(microAlgo(14n));

      const final = await waitForTerminal(runner, runTaskId);
      expect(final).toBe("completed");

      const status = runner.status(runTaskId);
      expect(status?.budget.spent).toBe(microAlgo(14n));
      expect(status?.budget.reserved).toBe(microAlgo(0n));

      const rows = await ledger.findByTaskId(runTaskId);
      expect(rows).toHaveLength(5);
      expect(rows.every((r) => r.outcome === "success")).toBe(true);
    } finally {
      rmSync(fixture.tmpDir, { recursive: true, force: true });
    }
  });
});

describe("MVD — reconcile", () => {
  it("ties every paid request to a result or a declared failure", async () => {
    const adapters = defaultProviders().map((a) =>
      a.providerId === "mock-translate"
        ? mvdProvider("mock-translate", "translate", 3n, { failMode: "after_402" })
        : a,
    );
    const fixture = makeFixture(adapters);
    try {
      const { runner, ledger } = fixture;
      const { taskId: runTaskId } = await runner.run({ goal: MVD_GOAL, cap: "1000" });
      const final = await waitForTerminal(runner, runTaskId);
      expect(final).toBe("completed");

      const report = await ledger.exportTaskReconciliation(runTaskId);
      // 5 steps + the translate reroute = 6 rows.
      expect(report.row_count).toBe(6);
      expect(report.totals.success_count).toBe(5);
      expect(report.totals.declared_failure_count).toBe(1);
      expect(report.totals.pending_count).toBe(0);
      expect(report.totals.dup_payment_rate).toBe(1);
      expect(report.totals.budget_adherence_ok).toBe(true);

      const translateRows = report.rows.filter((r) => r.node_id === "n-translate");
      expect(translateRows).toHaveLength(2);
      const failedRow = translateRows.find((r) => r.provider_id === "mock-translate");
      const settledRow = translateRows.find((r) => r.provider_id === "mock-translate-backup");
      expect(failedRow?.outcome).toBe("declared_failure");
      expect(settledRow?.outcome).toBe("success");
      expect(settledRow?.tx_ref).toBeTruthy();

      // search 2, extract 3, translate failed(3) + backup(5), rank 4, verify 2.
      expect(report.totals.total_paid).toBe(microAlgo(19n));
    } finally {
      rmSync(fixture.tmpDir, { recursive: true, force: true });
    }
  });
});

describe("MVD — pay-time guards exclude and re-route", () => {
  it("refuses a stale quote at pay time and falls back to the backup", async () => {
    const adapters = defaultProviders().map((a) =>
      a.providerId === "mock-extract"
        ? mvdProvider("mock-extract", "extract", 3n, { staleQuote: true })
        : a,
    );
    const fixture = makeFixture(adapters);
    try {
      const { runner, ledger } = fixture;
      const { taskId: runTaskId } = await runner.run({ goal: MVD_GOAL, cap: "1000" });
      const final = await waitForTerminal(runner, runTaskId);
      expect(final).toBe("completed");

      const settledExtract = (runner.status(runTaskId)?.nodes ?? {})["n-extract"];
      expect(settledExtract?.kind).toBe("settled");
      if (settledExtract?.kind === "settled") {
        expect(settledExtract.providerId).toBe("mock-extract-backup");
      }

      const rows = (await ledger.findByTaskId(runTaskId)).filter((r) => r.node_id === "n-extract");
      expect(rows).toHaveLength(2);
      const stale = rows.find((r) => r.provider_id === "mock-extract");
      expect(stale?.outcome).toBe("declared_failure");
      expect(stale?.stages.payment?.detail.reason).toBe("stale_quote");
      const backup = rows.find((r) => r.provider_id === "mock-extract-backup");
      expect(backup?.outcome).toBe("success");
      expect(stale?.idempotency_key).not.toBe(backup?.idempotency_key);
    } finally {
      rmSync(fixture.tmpDir, { recursive: true, force: true });
    }
  });

  it("refuses a >25% price drift at pay time and falls back to the backup", async () => {
    const adapters = defaultProviders().map((a) =>
      a.providerId === "mock-translate"
        ? mvdProvider("mock-translate", "translate", 3n, { driftPrice: 7n })
        : a,
    );
    const fixture = makeFixture(adapters);
    try {
      const { runner, ledger } = fixture;
      const { taskId: runTaskId } = await runner.run({ goal: MVD_GOAL, cap: "1000" });
      const final = await waitForTerminal(runner, runTaskId);
      expect(final).toBe("completed");

      const settledTranslate = (runner.status(runTaskId)?.nodes ?? {})["n-translate"];
      expect(settledTranslate?.kind).toBe("settled");
      if (settledTranslate?.kind === "settled") {
        expect(settledTranslate.providerId).toBe("mock-translate-backup");
      }

      const rows = (await ledger.findByTaskId(runTaskId)).filter((r) => r.node_id === "n-translate");
      expect(rows).toHaveLength(2);
      const drifted = rows.find((r) => r.provider_id === "mock-translate");
      expect(drifted?.outcome).toBe("declared_failure");
      expect(drifted?.stages.payment?.detail.reason).toBe("price_drift");
      expect(drifted?.stages.payment?.detail.quoted).toBe("7");
      const backup = rows.find((r) => r.provider_id === "mock-translate-backup");
      expect(backup?.outcome).toBe("success");
      expect(drifted?.idempotency_key).not.toBe(backup?.idempotency_key);
    } finally {
      rmSync(fixture.tmpDir, { recursive: true, force: true });
    }
  });
});

describe("MVD — upto payment scheme", () => {
  it("settles at the actual spend and records it on the invoice + settlement stage", async () => {
    const adapters = defaultProviders().map((a) =>
      a.providerId === "mock-translate"
        ? mvdProvider("mock-translate", "translate", 3n, { scheme: "upto", uptoActual: 1n })
        : a,
    );
    const fixture = makeFixture(adapters);
    try {
      const { runner, ledger } = fixture;
      const { taskId: runTaskId } = await runner.run({ goal: MVD_GOAL, cap: "1000" });
      const final = await waitForTerminal(runner, runTaskId);
      expect(final).toBe("completed");

      const settledTranslate = (runner.status(runTaskId)?.nodes ?? {})["n-translate"];
      expect(settledTranslate?.kind).toBe("settled");

      const translateRow = (await ledger.findByTaskId(runTaskId)).find(
        (r) => r.node_id === "n-translate",
      );
      expect(translateRow).toBeDefined();
      if (translateRow) {
        // Settlement stage detail now carries the scheme + actual spend.
        expect(translateRow.stages.settlement?.detail.scheme).toBe("upto");
        expect(translateRow.stages.settlement?.detail.actual_amount).toBe("1");
      }

      // Reconciliation derivation reads those details back: quoted 3, actual 1.
      const report = await ledger.exportTaskReconciliation(runTaskId);
      const translated = report.rows.find((r) => r.node_id === "n-translate");
      expect(translated?.scheme).toBe("upto");
      expect(translated?.quoted_amount).toBe(microAlgo(3n));
      expect(translated?.actual_amount).toBe(microAlgo(1n));
    } finally {
      rmSync(fixture.tmpDir, { recursive: true, force: true });
    }
  });
});

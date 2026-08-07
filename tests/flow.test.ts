import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type DeliverResponse,
  type MicroAlgo,
  type PlanOutcome,
  type ProviderAdapter,
  type QuoteResponse,
  type WsMessage,
  microAlgo,
  taskId,
  type Capability,
} from "@sentinel/schemas";
import { createLedgerStore, type LedgerStore } from "@sentinel/ledger";
import { createRouter } from "@sentinel/router";
import { createTaskRunner, type TaskRunner } from "@sentinel/orchestrator";
import { SimulatedX402Client } from "@sentinel/x402-client";
import { Treasury } from "@sentinel/treasury";

// ─── End-to-end flow ──────────────────────────────────────────────────────────
// A full goal → plan → route → quote → reserve → pay → guard → settle → ledger
// run against in-process engines. Uses the same createTaskRunner entry point
// as apps/service-orchestrator, with mock providers standing in for the
// (unwired) Zerion/LLM resource servers.

const WALLET_ID = "mock-wallet";
const SUMMARY_ID = "mock-summary";
const CREDIT_ID = "mock-credit";

type ResultFactory = (
  invoiceId: string,
  paymentRef: string,
  input: Record<string, unknown>,
) => Record<string, unknown>;

function mockProvider(
  providerId: string,
  capability: Capability,
  priceMicroAlgo: bigint,
  result: ResultFactory,
): ProviderAdapter {
  return {
    providerId,
    capability,
    priceHint: microAlgo(priceMicroAlgo),
    latencyHintMs: 50,
    qualityScore: 0.9,
    baseUrl: `https://mock.${providerId}.invalid`,
    role: "primary",
    async quote(): Promise<{ ok: true; value: QuoteResponse }> {
      return {
        ok: true,
        value: {
          invoice_id: `inv-${providerId}`,
          provider_id: providerId,
          capability,
          price: Number(priceMicroAlgo),
          currency: "uAlgo",
          schema: "x402@0.1",
          terms_expires_at: new Date(Date.now() + 60_000).toISOString(),
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
          result: result(invoiceId, paymentRef, input ?? {}),
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

const nowIso = (): string => new Date().toISOString();

function happyProviders(): ProviderAdapter[] {
  return [
    mockProvider(WALLET_ID, "fetch_wallet_data", 300n, () => ({
      wallet_address: "ALGO-TEST-000",
      portfolio_value_usd: "12.5",
      fetched_at: nowIso(),
    })),
    mockProvider(SUMMARY_ID, "generate_summary", 300n, (_i, _r, input) => {
      expect(input["n-wallet"]).toMatchObject({ wallet_address: "ALGO-TEST-000" });
      return { summary: "Holding summary for ALGO-TEST-000" };
    }),
    mockProvider(CREDIT_ID, "score_credit", 200n, () => ({
      score: 85,
      reasons: ["diverse assets"],
    })),
  ];
}

function planGraph(taskIdValue: string): PlanOutcome {
  return {
    source: "planner",
    graph: {
      task_id: taskIdValue,
      name: "assess-wallet",
      goal: "assess wallet ALGO-TEST-000",
      steps: [
        { id: "n-wallet", label: "Fetch wallet data", capability: "fetch_wallet_data", dependsOn: [] },
        { id: "n-summary", label: "Summarize", capability: "generate_summary", dependsOn: ["n-wallet"] },
        { id: "n-credit", label: "Credit score", capability: "score_credit", dependsOn: ["n-summary"] },
      ],
    },
  };
}

interface FlowFixture {
  runner: TaskRunner;
  ledger: LedgerStore;
  messages: WsMessage[];
  tmpDir: string;
}

function makeFixture(adapters: ProviderAdapter[], capMicroAlgo: bigint): FlowFixture {
  const tmpDir = mkdtempSync(join(tmpdir(), "sentinel-flow-"));
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

/** run() with the fixture's budget cap threaded through (defaults to 1000). */
function runWithCap(fixture: FlowFixture, capMicroAlgo: bigint, goal: string) {
  return fixture.runner.run({ goal, cap: String(capMicroAlgo) });
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

describe("end-to-end run — happy path", () => {
  it("plans, routes, pays, guards, settles, and writes ledger rows", async () => {
    const fixture = makeFixture(happyProviders(), 1000n);
    try {
      const { runner, ledger, messages } = fixture;

      const { taskId: runTaskId } = await runWithCap(fixture, 1000n, "assess wallet ALGO-TEST-000");
      const final = await waitForTerminal(runner, runTaskId);

      expect(final).toBe("completed");
      const status = runner.status(runTaskId);
      expect(status?.status).toBe("completed");
      expect(status?.startedAt).toBeDefined();
      expect(status?.finishedAt).toBeDefined();

      // every node settled, downstream nodes received upstream results
      const nodes = runner.nodes(runTaskId) ?? [];
      expect(nodes).toHaveLength(3);
      expect(nodes.every((n) => n.kind === "settled")).toBe(true);
      if (nodes.every((n) => n.kind === "settled")) {
        expect(nodes.map((n) => n.txRef).every(Boolean)).toBe(true);
      }

      // budget: all three quotes settled (300 + 300 + 200 uAlgo)
      expect(status?.budget.spent).toBe(microAlgo(800n));
      expect(status?.budget.reserved).toBe(microAlgo(0n));
      expect(status?.budget.available).toBe(microAlgo(200n));

      // one ledger row per paid call, each with an idempotency key + success
      const rows = await ledger.findByTaskId(runTaskId);
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.idempotency_key).toMatch(new RegExp(`^ik-${runTaskId}-n-(wallet|summary|credit)-`));
        expect(row.outcome).toBe("success");
      }

      // WS event stream saw the task lifecycle, not a parallel shape
      expect(messages.some((m) => m.event === "task_started" && m.taskId === runTaskId)).toBe(true);
      expect(messages.filter((m) => m.event === "node_state").length).toBeGreaterThanOrEqual(3);
      expect(messages.some((m) => m.event === "task_done" && m.taskId === runTaskId)).toBe(true);

      // replay works from the ledger alone
      const replay = await ledger.exportTask(runTaskId);
      expect(replay.row_count).toBe(3);
      expect(replay.rows.length).toBe(3);
    } finally {
      rmSync(fixture.tmpDir, { recursive: true, force: true });
    }
  });
});

describe("end-to-end run — policy guard blocks an adversarial response", () => {
  it("blocks the node, cascades dependents, and records the violation", async () => {
    const adversarial = mockProvider(WALLET_ID, "fetch_wallet_data", 300n, () => ({
      wallet_address: "ALGO-TEST-000",
      portfolio_value_usd: "12.5",
      fetched_at: nowIso(),
      budget_cap: "999999999999",
    }));
    const adapters = [adversarial, ...happyProviders().slice(1)];

    const fixture = makeFixture(adapters, 1000n);
    try {
      const { runner, ledger } = fixture;
      const { taskId: runTaskId } = await runWithCap(fixture, 1000n, "assess wallet ALGO-TEST-000");
      const final = await waitForTerminal(runner, runTaskId);

      expect(final).toBe("completed");
      const nodes = runner.nodes(runTaskId) ?? [];
      expect(nodes.length).toBe(3);

      const wallet = nodes.find((n) => (n.kind === "blocked" || n.kind === "failed")) as
        | { kind: "blocked"; violation: { type: string } }
        | { kind: "failed" }
        | undefined;
      expect(wallet?.kind).toBe("blocked");
      if (wallet?.kind === "blocked") expect(wallet.violation.type).toBe("budget_mutation");

      // dependents failed via the cascade — nothing hangs in "pending"
      const summary = nodes.find((n) => n.kind === "failed");
      expect(summary?.kind).toBe("failed");

      // the offending row records the violation, the honest ones stay clean
      const walletRow = (await ledger.findByTaskId(runTaskId)).find(
        (r) => r.node_id === "n-wallet",
      );
      expect(walletRow?.outcome).toBe("declared_failure");
      expect(walletRow?.violations?.[0]?.type).toBe("budget_mutation");
    } finally {
      rmSync(fixture.tmpDir, { recursive: true, force: true });
    }
  });
});

describe("end-to-end run — budget pause + operator approval", () => {
  it("pauses at the cap, resumes after approve, settles everything", async () => {
    const fixture = makeFixture(happyProviders(), 400n);
    try {
      const { runner, ledger } = fixture;
      const { taskId: runTaskId } = await runWithCap(fixture, 400n, "assess wallet ALGO-TEST-000");

      // wallet (300) fits; summary (300) would overshoot → task pauses
      const deadline = Date.now() + 10_000;
      for (;;) {
        const s = runner.status(runTaskId);
        if (s?.status === "paused") break;
        if (Date.now() > deadline) throw new Error("task never paused");
        await new Promise((r) => setTimeout(r, 25));
      }
      const paused = runner.status(runTaskId);
      expect(paused?.pauseInfo?.overspend).toBe(microAlgo(200n));
      expect(paused?.budget.spent).toBe(microAlgo(300n));

      const budget = await runner.approve(runTaskId, microAlgo(500n));
      expect(budget?.cap).toBe(microAlgo(900n));

      const final = await waitForTerminal(runner, runTaskId);
      expect(final).toBe("completed");

      const status = runner.status(runTaskId);
      expect(status?.budget.spent).toBe(microAlgo(800n));
      expect(status?.budget.reserved).toBe(microAlgo(0n));

      const rows = await ledger.findByTaskId(runTaskId);
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.outcome === "success")).toBe(true);
    } finally {
      rmSync(fixture.tmpDir, { recursive: true, force: true });
    }
  });

  it("operator reject aborts the paused task", async () => {
    const fixture = makeFixture(happyProviders(), 400n);
    try {
      const { runner } = fixture;
      const { taskId: runTaskId } = await runWithCap(fixture, 400n, "assess wallet ALGO-TEST-000");

      const deadline = Date.now() + 10_000;
      for (;;) {
        const s = runner.status(runTaskId);
        if (s?.status === "paused") break;
        if (Date.now() > deadline) throw new Error("task never paused");
        await new Promise((r) => setTimeout(r, 25));
      }

      runner.reject(runTaskId);
      const final = await waitForTerminal(runner, runTaskId);
      expect(final).toBe("aborted");
    } finally {
      rmSync(fixture.tmpDir, { recursive: true, force: true });
    }
  });
});

describe("SimulatedX402Client — no double settlement", () => {
  it("returns the original receipt on a retried payment", async () => {
    const cap: Parameters<SimulatedX402Client["issueCapability"]>[0] = {
      token: "cap-tok-1" as never,
      taskId: taskId("t-1"),
      nodeId: "n-wallet" as never,
      providerId: "mock-wallet",
      maxAmount: microAlgo(500n),
    };
    const invoice = {
      invoice_id: "inv-mock-wallet",
      provider_id: "mock-wallet",
      capability: "fetch_wallet_data" as Capability,
      amount: microAlgo(300n),
    };

    const client = new SimulatedX402Client();
    client.issueCapability(cap);

    const first = client.pay(cap, invoice);
    const second = client.pay(cap, invoice);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value.txRef).toBe(first.value.txRef);
      expect(second.value.firstPayment).toBe(false);
    }

    const treasury = new Treasury(taskId("t-1"), microAlgo(1000n));
    expect(treasury.issueCapability("n-wallet" as never, "mock-wallet", microAlgo(500n)).maxAmount).toBe(
      microAlgo(500n),
    );
  });
});

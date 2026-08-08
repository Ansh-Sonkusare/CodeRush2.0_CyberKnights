import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ReconciliationReportSchema,
  ReconciliationReportWireSchema,
  newStage,
  type Capability,
} from "@sentinel/schemas";
import { loadConfigSafe } from "@sentinel/config";
import {
  createLedgerStore,
  toReconciliationWire,
  type LedgerStore,
} from "@sentinel/ledger";
import { createGatewayApp } from "../apps/gateway/src/app.js";

// ---- Reconciliation report (WS-D) --------------------------------------------
// Ledger rows (one per paid call) map to ReconciliationRow (bigint microAlgo),
// roll up into ReconciliationTotals, and serialize to the wire shape with money
// as decimal strings. The gateway serves it at /api/ledger/task/:taskId/reconcile.

const nowIso = (): string => new Date().toISOString();

interface SeedOptions {
  nodeId: string;
  capability: Capability;
  providerId: string;
  idempotencyKey: string;
  price: number;
  outcome: "success" | "declared_failure" | "pending_approval";
  txRef?: string;
  settlementDetail?: Record<string, unknown>;
  violationType?: "budget_mutation" | "scope_expansion";
}

// Mirrors how the orchestrator records a row: quote -> payment -> settlement,
// then (optionally) a guard violation and the final outcome.
async function seedRow(ledger: LedgerStore, opts: SeedOptions): Promise<void> {
  const row = await ledger.insert({
    task_id: "t-1",
    node_id: opts.nodeId,
    idempotency_key: opts.idempotencyKey,
    provider_id: opts.providerId,
    capability: opts.capability,
    route_reason: "baseline",
  });

  if (opts.outcome === "pending_approval") return;

  await ledger.updateStage(
    row.ledger_id,
    newStage("402_terms", "received", {
      invoice_id: `inv-${opts.nodeId}`,
      provider_id: opts.providerId,
      capability: opts.capability,
      price: opts.price,
      currency: "uAlgo",
      schema: "x402@0.1",
      terms_expires_at: new Date(Date.now() + 60_000).toISOString(),
      payment_required: true,
    }),
  );
  await ledger.updateStage(
    row.ledger_id,
    newStage("payment", "sent", {
      amount: String(opts.price),
      idempotency_key: opts.idempotencyKey,
    }),
  );
  await ledger.updateStage(
    row.ledger_id,
    newStage("settlement", "settled", {
      tx_ref: opts.txRef ?? `tx-${opts.nodeId}`,
      first_payment: true,
      amount: String(opts.price),
      ...opts.settlementDetail,
    }),
  );

  if (opts.violationType) {
    await ledger.appendViolation(row.ledger_id, {
      id: `v-${opts.nodeId}`,
      type: opts.violationType,
      stage: "terms",
      message: "adversarial response attempted budget mutation",
      rejected_fields: ["budget_cap"],
      at: nowIso(),
    });
  }
  await ledger.setOutcome(row.ledger_id, opts.outcome);
}

describe("exportTaskReconciliation - per-task report", () => {
  it("maps paid rows and rolls up totals (success + declared_failure)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "sentinel-reconcile-"));
    const ledger = createLedgerStore(join(tmpDir, "ledger.db"));
    try {
      await seedRow(ledger, {
        nodeId: "n-a",
        capability: "fetch_wallet_data",
        providerId: "prov-a",
        idempotencyKey: "ik-t-1-n-a",
        price: 300,
        outcome: "success",
      });
      await seedRow(ledger, {
        nodeId: "n-b",
        capability: "score_credit",
        providerId: "prov-b",
        idempotencyKey: "ik-t-1-n-b",
        price: 200,
        txRef: "tx-b",
        outcome: "declared_failure",
        violationType: "budget_mutation",
      });

      const report = await ledger.exportTaskReconciliation("t-1");
      const checked = ReconciliationReportSchema.safeParse(report);
      expect(checked.success).toBe(true);

      expect(report.task_id).toBe("t-1");
      expect(report.row_count).toBe(2);
      expect(report.rows).toHaveLength(2);

      const rowA = report.rows.find((r) => r.node_id === "n-a");
      expect(rowA?.outcome).toBe("success");
      expect(rowA?.quoted_amount).toBe(300n);
      expect(rowA?.tx_ref).toBe("tx-n-a");
      expect(rowA?.actual_amount).toBeUndefined();
      expect(rowA?.scheme).toBeUndefined();

      const rowB = report.rows.find((r) => r.node_id === "n-b");
      expect(rowB?.outcome).toBe("declared_failure");
      expect(rowB?.quoted_amount).toBe(200n);
      expect(rowB?.tx_ref).toBe("tx-b");
      expect(rowB?.violations?.[0]?.type).toBe("budget_mutation");

      expect(report.totals.success_count).toBe(1);
      expect(report.totals.declared_failure_count).toBe(1);
      expect(report.totals.pending_count).toBe(0);
      expect(report.totals.dup_payment_rate).toBe(1);
      expect(report.totals.total_paid).toBe(500n);
      expect(report.totals.budget_adherence_ok).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("derives scheme, actual_amount, and tx_ref from settlement details", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "sentinel-reconcile-"));
    const ledger = createLedgerStore(join(tmpDir, "ledger.db"));
    try {
      await seedRow(ledger, {
        nodeId: "n-a",
        capability: "fetch_wallet_data",
        providerId: "prov-a",
        idempotencyKey: "ik-t-1-n-a",
        price: 300,
        outcome: "success",
        settlementDetail: { scheme: "upto", actual_amount: "295" },
      });

      const report = await ledger.exportTaskReconciliation("t-1");
      const row = report.rows[0];
      expect(row?.scheme).toBe("upto");
      expect(row?.quoted_amount).toBe(300n);
      expect(row?.actual_amount).toBe(295n);
      expect(report.totals.total_paid).toBe(295n);
      expect(report.totals.budget_adherence_ok).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles an empty task and a never-paid (pending_approval) row", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "sentinel-reconcile-"));
    const ledger = createLedgerStore(join(tmpDir, "ledger.db"));
    try {
      const empty = await ledger.exportTaskReconciliation("t-empty");
      expect(empty.row_count).toBe(0);
      expect(empty.totals.dup_payment_rate).toBe(1);
      expect(empty.totals.total_paid).toBe(0n);
      expect(empty.totals.success_count).toBe(0);
      expect(empty.totals.declared_failure_count).toBe(0);

      await seedRow(ledger, {
        nodeId: "n-c",
        capability: "generate_summary",
        providerId: "prov-c",
        idempotencyKey: "ik-t-1-n-c",
        price: 100,
        outcome: "pending_approval",
      });

      const report = await ledger.exportTaskReconciliation("t-1");
      expect(report.row_count).toBe(1);
      expect(report.totals.pending_count).toBe(1);
      expect(report.totals.success_count).toBe(0);
      expect(report.totals.total_paid).toBe(0n);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("toReconciliationWire - in-process to wire shape", () => {
  it("converts bigint money to decimal strings and keeps the report shape", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "sentinel-reconcile-"));
    const ledger = createLedgerStore(join(tmpDir, "ledger.db"));
    try {
      await seedRow(ledger, {
        nodeId: "n-a",
        capability: "fetch_wallet_data",
        providerId: "prov-a",
        idempotencyKey: "ik-t-1-n-a",
        price: 300,
        outcome: "success",
        settlementDetail: { scheme: "upto", actual_amount: "295" },
      });
      await seedRow(ledger, {
        nodeId: "n-b",
        capability: "score_credit",
        providerId: "prov-b",
        idempotencyKey: "ik-t-1-n-b",
        price: 200,
        outcome: "declared_failure",
      });

      const report = await ledger.exportTaskReconciliation("t-1");
      const wire = toReconciliationWire(report);
      const checked = ReconciliationReportWireSchema.safeParse(wire);
      expect(checked.success).toBe(true);

      expect(wire.task_id).toBe("t-1");
      expect(wire.row_count).toBe(2);
      expect(wire.rows).toHaveLength(2);

      const rowAWire = wire.rows.find((r) => r.node_id === "n-a");
      expect(rowAWire?.quoted_amount).toBe("300");
      expect(rowAWire?.actual_amount).toBe("295");
      expect(rowAWire?.scheme).toBe("upto");

      const rowBWire = wire.rows.find((r) => r.node_id === "n-b");
      expect(rowBWire?.quoted_amount).toBe("200");
      expect(rowBWire?.actual_amount).toBeUndefined();

      expect(wire.totals.total_paid).toBe("495");
      expect(wire.totals.success_count).toBe(1);
      expect(wire.totals.declared_failure_count).toBe(1);
      expect(wire.totals.pending_count).toBe(0);
      expect(wire.totals.dup_payment_rate).toBe(1);
      expect(wire.totals.budget_adherence_ok).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("GET /api/ledger/task/:taskId/reconcile - gateway route", () => {
  it("serves the wire report with 200", async () => {
    const config = loadConfigSafe({});
    expect(config.ok).toBe(true);
    if (!config.ok) return;

    const tmpDir = mkdtempSync(join(tmpdir(), "sentinel-reconcile-"));
    const ledger = createLedgerStore(join(tmpDir, "ledger.db"));
    try {
      await seedRow(ledger, {
        nodeId: "n-a",
        capability: "fetch_wallet_data",
        providerId: "prov-a",
        idempotencyKey: "ik-t-1-n-a",
        price: 300,
        outcome: "success",
      });
      await seedRow(ledger, {
        nodeId: "n-b",
        capability: "score_credit",
        providerId: "prov-b",
        idempotencyKey: "ik-t-1-n-b",
        price: 200,
        outcome: "declared_failure",
      });

      const app = createGatewayApp(config.value, ledger);
      const res = await app.request("/api/ledger/task/t-1/reconcile");
      expect(res.status).toBe(200);

      const body = (await res.json()) as unknown;
      const checked = ReconciliationReportWireSchema.safeParse(body);
      expect(checked.success).toBe(true);
      if (checked.success) {
        expect(checked.data.task_id).toBe("t-1");
        expect(checked.data.row_count).toBe(2);
        expect(checked.data.totals.success_count).toBe(1);
        expect(checked.data.totals.declared_failure_count).toBe(1);
        expect(checked.data.totals.pending_count).toBe(0);
        expect(checked.data.totals.dup_payment_rate).toBe(1);
        expect(checked.data.totals.total_paid).toBe("500");
        expect(checked.data.totals.budget_adherence_ok).toBe(true);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns an empty report (200) for a task with no rows", async () => {
    const config = loadConfigSafe({});
    expect(config.ok).toBe(true);
    if (!config.ok) return;

    const tmpDir = mkdtempSync(join(tmpdir(), "sentinel-reconcile-"));
    const ledger = createLedgerStore(join(tmpDir, "ledger.db"));
    try {
      const app = createGatewayApp(config.value, ledger);
      const res = await app.request("/api/ledger/task/t-ghost/reconcile");
      expect(res.status).toBe(200);

      const body = (await res.json()) as unknown;
      const checked = ReconciliationReportWireSchema.safeParse(body);
      expect(checked.success).toBe(true);
      if (checked.success) {
        expect(checked.data.task_id).toBe("t-ghost");
        expect(checked.data.row_count).toBe(0);
        expect(checked.data.totals.total_paid).toBe("0");
        expect(checked.data.totals.dup_payment_rate).toBe(1);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

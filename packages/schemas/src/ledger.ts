import { z } from "zod";
import { CapabilitySchema } from "./capability.js";
import { PaymentSchemeSchema, PolicyViolationSchema } from "./guard.js";
import { microAlgoDecimalString } from "./node-state.js";

export const SCHEMA_VERSION = "2.0.0";

export const LedgerStageNameSchema = z.enum([
  "402_terms",
  "payment",
  "settlement",
  "response",
  "receipt",
]);
export type LedgerStageName = z.infer<typeof LedgerStageNameSchema>;

export const LedgerStageStatusSchema = z.enum([
  "pending",
  "sent",
  "received",
  "settled",
  "failed",
  "skipped",
]);
export type LedgerStageStatus = z.infer<typeof LedgerStageStatusSchema>;

export const LedgerOutcomeSchema = z.enum([
  "success",
  "declared_failure",
  "pending_approval",
]);
export type LedgerOutcome = z.infer<typeof LedgerOutcomeSchema>;

export const LedgerStageSchema = z
  .object({
    name: LedgerStageNameSchema,
    at: z.string(),
    status: LedgerStageStatusSchema,
    detail: z.record(z.string(), z.unknown()),
  })
  .strict();

export type LedgerStage = z.infer<typeof LedgerStageSchema>;

export const STAGE_ORDER: LedgerStageName[] = [
  "402_terms",
  "payment",
  "settlement",
  "response",
  "receipt",
];

export const LedgerRowSchema = z
  .object({
    ledger_id: z.string(),
    task_id: z.string(),
    node_id: z.string(),
    idempotency_key: z.string(),
    provider_id: z.string(),
    capability: CapabilitySchema,
    route_reason: z.string(),
    stages: z.record(z.string(), LedgerStageSchema),
    outcome: LedgerOutcomeSchema,
    violations: z.array(PolicyViolationSchema).optional(),
    created_at: z.string(),
  })
  .strict();

export type LedgerRow = z.infer<typeof LedgerRowSchema>;

// ─── Factory helpers ──────────────────────────────────────────────────────────

export function emptyStage(name: LedgerStageName): LedgerStage {
  return { name, at: "", status: "pending", detail: {} };
}

export function newStage(
  name: LedgerStageName,
  status: LedgerStageStatus,
  detail: Record<string, unknown> = {},
): LedgerStage {
  return { name, at: new Date().toISOString(), status, detail };
}

export interface NewLedgerRowInput {
  ledger_id: string;
  task_id: string;
  node_id: string;
  idempotency_key: string;
  provider_id: string;
  capability: z.infer<typeof CapabilitySchema>;
  route_reason: string;
}

// ─── Create-row request (ledger package boundary) ────────────────────────────
// ledger_id is assigned by the store, so it is NOT part of the create input.

export const CreateLedgerRowRequestSchema = z
  .object({
    task_id: z.string(),
    node_id: z.string(),
    idempotency_key: z.string(),
    provider_id: z.string(),
    capability: CapabilitySchema,
    route_reason: z.string(),
  })
  .strict();

export type CreateLedgerRowRequest = z.infer<typeof CreateLedgerRowRequestSchema>;

// ─── Export (replay) shape ────────────────────────────────────────────────────

export const LedgerExportSchema = z
  .object({
    schema: z.string(),
    task_id: z.string(),
    exported_at: z.string(),
    row_count: z.number(),
    rows: z.array(LedgerRowSchema),
  })
  .strict();

export type LedgerExport = z.infer<typeof LedgerExportSchema>;

export function createLedgerRow(input: NewLedgerRowInput): LedgerRow {
  const stages = Object.fromEntries(
    STAGE_ORDER.map((name) => [name, emptyStage(name)]),
  ) as LedgerRow["stages"];

  return {
    ledger_id: input.ledger_id,
    task_id: input.task_id,
    node_id: input.node_id,
    idempotency_key: input.idempotency_key,
    provider_id: input.provider_id,
    capability: input.capability,
    route_reason: input.route_reason,
    stages,
    outcome: "pending_approval",
    created_at: new Date().toISOString(),
  };
}

// ─── Reconciliation report ────────────────────────────────────────────────────
// Proves "every paid request tied to a result or declared failure": one row per
// paid ledger entry plus totals for the dup-payment and budget-adherence
// metrics (WS-D builds this, WS-F renders it).

export const ReconciliationRowSchema = z
  .object({
    ledger_id: z.string(),
    node_id: z.string(),
    capability: CapabilitySchema,
    provider_id: z.string(),
    scheme: PaymentSchemeSchema.optional(),
    quoted_amount: z.bigint(),
    actual_amount: z.bigint().optional(),
    idempotency_key: z.string(),
    tx_ref: z.string().optional(),
    outcome: LedgerOutcomeSchema,
    violations: z.array(PolicyViolationSchema).optional(),
    stages: z.record(z.string(), LedgerStageSchema),
    created_at: z.string(),
  })
  .strict();

export type ReconciliationRow = z.infer<typeof ReconciliationRowSchema>;

export const ReconciliationTotalsSchema = z
  .object({
    total_paid: z.bigint(),
    success_count: z.number().int().min(0),
    declared_failure_count: z.number().int().min(0),
    pending_count: z.number().int().min(0),
    dup_payment_rate: z.number().min(0).max(1),
    budget_adherence_ok: z.boolean(),
  })
  .strict();

export type ReconciliationTotals = z.infer<typeof ReconciliationTotalsSchema>;

export const ReconciliationReportSchema = z
  .object({
    task_id: z.string(),
    generated_at: z.string(),
    row_count: z.number().int().min(0),
    rows: z.array(ReconciliationRowSchema),
    totals: ReconciliationTotalsSchema,
  })
  .strict();

export type ReconciliationReport = z.infer<typeof ReconciliationReportSchema>;

// ─── Wire variants ────────────────────────────────────────────────────────────
// Money as decimal strings (jsonStringify) — same shape, strings not bigint.

export const ReconciliationRowWireSchema = z
  .object({
    ledger_id: z.string(),
    node_id: z.string(),
    capability: CapabilitySchema,
    provider_id: z.string(),
    scheme: PaymentSchemeSchema.optional(),
    quoted_amount: microAlgoDecimalString,
    actual_amount: microAlgoDecimalString.optional(),
    idempotency_key: z.string(),
    tx_ref: z.string().optional(),
    outcome: LedgerOutcomeSchema,
    violations: z.array(PolicyViolationSchema).optional(),
    stages: z.record(z.string(), LedgerStageSchema),
    created_at: z.string(),
  })
  .strict();

export type ReconciliationRowWire = z.infer<typeof ReconciliationRowWireSchema>;

export const ReconciliationTotalsWireSchema = z
  .object({
    total_paid: microAlgoDecimalString,
    success_count: z.number().int().min(0),
    declared_failure_count: z.number().int().min(0),
    pending_count: z.number().int().min(0),
    dup_payment_rate: z.number().min(0).max(1),
    budget_adherence_ok: z.boolean(),
  })
  .strict();

export type ReconciliationTotalsWire = z.infer<typeof ReconciliationTotalsWireSchema>;

export const ReconciliationReportWireSchema = z
  .object({
    task_id: z.string(),
    generated_at: z.string(),
    row_count: z.number().int().min(0),
    rows: z.array(ReconciliationRowWireSchema),
    totals: ReconciliationTotalsWireSchema,
  })
  .strict();

export type ReconciliationReportWire = z.infer<typeof ReconciliationReportWireSchema>;

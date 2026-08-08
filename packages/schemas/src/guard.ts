import { z } from "zod";

export const ViolationTypeSchema = z.enum([
  "budget_mutation",
  "scope_expansion",
  "prompt_injection",
  "receipt_forgery",
  "schema_violation",
]);
export type ViolationType = z.infer<typeof ViolationTypeSchema>;

export const GuardStageSchema = z.enum(["terms", "result", "receipt"]);
export type GuardStage = z.infer<typeof GuardStageSchema>;

export const PolicyViolationSchema = z
  .object({
    id: z.string(),
    type: ViolationTypeSchema,
    stage: GuardStageSchema,
    message: z.string(),
    rejected_fields: z.array(z.string()),
    at: z.string(),
  })
  .strict();

export type PolicyViolation = z.infer<typeof PolicyViolationSchema>;

// Payment-related errors (used by x402-client)
export const PaymentErrorKindSchema = z.enum([
  "scope_exceeded",
  "scope_missing",
  "provider_mismatch",
  "already_settled",
  "chain_error",
  "unknown",
]);
export type PaymentErrorKind = z.infer<typeof PaymentErrorKindSchema>;

export interface PaymentError {
  kind: PaymentErrorKind;
  message: string;
  idempotencyKey?: string;
}

export const PaymentReceiptSchema = z
  .object({
    idempotencyKey: z.string(),
    txRef: z.string(),
    // true = in-memory SimulatedX402Client (txRef is `sim-…`, not on-chain);
    // false = real Algorand settlement (txRef is an on-chain transaction id).
    simulated: z.boolean(),
    amount: z.bigint(),              // MicroAlgo
    providerId: z.string(),
    taskId: z.string(),
    nodeId: z.string(),
    settledAt: z.string(),
    firstPayment: z.boolean(),
  })
  .strict();

export type PaymentReceipt = z.infer<typeof PaymentReceiptSchema>;

// Payment invoice — what the x402 client actually settles. `amount` is the
// precise spend in microAlgo (bigint, never a number).
export const InvoiceSchema = z
  .object({
    invoice_id: z.string(),
    provider_id: z.string(),
    capability: z.string(),
    amount: z.bigint(),
    currency: z.string(),
    schema: z.string(),
    terms_expires_at: z.string(),
    payment_required: z.boolean(),
  })
  .strict();

export type Invoice = z.infer<typeof InvoiceSchema>;

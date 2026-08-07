import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  BUDGET_MUTATION_FIELDS,
  PROMPT_INJECTION_KEYS,
  SCOPE_EXPANSION_FIELDS,
  ReceiptResponseSchema,
  TermsResponseSchema,
  type GuardStage,
  type PolicyViolation,
  type ReceiptResponse,
  type TermsResponse,
  type ViolationType,
} from "@sentinel/schemas";

export type GuardResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; violation: PolicyViolation; raw: Record<string, unknown> };

export type ValidateTermsResult =
  | { ok: true; data: TermsResponse }
  | { ok: false; violation: PolicyViolation };

export type ValidateReceiptResult =
  | { ok: true; data: ReceiptResponse }
  | { ok: false; violation: PolicyViolation };

/** Recursively collect all string keys from an arbitrary object. */
export function collectKeys(
  obj: unknown,
  out: Set<string> = new Set(),
): Set<string> {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out.add(k);
      collectKeys(v, out);
    }
  } else if (Array.isArray(obj)) {
    for (const item of obj) collectKeys(item, out);
  }
  return out;
}

/**
 * Validate 402 terms from a provider response (ASK phase).
 * Strict: unknown fields are rejected.
 */
export function validateTerms(
  data: Record<string, unknown>,
): ValidateTermsResult {
  const result = TermsResponseSchema.safeParse(data);
  if (result.success) {
    return { ok: true, data: result.data };
  }

  const rejectedFields = result.error.issues.map(
    (i) => i.path.join(".") || "(root)",
  );
  return {
    ok: false,
    violation: {
      id: `v-${randomUUID().slice(0, 8)}`,
      type: classifyViolation(rejectedFields),
      stage: "terms",
      message: `Terms schema validation failed: ${result.error.issues.map((i) => i.message).join(", ")}`,
      rejected_fields: rejectedFields,
      at: new Date().toISOString(),
    },
  };
}

/**
 * Validate a payment receipt (RECONCILE phase).
 * Checks shape AND verifies tx_ref matches the expected settlement.
 */
export function validateReceipt(
  data: Record<string, unknown>,
  expectedTxRef: string,
): ValidateReceiptResult {
  const result = ReceiptResponseSchema.safeParse(data);
  if (!result.success) {
    const rejectedFields = result.error.issues.map(
      (i) => i.path.join(".") || "(root)",
    );
    return {
      ok: false,
      violation: {
        id: `v-${randomUUID().slice(0, 8)}`,
        type: classifyViolation(rejectedFields),
        stage: "receipt",
        message: `Receipt schema validation failed: ${result.error.issues.map((i) => i.message).join(", ")}`,
        rejected_fields: rejectedFields,
        at: new Date().toISOString(),
      },
    };
  }

  // Check for receipt forgery: tx_ref mismatch
  if (result.data.tx_ref !== expectedTxRef) {
    return {
      ok: false,
      violation: {
        id: `v-${randomUUID().slice(0, 8)}`,
        type: "receipt_forgery",
        stage: "receipt",
        message: `Receipt tx_ref mismatch: got "${result.data.tx_ref}", expected "${expectedTxRef}"`,
        rejected_fields: ["tx_ref"],
        at: new Date().toISOString(),
      },
    };
  }

  return { ok: true, data: result.data };
}

/**
 * The ONLY door through which a provider response can enter the execution
 * context. Returns ok=true (with the validated data) or ok=false with a
 * fully-described violation.
 *
 * Checks, in order:
 *  1. Known attack surface fields (budget_mutation, scope_expansion,
 *     prompt_injection) — checked BEFORE schema parse so the violation
 *     type is accurate.
 *  2. Strict Zod schema parse — any extra field beyond the allowed shape
 *     is a schema_violation.
 *
 * Pure function of (schema, rawResponse). It never calls treasury or
 * ledger — the orchestrator calls this, gets a Result, and decides.
 */
export function guardResponse(
  schema: z.ZodTypeAny,
  raw: Record<string, unknown>,
): GuardResult {
  const allKeys = collectKeys(raw);

  // 1) Budget mutation attack
  const budgetFields = [...allKeys].filter((k) => BUDGET_MUTATION_FIELDS.has(k));
  if (budgetFields.length > 0) {
    return {
      ok: false,
      violation: makeViolation(
        "budget_mutation",
        "result",
        `Provider response contains budget-mutating field(s): ${budgetFields.join(", ")}`,
        budgetFields,
      ),
      raw,
    };
  }

  // 2) Scope expansion attack
  const scopeFields = [...allKeys].filter((k) => SCOPE_EXPANSION_FIELDS.has(k));
  if (scopeFields.length > 0) {
    return {
      ok: false,
      violation: makeViolation(
        "scope_expansion",
        "result",
        `Provider response tries to expand wallet scope: ${scopeFields.join(", ")}`,
        scopeFields,
      ),
      raw,
    };
  }

  // 3) Prompt injection attack
  const injectionKeys = [...allKeys].filter((k) => PROMPT_INJECTION_KEYS.has(k));
  if (injectionKeys.length > 0) {
    return {
      ok: false,
      violation: makeViolation(
        "prompt_injection",
        "result",
        `Provider response embeds instruction key(s): ${injectionKeys.join(", ")}`,
        injectionKeys,
      ),
      raw,
    };
  }

  // 4) Strict schema parse — any unrecognised field = structural rejection
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => i.path.join(".") || i.message);
    return {
      ok: false,
      violation: makeViolation(
        "schema_violation",
        "result",
        `Response failed strict schema parse: ${issues.join("; ")}`,
        issues,
      ),
      raw,
    };
  }

  return { ok: true, data: parsed.data as Record<string, unknown> };
}

function classifyViolation(rejectedFields: string[]): ViolationType {
  const lower = rejectedFields.map((f) => f.toLowerCase());

  if (lower.some((f) => BUDGET_MUTATION_FIELDS.has(f))) {
    return "budget_mutation";
  }
  if (lower.some((f) => SCOPE_EXPANSION_FIELDS.has(f))) {
    return "scope_expansion";
  }
  if (lower.some((f) => PROMPT_INJECTION_KEYS.has(f))) {
    return "prompt_injection";
  }

  return "schema_violation";
}

function makeViolation(
  type: ViolationType,
  stage: GuardStage,
  message: string,
  rejectedFields: string[],
): PolicyViolation {
  return {
    id: `v-${randomUUID().slice(0, 8)}`,
    type,
    stage,
    message,
    rejected_fields: rejectedFields,
    at: new Date().toISOString(),
  };
}

import { z } from "zod";
import { PolicyViolationSchema } from "./guard.js";

/**
 * NodeState — discriminated union representing every possible state of a
 * task node in the XState machine.
 *
 * This exact type is used by:
 *  - packages/orchestrator NodeMachine context
 *  - apps/service-orchestrator HTTP responses
 *  - apps/gateway WebSocket messages to the UI
 *  - apps/web React components (imported from @sentinel/schemas)
 *
 * One type, no translation layers.
 */
export const NodeStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pending") }).strict(),

  z.object({
    kind: z.literal("quoted"),
    invoiceId: z.string(),
    providerId: z.string(),
    priceHint: z.bigint(),
  }).strict(),

  z.object({
    kind: z.literal("paying"),
    idempotencyKey: z.string(),
    providerId: z.string(),
  }).strict(),

  z.object({
    kind: z.literal("paid"),
    txRef: z.string(),
    providerId: z.string(),
  }).strict(),

  z.object({
    kind: z.literal("validating"),
    txRef: z.string(),
  }).strict(),

  z.object({
    kind: z.literal("settled"),
    txRef: z.string(),
    ledgerId: z.string(),
    providerId: z.string(),
  }).strict(),

  z.object({
    kind: z.literal("blocked"),
    violation: PolicyViolationSchema,
    providerId: z.string(),
  }).strict(),

  z.object({
    kind: z.literal("failed"),
    error: z.string(),
    providerId: z.string().optional(),
  }).strict(),
]);

export type NodeState = z.infer<typeof NodeStateSchema>;

// ─── Task-level execution status ─────────────────────────────────────────────

export const TaskStatusSchema = z.enum([
  "planning",
  "executing",
  "paused",
  "completed",
  "aborted",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const BudgetStatusSchema = z
  .object({
    cap: z.bigint(),
    spent: z.bigint(),
    reserved: z.bigint(),
    available: z.bigint(),
  })
  .strict();

export type BudgetStatus = z.infer<typeof BudgetStatusSchema>;

export const PauseInfoSchema = z
  .object({
    nodeIds: z.array(z.string()),
    amounts: z.array(z.bigint()),
    overspend: z.bigint(),
    projected: z.bigint(),
    cap: z.bigint(),
  })
  .strict();

export type PauseInfo = z.infer<typeof PauseInfoSchema>;

export const ExecutionStatusSchema = z
  .object({
    taskId: z.string(),
    status: TaskStatusSchema,
    nodes: z.record(z.string(), NodeStateSchema),
    budget: BudgetStatusSchema,
    pauseInfo: PauseInfoSchema.optional(),
    startedAt: z.string(),
    finishedAt: z.string().optional(),
  })
  .strict();

export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

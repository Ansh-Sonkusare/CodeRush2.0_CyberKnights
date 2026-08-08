import { z } from "zod";
import { PolicyViolationSchema } from "./guard.js";
import { RouteProfileResolutionSchema, TaskGraphSchema } from "./planner.js";

/** Money on the wire — bigint leaves leave every HTTP/WS boundary as decimal
 * strings (jsonStringify); a UI/HTTP consumer parses with this shape. */
export const microAlgoDecimalString = z
  .string()
  .regex(/^\d+$/, "microAlgo as decimal string");

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
    simulated: z.boolean(),
    providerId: z.string(),
  }).strict(),

  z.object({
    kind: z.literal("validating"),
    txRef: z.string(),
  }).strict(),

  z.object({
    kind: z.literal("settled"),
    txRef: z.string(),
    simulated: z.boolean(),
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
    // The planned task graph — set once planning finishes. The UI renders the
    // React Flow graph from this (fallback skeleton is not the real plan).
    graph: TaskGraphSchema.optional(),
    planSource: z.enum(["planner", "fallback"]).optional(),
    route_profile: RouteProfileResolutionSchema.optional(),
    nodes: z.record(z.string(), NodeStateSchema),
    budget: BudgetStatusSchema,
    pauseInfo: PauseInfoSchema.optional(),
    startedAt: z.string(),
    finishedAt: z.string().optional(),
  })
  .strict();

export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

// ─── Wire variants (what actually crosses HTTP/WS) ────────────────────────────
// In-process state keeps MicroAlgo as bigint; every HTTP/WS boundary serializes
// bigint leaves as decimal strings (jsonStringify). These schemas are what a
// UI/HTTP consumer parses — the shape is identical, only money fields differ.
// The discriminated unions stay the same NodeState shape the machines emit.

export const NodeStateWireSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pending") }).strict(),

  z.object({
    kind: z.literal("quoted"),
    invoiceId: z.string(),
    providerId: z.string(),
    priceHint: microAlgoDecimalString,
  }).strict(),

  z.object({
    kind: z.literal("paying"),
    idempotencyKey: z.string(),
    providerId: z.string(),
  }).strict(),

  z.object({
    kind: z.literal("paid"),
    txRef: z.string(),
    simulated: z.boolean(),
    providerId: z.string(),
  }).strict(),

  z.object({
    kind: z.literal("validating"),
    txRef: z.string(),
  }).strict(),

  z.object({
    kind: z.literal("settled"),
    txRef: z.string(),
    simulated: z.boolean(),
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

export type NodeStateWire = z.infer<typeof NodeStateWireSchema>;

export const BudgetStatusWireSchema = z
  .object({
    cap: microAlgoDecimalString,
    spent: microAlgoDecimalString,
    reserved: microAlgoDecimalString,
    available: microAlgoDecimalString,
  })
  .strict();

export type BudgetStatusWire = z.infer<typeof BudgetStatusWireSchema>;

export const PauseInfoWireSchema = z
  .object({
    nodeIds: z.array(z.string()),
    amounts: z.array(microAlgoDecimalString),
    overspend: microAlgoDecimalString,
    projected: microAlgoDecimalString,
    cap: microAlgoDecimalString,
  })
  .strict();

export type PauseInfoWire = z.infer<typeof PauseInfoWireSchema>;

export const ExecutionStatusWireSchema = z
  .object({
    taskId: z.string(),
    status: TaskStatusSchema,
    graph: TaskGraphSchema.optional(),
    planSource: z.enum(["planner", "fallback"]).optional(),
    route_profile: RouteProfileResolutionSchema.optional(),
    nodes: z.record(z.string(), NodeStateWireSchema),
    budget: BudgetStatusWireSchema,
    pauseInfo: PauseInfoWireSchema.optional(),
    startedAt: z.string(),
    finishedAt: z.string().optional(),
  })
  .strict();

export type ExecutionStatusWire = z.infer<typeof ExecutionStatusWireSchema>;

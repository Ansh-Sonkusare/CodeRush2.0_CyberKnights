import { z } from "zod";
import { NodeStateSchema } from "./node-state.js";
import { BudgetStatusSchema, PauseInfoSchema } from "./node-state.js";

/**
 * WsMessage — every message type sent over the gateway WebSocket.
 *
 * Uses the same NodeState discriminated union as the XState machines.
 * No gateway-specific envelope invented on top — same type end-to-end.
 */
export const WsMessageSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("task_started"),
    taskId: z.string(),
    goal: z.string(),
    at: z.string(),
  }).strict(),

  z.object({
    event: z.literal("node_state"),
    taskId: z.string(),
    nodeId: z.string(),
    state: NodeStateSchema,
    at: z.string(),
  }).strict(),

  z.object({
    event: z.literal("task_paused"),
    taskId: z.string(),
    pauseInfo: PauseInfoSchema,
    budget: BudgetStatusSchema,
    at: z.string(),
  }).strict(),

  z.object({
    event: z.literal("task_done"),
    taskId: z.string(),
    budget: BudgetStatusSchema,
    durationMs: z.number(),
    at: z.string(),
  }).strict(),

  z.object({
    event: z.literal("task_aborted"),
    taskId: z.string(),
    error: z.string().optional(),
    at: z.string(),
  }).strict(),
]);

export type WsMessage = z.infer<typeof WsMessageSchema>;

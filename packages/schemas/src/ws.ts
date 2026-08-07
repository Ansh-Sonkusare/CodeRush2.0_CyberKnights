import { z } from "zod";
import {
  BudgetStatusSchema,
  BudgetStatusWireSchema,
  NodeStateSchema,
  NodeStateWireSchema,
  PauseInfoSchema,
  PauseInfoWireSchema,
} from "./node-state.js";
import { TaskGraphSchema } from "./planner.js";

/**
 * WsMessage — every message type sent over the gateway WebSocket.
 *
 * Uses the same NodeState discriminated union as the XState machines.
 * No gateway-specific envelope invented on top — same type end-to-end.
 *
 * `task_started` carries the planned graph so the UI can render the real
 * React Flow graph the moment planning finishes (not a fallback skeleton).
 * `node_state` carries the current budget so the UI's budget bar stays live
 * across the whole run, not just on pause/done.
 */
export const WsMessageSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("task_started"),
    taskId: z.string(),
    goal: z.string(),
    graph: TaskGraphSchema,
    planSource: z.enum(["planner", "fallback"]),
    at: z.string(),
  }).strict(),

  z.object({
    event: z.literal("node_state"),
    taskId: z.string(),
    nodeId: z.string(),
    state: NodeStateSchema,
    budget: BudgetStatusSchema,
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

// ─── Wire variant ─────────────────────────────────────────────────────────────
// Same messages as sent over the wire (bigint leaves as decimal strings). A
// UI/HTTP consumer parses frames with this schema — money fields are strings.
export const WsMessageWireSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("task_started"),
    taskId: z.string(),
    goal: z.string(),
    graph: TaskGraphSchema,
    planSource: z.enum(["planner", "fallback"]),
    at: z.string(),
  }).strict(),

  z.object({
    event: z.literal("node_state"),
    taskId: z.string(),
    nodeId: z.string(),
    state: NodeStateWireSchema,
    budget: BudgetStatusWireSchema,
    at: z.string(),
  }).strict(),

  z.object({
    event: z.literal("task_paused"),
    taskId: z.string(),
    pauseInfo: PauseInfoWireSchema,
    budget: BudgetStatusWireSchema,
    at: z.string(),
  }).strict(),

  z.object({
    event: z.literal("task_done"),
    taskId: z.string(),
    budget: BudgetStatusWireSchema,
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

export type WsMessageWire = z.infer<typeof WsMessageWireSchema>;

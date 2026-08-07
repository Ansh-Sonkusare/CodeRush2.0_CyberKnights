import { EventEmitter } from "node:events";
import { TaskGraph, GuardViolation } from "../types.js";
import { BudgetStatus } from "../treasury/treasury.js";
import { ExecutionSummary, PauseInfo } from "./executor.js";

/** Every event the executor can emit. Strongly typed via overloads. */
export interface ExecutorEvents {
  task_started: [payload: { taskId: string; graph: TaskGraph }];
  node_queued:  [payload: { nodeId: string; capability: string; label: string }];
  node_started: [payload: { nodeId: string; provider: string; price: number; attempt: number }];
  node_settled: [payload: { nodeId: string; txRef: string; price: number; provider: string }];
  node_blocked: [payload: { nodeId: string; violation: GuardViolation; provider: string }];
  node_failed:  [payload: { nodeId: string; error: string }];
  task_paused:  [payload: { pauseInfo: PauseInfo; budget: BudgetStatus }];
  task_approved:[payload: { delta: number; budget: BudgetStatus }];
  task_rejected:[payload: Record<string, never>];
  task_done:    [payload: { summary: ExecutionSummary }];
  task_aborted: [payload: { summary: ExecutionSummary }];
}

/**
 * Typed event bus tapped into the TaskExecutor.
 * Pass an instance as `bus` in the executor constructor options.
 * All existing code that doesn't pass a bus is unaffected.
 */
export class ExecutorBus extends EventEmitter {
  emit<K extends keyof ExecutorEvents>(
    event: K,
    payload: ExecutorEvents[K][0],
  ): boolean {
    return super.emit(event as string, payload);
  }

  on<K extends keyof ExecutorEvents>(
    event: K,
    listener: (payload: ExecutorEvents[K][0]) => void,
  ): this {
    return super.on(event as string, listener);
  }

  once<K extends keyof ExecutorEvents>(
    event: K,
    listener: (payload: ExecutorEvents[K][0]) => void,
  ): this {
    return super.once(event as string, listener);
  }
}

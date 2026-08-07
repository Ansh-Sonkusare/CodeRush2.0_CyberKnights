import { GuardViolation, TaskGraph } from "./api-types";

// ─── WsEvent shapes ────────────────────────────────────────────────────────────

export interface BudgetStatus {
  cap: number;
  spent: number;
  reserved: number;
}

export interface PauseInfo {
  nodeId: string;
  amounts: number[];
  overspend: number;
  projected: number;
  cap: number;
  ledgerIds: string[];
}

export interface StepExecution {
  step: { id: string; label: string; capability: string; dependsOn: string[] };
  status: "running" | "success" | "declared_failure" | "pending_approval" | "aborted";
  providerId?: string;
  price?: number;
  txRef?: string;
  error?: string;
}

export interface ExecutionSummary {
  taskId: string;
  status: "completed" | "aborted";
  steps: StepExecution[];
  budget: BudgetStatus;
  durationMs: number;
}

export type WsEvent =
  | { event: "task_started";  taskId: string; graph: TaskGraph }
  | { event: "node_queued";   nodeId: string; capability: string; label: string }
  | { event: "node_started";  nodeId: string; provider: string; price: number; attempt: number }
  | { event: "node_settled";  nodeId: string; txRef: string; price: number; provider: string }
  | { event: "node_blocked";  nodeId: string; violation: GuardViolation; provider: string }
  | { event: "node_failed";   nodeId: string; error: string }
  | { event: "task_paused";   pauseInfo: PauseInfo; budget: BudgetStatus }
  | { event: "task_approved"; delta: number; budget: BudgetStatus }
  | { event: "task_rejected" }
  | { event: "task_done";     summary: ExecutionSummary }
  | { event: "task_aborted";  summary: ExecutionSummary };

// ─── Node state (derived from WsEvents) ───────────────────────────────────────

export type NodePhase =
  | "idle"
  | "queued"
  | "running"
  | "settled"
  | "blocked"
  | "failed"
  | "aborted"
  | "pending_approval";

export interface NodeState {
  phase: NodePhase;
  provider?: string;
  price?: number;
  txRef?: string;
  violation?: GuardViolation;
  error?: string;
  attempt?: number;
}

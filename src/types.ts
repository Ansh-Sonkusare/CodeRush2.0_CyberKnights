export type Capability = "search" | "extract" | "translate" | "rank" | "verify";

export interface ProviderCatalogEntry {
  provider_id: string;
  capability: Capability;
  price: number;
  latency_ms: number;
  quality_score: number;
  base_url: string;
  role?: "primary" | "backup";
}

export interface Budget {
  task_id: string;
  cap: number;
  spent: number;
  reserved: number;
}

export type LedgerStageName =
  | "402_terms"
  | "payment"
  | "settlement"
  | "response"
  | "receipt";

export type LedgerStageStatus =
  | "pending"
  | "sent"
  | "received"
  | "settled"
  | "failed"
  | "skipped";

export interface LedgerStage {
  name: LedgerStageName;
  at: string;
  status: LedgerStageStatus;
  detail: Record<string, unknown>;
}

export type LedgerOutcome =
  | "success"
  | "declared_failure"
  | "pending_approval";

export type ViolationType =
  | "budget_mutation"
  | "scope_expansion"
  | "prompt_injection"
  | "receipt_forgery"
  | "schema_violation";

export type GuardStage = "terms" | "result" | "receipt";

export interface GuardViolation {
  id: string;
  type: ViolationType;
  stage: GuardStage;
  message: string;
  rejected_fields: string[];
  at: string;
}

export interface LedgerRow {
  ledger_id: string;
  task_id: string;
  node_id: string;
  idempotency_key: string;
  provider_id: string;
  capability: Capability;
  route_reason: string;
  stages: Record<LedgerStageName, LedgerStage>;
  outcome: LedgerOutcome;
  violations?: GuardViolation[];
  created_at: string;
}

export interface TaskStep {
  id: string;
  label: string;
  capability: Capability;
  dependsOn: string[];
}

export interface TaskGraph {
  task_id: string;
  name: string;
  budget_cap: number;
  goal: string;
  steps: TaskStep[];
}

export interface ScopeToken {
  provider_id: string;
  max_amount: number;
  spent: number;
}

export interface PaymentRequest {
  task_id: string;
  node_id: string;
  capability: Capability;
  provider_id: string;
  idempotency_key: string;
  amount: number;
  scope_token: string;
}

export interface SettlementRecord {
  idempotency_key: string;
  tx_ref: string;
  amount: number;
  provider_id: string;
  task_id: string;
  node_id: string;
  scope_token: string;
  settled_at: string;
  first_payment: boolean;
}

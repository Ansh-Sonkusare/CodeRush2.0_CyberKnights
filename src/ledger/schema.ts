import {
  Capability,
  LedgerRow,
  LedgerStage,
  LedgerStageName,
  LedgerStageStatus,
  LedgerOutcome,
} from "../types.js";

export const SCHEMA_VERSION = "1.0.0";

const STAGE_ORDER: LedgerStageName[] = [
  "402_terms",
  "payment",
  "settlement",
  "response",
  "receipt",
];

export function emptyStage(name: LedgerStageName): LedgerStage {
  return {
    name,
    at: "",
    status: "pending",
    detail: {},
  };
}

export function newStage(
  name: LedgerStageName,
  status: LedgerStageStatus,
  detail: Record<string, unknown> = {},
): LedgerStage {
  return {
    name,
    at: new Date().toISOString(),
    status,
    detail,
  };
}

export interface NewLedgerRowInput {
  ledger_id: string;
  task_id: string;
  node_id: string;
  idempotency_key: string;
  provider_id: string;
  capability: Capability;
  route_reason: string;
}

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
    outcome: "pending_approval" as LedgerOutcome,
    created_at: new Date().toISOString(),
  };
}

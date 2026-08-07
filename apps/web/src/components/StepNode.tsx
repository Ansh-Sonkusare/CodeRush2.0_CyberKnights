import { memo } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import type { NodeStateWire } from "@sentinel/schemas";
import { formatMicroAlgo } from "../format";

export interface StepNodeData {
  label: string;
  capability: string;
  nodeState: NodeStateWire;
  [key: string]: unknown;
}

const CAPABILITY_COLORS: Record<string, string> = {
  search: "#6366f1",
  extract: "#8b5cf6",
  translate: "#06b6d4",
  rank: "#f59e0b",
  verify: "#10b981",
  fetch_wallet_data: "#22d3ee",
  generate_summary: "#a78bfa",
  score_credit: "#34d399",
};

const KIND_LABELS: Record<NodeStateWire["kind"], string> = {
  pending: "pending",
  quoted: "quoted",
  paying: "paying…",
  paid: "paid",
  validating: "validating…",
  settled: "settled ✓",
  blocked: "blocked ⛔",
  failed: "failed ✗",
};

/** Show tx ref for paid/settled (shortened). */
function txRefFor(state: NodeStateWire): string | null {
  switch (state.kind) {
    case "paid":
    case "settled":
      return state.txRef;
    default:
      return null;
  }
}

/** Show provider row for any provider-touching state. */
function providerFor(state: NodeStateWire): string | null {
  switch (state.kind) {
    case "quoted":
    case "paying":
    case "paid":
    case "settled":
    case "blocked":
      return state.providerId;
    case "failed":
      return state.providerId ?? null;
    default:
      return null;
  }
}

function StepNode({ data }: NodeProps) {
  const d = data as StepNodeData;
  const { label, capability, nodeState } = d;
  const capColor = CAPABILITY_COLORS[capability] ?? "#64748b";
  const provider = providerFor(nodeState);
  const txRef = txRefFor(nodeState);

  return (
    <div className={`step-node node-${nodeState.kind}`}>
      <Handle type="target" position={Position.Top} className="node-handle" />

      <div
        className="cap-badge"
        style={{
          background: capColor + "22",
          color: capColor,
          borderColor: capColor + "44",
        }}
      >
        {capability}
      </div>

      <div className="node-label">{label}</div>
      <div className="phase-label">{KIND_LABELS[nodeState.kind]}</div>

      {provider !== null && (
        <div className="node-meta">
          <span className="provider-name">{provider}</span>
          {nodeState.kind === "quoted" && (
            <span className="price">{formatMicroAlgo(nodeState.priceHint)}</span>
          )}
        </div>
      )}

      {txRef !== null && (
        <div className="tx-ref" title={txRef}>
          {txRef.slice(0, 14)}…
        </div>
      )}

      {nodeState.kind === "blocked" && (
        <div className="violation-badge" title={nodeState.violation.message}>
          ⛔ {nodeState.violation.type}
        </div>
      )}

      {nodeState.kind === "failed" && (
        <div className="error-text" title={nodeState.error}>
          {nodeState.error.length > 48 ? nodeState.error.slice(0, 48) + "…" : nodeState.error}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="node-handle" />
    </div>
  );
}

export default memo(StepNode);

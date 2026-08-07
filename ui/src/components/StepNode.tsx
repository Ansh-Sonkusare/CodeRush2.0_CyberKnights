import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { NodeState } from "../types";

export interface StepNodeData {
  label: string;
  capability: string;
  nodeState: NodeState;
  [key: string]: unknown;
}

const CAPABILITY_COLORS: Record<string, string> = {
  search:    "#6366f1",
  extract:   "#8b5cf6",
  translate: "#06b6d4",
  rank:      "#f59e0b",
  verify:    "#10b981",
};

const PHASE_LABELS: Record<string, string> = {
  idle:             "idle",
  queued:           "queued",
  running:          "paying…",
  settled:          "settled ✓",
  blocked:          "blocked ⛔",
  failed:           "failed ✗",
  aborted:          "aborted",
  pending_approval: "awaiting approval",
};

function phaseClass(phase: string): string {
  switch (phase) {
    case "queued":           return "node-queued";
    case "running":          return "node-running";
    case "settled":          return "node-settled";
    case "blocked":          return "node-blocked";
    case "failed":           return "node-failed";
    case "aborted":          return "node-aborted";
    case "pending_approval": return "node-approval";
    default:                 return "node-idle";
  }
}

function StepNode({ data }: NodeProps) {
  const d = data as StepNodeData;
  const { label, capability, nodeState } = d;
  const { phase, provider, price, txRef, violation, error } = nodeState;
  const capColor = CAPABILITY_COLORS[capability] ?? "#64748b";

  return (
    <div className={`step-node ${phaseClass(phase)}`}>
      <Handle type="target" position={Position.Top} className="node-handle" />

      {/* capability badge */}
      <div className="cap-badge" style={{ background: capColor + "22", color: capColor, borderColor: capColor + "44" }}>
        {capability}
      </div>

      {/* label */}
      <div className="node-label">{label}</div>

      {/* phase ring label */}
      <div className="phase-label">{PHASE_LABELS[phase] ?? phase}</div>

      {/* provider / price row */}
      {provider && phase !== "idle" && phase !== "queued" && (
        <div className="node-meta">
          <span className="provider-name">{provider}</span>
          {price !== undefined && (
            <span className="price">${price.toFixed(4)}</span>
          )}
        </div>
      )}

      {/* tx ref on settle */}
      {txRef && phase === "settled" && (
        <div className="tx-ref" title={txRef}>{txRef.slice(0, 12)}…</div>
      )}

      {/* violation badge */}
      {violation && (
        <div className="violation-badge" title={violation.message}>
          ⛔ {violation.type}
        </div>
      )}

      {/* error short */}
      {error && phase === "failed" && (
        <div className="error-text" title={error}>
          {error.length > 48 ? error.slice(0, 48) + "…" : error}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="node-handle" />
    </div>
  );
}

export default memo(StepNode);

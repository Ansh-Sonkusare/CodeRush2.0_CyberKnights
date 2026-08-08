import { memo } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import type { NodeStateWire } from "@sentinel/schemas";
import { formatMicroAlgo } from "../format";

export interface StepNodeData {
  label: string;
  capability: string;
  nodeState: NodeStateWire;
  /** Payment scheme + network for the currently-selected provider, when the
   * catalog advertises them (MVD node-card chips). */
  providerMeta?: { scheme?: string; network?: string } | null;
  /** Provider this node fell back to after a failed attempt (from reroute tracking). */
  fellBackTo?: string | null;
  [key: string]: unknown;
}

// Covers all 8 routeable capabilities (3 core + the 5 MVD capabilities):
// search / extract / translate / rank / verify + fetch_wallet_data /
// generate_summary / score_credit. Ids match packages/schemas capability.ts.
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

/** Show tx ref for paid/settled (shortened), null when not yet paid. */
function txRefFor(state: NodeStateWire): { ref: string; simulated: boolean } | null {
  switch (state.kind) {
    case "paid":
    case "settled":
      return { ref: state.txRef, simulated: state.simulated };
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
  const { label, capability, nodeState, providerMeta, fellBackTo } = d;
  const capColor = CAPABILITY_COLORS[capability] ?? "#64748b";
  const provider = providerFor(nodeState);
  const tx = txRefFor(nodeState);
  const fellBack = fellBackTo !== null && fellBackTo !== undefined && fellBackTo === provider;

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

      {provider !== null &&
        (providerMeta?.scheme !== undefined || providerMeta?.network !== undefined) && (
          <div className="node-chips">
            {providerMeta.scheme !== undefined && (
              <span className="node-chip" title="payment scheme">
                {providerMeta.scheme}
              </span>
            )}
            {providerMeta.network !== undefined && (
              <span className="node-chip" title="network">
                {providerMeta.network}
              </span>
            )}
          </div>
        )}

      {fellBack && (
        <div className="fallback-badge" title="this node failed once and was re-routed here">
          fell back to {fellBack}
        </div>
      )}

      {tx !== null &&
        (tx.simulated ? (
          <div className="tx-ref tx-sim" title={`${tx.ref} — simulated, not on-chain`}>
            <span className="tx-sim-badge">sim</span>
            {tx.ref.slice(0, 14)}…
          </div>
        ) : (
          <a
            className="tx-ref tx-real"
            href={`https://testnet.explorer.algorand.org/tx/${tx.ref}`}
            target="_blank"
            rel="noopener noreferrer"
            title={tx.ref}
          >
            {tx.ref.slice(0, 14)}…
          </a>
        ))}

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

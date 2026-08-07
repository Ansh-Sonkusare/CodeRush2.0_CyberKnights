import { useEffect, useRef, useState, useCallback } from "react";
import type { WsEvent, NodeState, NodePhase, BudgetStatus, PauseInfo, ExecutionSummary } from "../types";
import type { GuardViolation } from "../api-types";

const WS_URL = "ws://localhost:4300/ws";

export interface GraphState {
  nodes: Map<string, NodeState>;
  budget: BudgetStatus | null;
  pauseInfo: PauseInfo | null;
  taskStatus: "idle" | "running" | "paused" | "done" | "aborted";
  summary: ExecutionSummary | null;
  violations: Array<{ nodeId: string; violation: GuardViolation }>;
  events: WsEvent[];
}

const DEFAULT_STATE: GraphState = {
  nodes: new Map(),
  budget: null,
  pauseInfo: null,
  taskStatus: "idle",
  summary: null,
  violations: [],
  events: [],
};

function setNodePhase(
  prev: Map<string, NodeState>,
  nodeId: string,
  update: Partial<NodeState>,
): Map<string, NodeState> {
  const next = new Map(prev);
  const existing = next.get(nodeId) ?? { phase: "idle" as NodePhase };
  next.set(nodeId, { ...existing, ...update });
  return next;
}

export function useWs() {
  const [state, setState] = useState<GraphState>(DEFAULT_STATE);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data) as WsEvent;
        setState((prev) => applyEvent(prev, ev));
      } catch { /* ignore malformed */ }
    };

    ws.onclose = () => {
      reconnectTimer.current = setTimeout(connect, 2000);
    };

    ws.onerror = () => ws.close();
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const reset = useCallback(() => setState(DEFAULT_STATE), []);

  return { state, reset };
}

function applyEvent(prev: GraphState, ev: WsEvent): GraphState {
  const events = [...prev.events, ev].slice(-200); // keep last 200

  switch (ev.event) {
    case "task_started":
      return {
        ...DEFAULT_STATE,
        events,
        taskStatus: "running",
        budget: null,
      };

    case "node_queued":
      return {
        ...prev,
        events,
        nodes: setNodePhase(prev.nodes, ev.nodeId, { phase: "queued" }),
      };

    case "node_started":
      return {
        ...prev,
        events,
        nodes: setNodePhase(prev.nodes, ev.nodeId, {
          phase: "running",
          provider: ev.provider,
          price: ev.price,
          attempt: ev.attempt,
        }),
      };

    case "node_settled":
      return {
        ...prev,
        events,
        nodes: setNodePhase(prev.nodes, ev.nodeId, {
          phase: "settled",
          txRef: ev.txRef,
          provider: ev.provider,
          price: ev.price,
        }),
      };

    case "node_blocked": {
      return {
        ...prev,
        events,
        nodes: setNodePhase(prev.nodes, ev.nodeId, {
          phase: "blocked",
          violation: ev.violation,
          provider: ev.provider,
        }),
        violations: [...prev.violations, { nodeId: ev.nodeId, violation: ev.violation }],
      };
    }

    case "node_failed":
      return {
        ...prev,
        events,
        nodes: setNodePhase(prev.nodes, ev.nodeId, {
          phase: "failed",
          error: ev.error,
        }),
      };

    case "task_paused":
      return {
        ...prev,
        events,
        taskStatus: "paused",
        pauseInfo: ev.pauseInfo,
        budget: ev.budget,
      };

    case "task_approved":
      return {
        ...prev,
        events,
        taskStatus: "running",
        pauseInfo: null,
        budget: ev.budget,
      };

    case "task_rejected":
      return {
        ...prev,
        events,
        taskStatus: "running",
        pauseInfo: null,
      };

    case "task_done":
      return {
        ...prev,
        events,
        taskStatus: "done",
        summary: ev.summary,
        budget: ev.summary.budget,
        pauseInfo: null,
      };

    case "task_aborted":
      return {
        ...prev,
        events,
        taskStatus: "aborted",
        summary: ev.summary,
        budget: ev.summary?.budget ?? prev.budget,
        pauseInfo: null,
      };

    default:
      return { ...prev, events };
  }
}

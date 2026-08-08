/**
 * useWs — subscribes to the gateway's /ws hub and folds every frame (parsed
 * with the WsMessageWire discriminated union) into UI state.
 *
 * A "watch id" gates which task's frames are applied — the UI can attach to a
 * past task for replay without a second connection, and frames for concurrent
 * tasks are ignored. hydrate() merges a REST-fetched ExecutionStatusWire so a
 * late reattach catches up on anything broadcast before the WS connection.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  WsMessageWireSchema,
  type BudgetStatusWire,
  type ExecutionStatusWire,
  type NodeStateWire,
  type PauseInfoWire,
  type TaskGraph,
  type WsMessageWire,
} from "@sentinel/schemas";

export type UiTaskStatus =
  | "idle"
  | "planning"
  | "running"
  | "paused"
  | "completed"
  | "aborted";

export interface BlockedEntry {
  nodeId: string;
  providerId: string;
  violation: {
    id: string;
    type: string;
    message: string;
    rejected_fields: string[];
    at: string;
  };
}

export interface UiEvent {
  at: string;
  text: string;
}

export interface UiState {
  taskId: string | null;
  goal: string | null;
  planSource: "planner" | "fallback" | null;
  graph: TaskGraph | null;
  nodes: Record<string, NodeStateWire>;
  budget: BudgetStatusWire | null;
  pauseInfo: PauseInfoWire | null;
  status: UiTaskStatus;
  violations: BlockedEntry[];
  events: UiEvent[];
  connected: boolean;
}

const DEFAULT_STATE: UiState = {
  taskId: null,
  goal: null,
  planSource: null,
  graph: null,
  nodes: {},
  budget: null,
  pauseInfo: null,
  status: "idle",
  violations: [],
  events: [],
  connected: false,
};

const MAX_EVENTS = 300;

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

function pushEvent(prev: UiState, at: string, text: string): UiEvent[] {
  return [...prev.events, { at, text }].slice(-MAX_EVENTS);
}

function kindDetail(state: NodeStateWire): string {
  switch (state.kind) {
    case "quoted":
    case "paying":
    case "paid":
    case "settled":
      return ` (${state.providerId})`;
    case "blocked":
      return ` ⛔ ${state.violation.type}`;
    case "failed":
      return state.error ? `: ${state.error}` : "";
    case "pending":
    case "validating":
      return "";
  }
}

function mapTaskStatus(status: ExecutionStatusWire["status"]): UiTaskStatus {
  switch (status) {
    case "planning":
      return "planning";
    case "executing":
      return "running";
    case "paused":
      return "paused";
    case "completed":
      return "completed";
    case "aborted":
      return "aborted";
  }
}

function applyEvent(prev: UiState, frame: WsMessageWire): UiState {
  switch (frame.event) {
    case "task_started":
      return {
        ...prev,
        goal: frame.goal,
        graph: frame.graph,
        planSource: frame.planSource,
        status: "running",
        events: pushEvent(
          prev,
          frame.at,
          `plan ready (${frame.planSource}) — ${frame.graph.steps.length} node${frame.graph.steps.length === 1 ? "" : "s"}`,
        ),
      };

    case "node_state": {
      const nodes = { ...prev.nodes, [frame.nodeId]: frame.state };
      const violations =
        frame.state.kind === "blocked"
          ? [
              ...prev.violations,
              {
                nodeId: frame.nodeId,
                providerId: frame.state.providerId,
                violation: frame.state.violation,
              },
            ]
          : prev.violations;
      return {
        ...prev,
        nodes,
        budget: frame.budget,
        status: prev.status === "planning" ? "running" : prev.status,
        violations,
        events: pushEvent(
          prev,
          frame.at,
          `${frame.nodeId} → ${frame.state.kind}${kindDetail(frame.state)}`,
        ),
      };
    }

    case "task_paused":
      return {
        ...prev,
        status: "paused",
        pauseInfo: frame.pauseInfo,
        budget: frame.budget,
        events: pushEvent(prev, frame.at, "task paused — approval needed"),
      };

    case "task_done":
      return {
        ...prev,
        status: "completed",
        pauseInfo: null,
        budget: frame.budget,
        events: pushEvent(prev, frame.at, `task done in ${(frame.durationMs / 1000).toFixed(1)}s`),
      };

    case "task_aborted":
      return {
        ...prev,
        status: "aborted",
        pauseInfo: null,
        events: pushEvent(
          prev,
          frame.at,
          frame.error !== undefined ? `task aborted: ${frame.error}` : "task aborted",
        ),
      };
  }
}

export function useWs() {
  const [state, setState] = useState<UiState>(DEFAULT_STATE);
  const [watchId, setWatchId] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<number | null>(null);
  const backoffRef = useRef(0);
  const watchIdRef = useRef<string | null>(null);
  watchIdRef.current = watchId;

  const connect = useCallback(() => {
    if (
      wsRef.current !== null &&
      (wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const ws = new WebSocket(wsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      backoffRef.current = 0;
      setState((prev) => ({ ...prev, connected: true }));
    };

    ws.onmessage = (msg) => {
      let frame: WsMessageWire;
      try {
        const parsed = WsMessageWireSchema.safeParse(JSON.parse(String(msg.data)));
        if (!parsed.success) return;
        frame = parsed.data;
      } catch {
        return;
      }
      if (watchIdRef.current !== null && frame.taskId !== watchIdRef.current) {
        return; // frames for another task are ignored
      }
      setState((prev) => applyEvent(prev, frame));
    };

    ws.onerror = () => ws.close();

    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null;
      setState((prev) => ({ ...prev, connected: false }));
      const delay = Math.min(5000, 500 * 2 ** backoffRef.current);
      backoffRef.current += 1;
      timerRef.current = window.setTimeout(connect, delay);
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  /** Start following a task id (clears previous state). */
  const watch = useCallback((id: string) => {
    setWatchId(id);
    setState((prev) => ({
      ...DEFAULT_STATE,
      taskId: id,
      status: "planning",
      // Keep the live socket state — onopen only fires once, so a fresh task
      // must not flip the header to "ws reconnecting…" nor gray the Run button.
      connected: prev.connected,
    }));
  }, []);

  /** Stop following; back to the idle screen. */
  const clear = useCallback(() => {
    setWatchId(null);
    setState((prev) => ({ ...DEFAULT_STATE, connected: prev.connected }));
  }, []);

  /**
   * Merge a REST-fetched status into live WS state. Live (WS) node states win
   * on conflict so a status response that lands after fresher frames can't
   * regress the UI; status only fills gaps (fresh attach / replay).
   */
  const hydrate = useCallback((status: ExecutionStatusWire) => {
    setState((prev) => ({
      ...prev,
      taskId: status.taskId,
      status: mapTaskStatus(status.status),
      goal: status.graph?.goal ?? prev.goal,
      graph: status.graph ?? prev.graph,
      planSource: status.planSource ?? prev.planSource,
      nodes: { ...status.nodes, ...prev.nodes },
      budget: status.budget,
      pauseInfo: status.pauseInfo ?? null,
    }));
  }, []);

  return { state, watch, clear, hydrate };
}

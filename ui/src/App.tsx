import { useCallback, useEffect, useState } from "react";
import { useWs } from "./hooks/useWs";
import TaskGraphView from "./components/TaskGraph";
import type { TaskGraph } from "./api-types";
import type { WsEvent } from "./types";

const API = "http://localhost:4300";

type Scenario =
  | { kind: "happy" }
  | { kind: "attack"; node: string }
  | { kind: "tight-cap"; cap: number };

const SCENARIOS: Record<string, Scenario> = {
  happy: { kind: "happy" },
  "attack-search": { kind: "attack", node: "n-search" },
  "attack-extract": { kind: "attack", node: "n-extract" },
  "attack-rank": { kind: "attack", node: "n-rank" },
  "tight-cap": { kind: "tight-cap", cap: 0.05 },
};

export default function App() {
  const { state, reset } = useWs();
  const [graph, setGraph] = useState<TaskGraph | null>(null);
  const [scenario, setScenario] = useState("happy");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    fetch(`${API}/api/graph`)
      .then((r) => r.json())
      .then((g: TaskGraph) => setGraph(g))
      .catch(() => setGraph(null));
  }, []);

  useEffect(() => {
    if (state.taskStatus !== "idle") setSubmitted(false);
  }, [state.taskStatus]);

  const run = useCallback(async () => {
    const sc = SCENARIOS[scenario];
    if (!sc) return;
    setSubmitted(true);
    reset();
    const body: Record<string, unknown> = {};
    if (sc.kind === "attack") body.attack = sc.node;
    if (sc.kind === "tight-cap") body.cap = sc.cap;
    try {
      await fetch(`${API}/api/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      setSubmitted(false);
    }
  }, [scenario, reset]);

  const approve = useCallback(async () => {
    await fetch(`${API}/api/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delta: 0.5 }),
    });
  }, []);

  const reject = useCallback(async () => {
    await fetch(`${API}/api/reject`, { method: "POST" });
  }, []);

  const busy =
    submitted || state.taskStatus === "running" || state.taskStatus === "paused";
  const paused = state.taskStatus === "paused";
  const lastEvents = state.events.slice(-60);

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>x402 Payment Router — Live Trace</h1>
          <div className={`status status-${state.taskStatus}`}>
            {state.taskStatus === "idle" && "idle — pick a scenario and run"}
            {state.taskStatus === "running" && "running…"}
            {state.taskStatus === "paused" && "PAUSED — awaiting approval"}
            {state.taskStatus === "done" && "done"}
            {state.taskStatus === "aborted" && "aborted"}
          </div>
        </div>
        <div className="controls">
          <select
            value={scenario}
            onChange={(e) => setScenario(e.target.value)}
            disabled={busy}
          >
            <option value="happy">Happy path</option>
            <option value="attack-search">Attack: evil-search (budget mutation)</option>
            <option value="attack-extract">Attack: evil-extract (scope expansion)</option>
            <option value="attack-rank">Attack: evil-rank (prompt injection)</option>
            <option value="tight-cap">Tight cap ($0.05 — pause / approval)</option>
          </select>
          <button onClick={run} disabled={busy}>
            Run
          </button>
          <button onClick={reset} className="ghost" disabled={busy}>
            Clear
          </button>
        </div>
      </header>

      {paused && state.pauseInfo && (
        <section className="pause-panel">
          <div>
            <strong>Budget approval needed.</strong> wave would spend{" "}
            ${state.pauseInfo.amounts.reduce((a, b) => a + b, 0).toFixed(4)} —
            projected ${state.pauseInfo.projected.toFixed(4)} vs cap $
            {state.pauseInfo.cap.toFixed(4)} (overspend $
            {state.pauseInfo.overspend.toFixed(4)})
          </div>
          <div className="pause-actions">
            <button onClick={approve} className="ok">
              Approve +$0.50
            </button>
            <button onClick={reject} className="danger">
              Deny
            </button>
          </div>
        </section>
      )}

      <section className="budget-bar">
        <span>
          spent{" "}
          <strong>
            {state.budget ? `$${state.budget.spent.toFixed(4)}` : "—"}
          </strong>
        </span>
        <span>
          reserved{" "}
          <strong>
            {state.budget ? `$${state.budget.reserved.toFixed(4)}` : "—"}
          </strong>
        </span>
        <span>
          cap{" "}
          <strong>
            {state.budget
              ? `$${state.budget.cap.toFixed(4)}`
              : graph
                ? `$${graph.budget_cap.toFixed(4)}`
                : "—"}
          </strong>
        </span>
      </section>

      <div className="main">
        <div className="canvas-wrap">
          {graph ? (
            <TaskGraphView graph={graph} nodeStates={state.nodes} />
          ) : (
            <p className="hint">
              Waiting for trace server… run <code>npm run trace-server</code>
            </p>
          )}
        </div>

        <aside className="side">
          <section className="panel">
            <h2>Blocked attacks</h2>
            {state.violations.length === 0 ? (
              <p className="muted">none — guard passed everything</p>
            ) : (
              <ul className="violations">
                {state.violations.map((v, i) => (
                  <li key={i} className="violation">
                    <span className="vtype">{v.violation.type}</span>
                    <span className="vnode">{v.nodeId}</span>
                    <span className="vmsg">{v.violation.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel">
            <h2>Event log</h2>
            {lastEvents.length === 0 ? (
              <p className="muted">no events yet</p>
            ) : (
              <ul className="events">
                {lastEvents.map((e, i) => (
                  <li key={i} className={`ev ev-${e.event}`}>
                    <EventLine e={e} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

function EventLine({ e }: { e: WsEvent }) {
  const node = (e as { nodeId?: string }).nodeId;
  return (
    <>
      <span className="ev-name">{e.event}</span>
      {node && <span className="ev-node">{node}</span>}
    </>
  );
}

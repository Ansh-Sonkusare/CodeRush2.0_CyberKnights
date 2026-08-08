import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  STAGE_ORDER,
  type LedgerExport,
  type LedgerRow,
  type ProviderCatalogEntryWire,
  type ProviderFailMode,
  type ReconciliationReportWire,
  type RunRequest,
  type TaskGraph,
} from "@sentinel/schemas";
import TaskGraphView from "./components/TaskGraph";
import { useWs } from "./hooks/useWs";
import {
  approveTask,
  getFallbackGraph,
  getLedgerExport,
  getLedgerRows,
  getProviders,
  getReconcile,
  getStatus,
  rejectTask,
  runTask,
  setProviderFailed,
  setProviderFailMode,
} from "./api";
import { budgetFraction, formatMicroAlgo, parseMicroAlgo } from "./format";

const DEFAULT_GOAL =
  "Assess this wallet 0x742d35Cc6634C0532925a3b844Bc454e4438f44e: fetch its on-chain data, summarize the activity, and produce a credit score.";

const ATTACK_SCENARIOS = [
  { value: "none", label: "none", nodeId: undefined, providerId: undefined },
  { value: "budget_mutation", label: "budget mutation (n-wallet)", nodeId: "n-wallet", providerId: "mock-wallet-data-adversarial" },
  { value: "scope_expansion", label: "scope expansion (n-summary)", nodeId: "n-summary", providerId: "mock-summary-adversarial" },
] as const;

type AttackValue = (typeof ATTACK_SCENARIOS)[number]["value"];

/**
 * One-click demo presets. Each preset pre-configures the run inputs (goal text,
 * cap, optional attackNode) and the provider fail-mode state (the MVD "fail
 * after payment" knob) so a presenter can drive a specific pipeline behavior
 * without touching the manual controls. Clicking a preset applies its knobs and
 * fires a run request (runTask) whose returned task id the watcher follows.
 *
 * The 6 presets map one-to-one to the MVD criteria: 5-step parallel,
 * fail-after-402 reroute, sub-budget pause → approve, reconcile, cheapest run,
 * quality run.
 */
interface DemoFlow {
  id: string;
  label: string;
  description: string;
  /** What to watch for during/after the run. */
  watch: string;
  /** Goal text — drives the planner's graph shape AND weightsForGoal routing. */
  goal: string;
  /** MicroAlgo cap (decimal string). Omit for the default cap. */
  cap?: string;
  /** Force a specific provider onto a node (guard demo knob). */
  attackNode?: RunRequest["attackNode"];
  /** Provider fail-modes to set before the run (others keep their current state). */
  failModes?: { providerId: string; mode: ProviderFailMode | null }[];
}

// Goal text that hits the planner's RANK_KEYWORDS (top/rank/best) so the
// fallback graph is the MVD 5-step parallel demo graph
// (search → extract ‖ translate → rank → verify).
const MVD_RANK_GOAL =
  "Research the top Algorand DeFi protocols: search for recent news, extract the key details from each source, translate non-English articles, rank the protocols, and verify every claim.";

const DEMO_FLOWS: DemoFlow[] = [
  {
    id: "mvd-parallel",
    label: "5-step parallel",
    description: "Rank & verify graph — search → extract ‖ translate → rank → verify, all providers healthy.",
    watch: "n-search, n-extract, n-translate, n-rank, n-verify settle in parallel",
    goal: MVD_RANK_GOAL,
  },
  {
    id: "mvd-fail-402",
    label: "fail-after-402 reroute",
    description: "mock-search fails after payment (declared failure) — the node reroutes to the backup with a fresh idempotency key. No double-spend.",
    watch: "n-search → paid then declared_failure · reroute to mock-search-backup · unique idempotency keys",
    goal: MVD_RANK_GOAL,
    failModes: [{ providerId: "mock-search", mode: "after_402" }],
  },
  {
    id: "mvd-pause",
    label: "sub-budget pause → approve",
    description: "A tight cap makes the last reservation overspend — the task pauses for approval.",
    watch: "task → paused · pauseInfo shows nodes/amounts · Approve the delta to resume",
    goal: MVD_RANK_GOAL,
    cap: "10",
  },
  {
    id: "mvd-reconcile",
    label: "reconcile",
    description: "A run with one declared failure — the Reconcile tab ties every paid request to a result.",
    watch: "Reconcile tab → success + declared_failure rows · dup-payment 1.0 · 0 overspend",
    goal: MVD_RANK_GOAL,
    failModes: [{ providerId: "mock-translate", mode: "after_402" }],
  },
  {
    id: "mvd-cheapest",
    label: "cheapest run",
    description: "Goal keywords (cheapest / cost) push the route profile to price — the router picks the cheap providers.",
    watch: "route_profile chip → price · cheap providers picked per step",
    goal:
      "Find the cheapest way to research the top Algorand DeFi protocols: search, extract, translate, rank, and verify while keeping cost to a minimum.",
  },
  {
    id: "mvd-quality",
    label: "quality run",
    description: "Goal keywords (quality / best / reliable) push the route profile to quality — the router picks the premium providers.",
    watch: "route_profile chip → quality · premium providers picked per step",
    goal:
      "Give me the highest quality, most reliable research on the top Algorand DeFi protocols: search, extract, translate, rank, and verify with the best providers.",
  },
];

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

export default function App() {
  const { state, watch, clear, hydrate } = useWs();

  // ─── Run controls ───────────────────────────────────────────────────────────
  const [goal, setGoal] = useState(DEFAULT_GOAL);
  const [cap, setCap] = useState("");
  const [attack, setAttack] = useState<AttackValue>("none");
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [delta, setDelta] = useState("");

  // ─── Data ───────────────────────────────────────────────────────────────────
  const [providers, setProviders] = useState<ProviderCatalogEntryWire[]>([]);
  const [fallbackGraph, setFallbackGraph] = useState<TaskGraph | null>(null);
  const [ledgerRows, setLedgerRows] = useState<LedgerRow[]>([]);
  const [replayTaskId, setReplayTaskId] = useState("");
  const [replayExport, setReplayExport] = useState<LedgerExport | null>(null);
  const [reconcile, setReconcile] = useState<ReconciliationReportWire | null>(null);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [tab, setTab] = useState<"events" | "replay" | "reconcile">("events");

  const eventsRef = useRef<HTMLDivElement | null>(null);

  const refreshProviders = useCallback(async () => {
    try {
      setProviders(await getProviders());
    } catch {
      setProviders([]);
    }
  }, []);

  const refreshLedger = useCallback(async () => {
    try {
      setLedgerRows(await getLedgerRows());
    } catch {
      setLedgerRows([]);
    }
  }, []);

  useEffect(() => {
    void refreshProviders();
    getFallbackGraph().then(setFallbackGraph).catch(() => undefined);
  }, [refreshProviders]);

  // Reload the ledger when the watched task reaches a terminal state or blocks
  // a node — so the ledger pane shows the settled/blocked rows for the run.
  useEffect(() => {
    if (state.status === "completed" || state.status === "aborted") {
      void refreshLedger();
    }
  }, [state.status, refreshLedger]);

  // Keep the events log pinned to the newest entry.
  useEffect(() => {
    const el = eventsRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [state.events.length]);

  // Refetch the reconciliation report whenever the Reconcile tab is shown and
  // the task progresses (completion while the tab is open).
  const refreshReconcile = useCallback(async () => {
    const id = state.taskId;
    if (id === null) return;
    setReconcileError(null);
    try {
      setReconcile(await getReconcile(id));
    } catch (err) {
      setReconcileError(err instanceof Error ? err.message : String(err));
    }
  }, [state.taskId]);

  useEffect(() => {
    if (tab !== "reconcile") return;
    void refreshReconcile();
  }, [tab, refreshReconcile, state.status]);

  // ─── Handlers ───────────────────────────────────────────────────────────────

  const handleRun = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setRunError(null);
    const body: RunRequest = { goal };
    if (/^\d+$/.test(cap)) body.cap = cap;
    const scenario = ATTACK_SCENARIOS.find((s) => s.value === attack);
    if (scenario !== undefined && scenario.nodeId !== undefined && scenario.providerId !== undefined) {
      body.attackNode = { nodeId: scenario.nodeId, providerId: scenario.providerId };
    }
    try {
      const { taskId } = await runTask(body);
      watch(taskId);
      try {
        hydrate(await getStatus(taskId));
      } catch {
        // planning not finished yet — WS frames will fill the graph
      }
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [goal, cap, attack, running, watch, hydrate]);

  /**
   * Apply a demo preset: set the goal/cap/attack knobs, apply any provider
   * fail-modes, then fire a run request and follow the returned task id.
   */
  const runPreset = useCallback(
    async (flow: DemoFlow) => {
      if (running) return;
      setGoal(flow.goal);
      setCap(flow.cap ?? "");
      setRunError(null);
      setReconcile(null);
      setRunning(true);
      for (const fm of flow.failModes ?? []) {
        try {
          await setProviderFailMode(fm.providerId, fm.mode);
        } catch {
          // keep going — refresh reflects the actual state
        }
      }
      try {
        await refreshProviders();
        const body: RunRequest = { goal: flow.goal };
        if (flow.cap !== undefined && /^\d+$/.test(flow.cap)) body.cap = flow.cap;
        if (flow.attackNode !== undefined) body.attackNode = flow.attackNode;
        const { taskId } = await runTask(body);
        watch(taskId);
        try {
          hydrate(await getStatus(taskId));
        } catch {
          // planning not finished yet — WS frames will fill the graph
        }
      } catch (err) {
        setRunError(err instanceof Error ? err.message : String(err));
      } finally {
        setRunning(false);
      }
    },
    [running, watch, hydrate, refreshProviders],
  );

  const handleApprove = useCallback(async () => {
    if (state.taskId === null || !/^\d+$/.test(delta)) return;
    setRunError(null);
    try {
      hydrate(await approveTask(state.taskId, delta));
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    }
  }, [state.taskId, delta, hydrate]);

  const handleReject = useCallback(async () => {
    if (state.taskId === null) return;
    setRunError(null);
    try {
      await rejectTask(state.taskId);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    }
  }, [state.taskId]);

  const handleReplay = useCallback(async () => {
    const id = replayTaskId.trim();
    if (id === "") return;
    setRunError(null);
    try {
      watch(id);
      try {
        hydrate(await getStatus(id));
      } catch {
        // task may no longer be in memory — ledger export still works
      }
      const exp = await getLedgerExport(id);
      setReplayExport(exp);
      setLedgerRows(exp.rows);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    }
  }, [replayTaskId, watch, hydrate]);

  const toggleProvider = useCallback(
    async (id: string, failed: boolean) => {
      try {
        await setProviderFailed(id, failed);
      } catch {
        // keep going — refresh reflects the actual state
      }
      await refreshProviders();
    },
    [refreshProviders],
  );

  const toggleFailMode = useCallback(
    async (id: string, mode: ProviderFailMode | null) => {
      try {
        await setProviderFailMode(id, mode);
      } catch {
        // keep going — refresh reflects the actual state
      }
      await refreshProviders();
    },
    [refreshProviders],
  );

  // ─── Derived ────────────────────────────────────────────────────────────────

  const graph = state.graph ?? fallbackGraph;
  const budget = state.budget;
  const pause = state.pauseInfo;

  const providersById = useMemo(() => {
    const m: Record<string, ProviderCatalogEntryWire> = {};
    for (const p of providers) m[p.provider_id] = p;
    return m;
  }, [providers]);

  const capabilityCount = useMemo(
    () => new Set(providers.map((p) => p.capability)).size,
    [providers],
  );

  // Bar normalization across the catalog so the *why* behind a route is visible.
  const maxPrice = useMemo(
    () => providers.reduce((m, p) => Math.max(m, Number(p.price_micro_algo)), 0) || 1,
    [providers],
  );
  const maxLatency = useMemo(
    () => providers.reduce((m, p) => Math.max(m, p.latency_hint_ms), 0) || 1,
    [providers],
  );

  const routeReasonFor = useCallback(
    (nodeId: string | undefined): string | null => {
      if (nodeId === undefined) return null;
      const row = ledgerRows.find((r) => r.node_id === nodeId && r.route_reason !== "");
      return row?.route_reason ?? null;
    },
    [ledgerRows],
  );

  const pauseFraction = useMemo(() => {
    if (pause === null) return 0;
    const spent = budget !== null ? parseMicroAlgo(budget.spent) : 0n;
    return budgetFraction(spent, 0n, parseMicroAlgo(pause.projected));
  }, [pause, budget]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">x402 Sentinel</div>
        <div className="topbar-spacer" />
        <span className={`dot ${state.connected ? "dot-ok" : "dot-bad"}`} />
        <span className="muted">{state.connected ? "ws connected" : "ws reconnecting…"}</span>
        {state.taskId !== null && <span className="chip chip-task">{state.taskId}</span>}
        <span className={`chip chip-status status-${state.status}`}>{state.status}</span>
        {state.planSource !== null && <span className="chip">{state.planSource}</span>}
        {state.routeProfile !== null && (
          <span
            className="chip chip-profile"
            title={`route profile ${state.routeProfile.profile} — resolved by ${state.routeProfile.source}`}
          >
            {state.routeProfile.profile} ·{" "}
            {state.routeProfile.source === "llm" ? "LLM" : "heuristic"}
          </span>
        )}
        <button
          className="btn ghost"
          onClick={clear}
          disabled={state.taskId === null}
        >
          clear
        </button>
      </header>

      <div className="body">
        <aside className="sidebar">
          <section className="panel">
            <h3>Demo presets</h3>
            {DEMO_FLOWS.map((f) => (
              <div className="demo-flow" key={f.id}>
                <div className="demo-flow-head">
                  <button
                    className="btn sm primary"
                    onClick={() => void runPreset(f)}
                    disabled={running || !state.connected}
                  >
                    {f.label}
                  </button>
                </div>
                <div className="demo-flow-desc">{f.description}</div>
                <div className="demo-flow-watch">watch: {f.watch}</div>
              </div>
            ))}
          </section>

          <section className="panel callout">
            <h3>Pipeline status</h3>
            <div className="stat-row">
              <div className="stat">
                <div className="stat-value">{graph?.steps.length ?? 0}</div>
                <div className="stat-label">steps</div>
              </div>
              <div className="stat">
                <div className="stat-value">{providers.length}</div>
                <div className="stat-label">providers</div>
              </div>
              <div className="stat">
                <div className="stat-value">{capabilityCount}</div>
                <div className="stat-label">capabilities</div>
              </div>
            </div>
          </section>

          <section className="panel">
            <h3>Run</h3>
            <label htmlFor="goal">Goal</label>
            <input id="goal" value={goal} onChange={(e) => setGoal(e.target.value)} />
            <label htmlFor="cap">Cap (µA, optional)</label>
            <input
              id="cap"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              placeholder="default 1000"
              inputMode="numeric"
            />
            <label htmlFor="attack">Attack scenario</label>
            <select
              id="attack"
              value={attack}
              onChange={(e) => setAttack(e.target.value as AttackValue)}
            >
              {ATTACK_SCENARIOS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <button
              className="btn primary"
              onClick={handleRun}
              disabled={running || !state.connected || goal.trim() === ""}
            >
              {running ? "starting…" : "Run task"}
            </button>
            {runError !== null && <div className="error-banner">{runError}</div>}
          </section>

          {state.status === "paused" && pause !== null && (
            <section className="panel panel-paused">
              <h3>Approval required</h3>
              <div className="pause-line">
                projected {formatMicroAlgo(pause.projected)} · cap {formatMicroAlgo(pause.cap)}
              </div>
              <div className="pause-line overspend">
                overspend {formatMicroAlgo(pause.overspend)}
              </div>
              <div className="pause-nodes">
                {pause.nodeIds.map((nodeId, i) => (
                  <span className="pause-node" key={nodeId} title="node blocked by the budget cap">
                    {nodeId} · {formatMicroAlgo(pause.amounts[i] ?? "0")}
                  </span>
                ))}
              </div>
              <div className="budget-bar budget-bar-sm">
                <div className="budget-track">
                  <div
                    className="budget-fill budget-fill-projected"
                    style={{ width: `${(pauseFraction * 100).toFixed(1)}%` }}
                  />
                </div>
                <div className="budget-labels">
                  <span>spent {budget !== null ? formatMicroAlgo(budget.spent) : "—"}</span>
                  <span>projected {formatMicroAlgo(pause.projected)}</span>
                </div>
              </div>
              <label htmlFor="delta">Approve delta (µA)</label>
              <input
                id="delta"
                value={delta}
                onChange={(e) => setDelta(e.target.value)}
                placeholder={pause.overspend}
                inputMode="numeric"
              />
              <div className="btn-row">
                <button
                  className="btn primary"
                  onClick={handleApprove}
                  disabled={!/^\d+$/.test(delta)}
                >
                  Approve
                </button>
                <button className="btn danger" onClick={handleReject}>
                  Reject
                </button>
              </div>
            </section>
          )}

          <section className="panel">
            <h3>Blocked by guard</h3>
            {state.violations.length === 0 ? (
              <p className="muted">nothing blocked</p>
            ) : (
              state.violations.map((v) => (
                <div className="violation-card" key={`${v.nodeId}-${v.violation.id}`}>
                  <div className="violation-title">
                    ⛔ {v.nodeId} · {v.violation.type}
                  </div>
                  <div className="violation-msg">{v.violation.message}</div>
                  <div className="violation-fields">
                    rejected: {v.violation.rejected_fields.join(", ") || "—"}
                  </div>
                </div>
              ))
            )}
          </section>

          <section className="panel">
            <h3>
              Providers{" "}
              <button className="btn ghost sm" onClick={() => void refreshProviders()}>
                refresh
              </button>
            </h3>
            {providers.length === 0 && <p className="muted">no providers listed</p>}
            {providers.map((p) => (
              <div
                className={`provider-row ${p.failed === true ? "provider-failed" : ""}`}
                key={p.provider_id}
              >
                <div className="provider-main">
                  <span className="provider-id">{p.provider_id}</span>
                  <span className="provider-cap">{p.capability}</span>
                  {p.integration === "x402" && (
                    <span className="x402-tag" title="Real x402 resource server — settlement is a real TestNet transaction">
                      x402
                    </span>
                  )}
                </div>
                <div className="provider-badges">
                  {p.kind !== undefined && (
                    <span className={`kind-badge kind-${p.kind}`}>{p.kind}</span>
                  )}
                  {p.mode !== undefined && (
                    <span className="mode-badge" title={`adversarial mode: ${p.mode}`}>
                      {p.mode}
                    </span>
                  )}
                  {p.scheme !== undefined && (
                    <span className="chip-mini" title="payment scheme">
                      {p.scheme}
                    </span>
                  )}
                  {p.network !== undefined && (
                    <span className="chip-mini" title="network">
                      {p.network}
                    </span>
                  )}
                </div>
                <div className="provider-sub">
                  {formatMicroAlgo(p.price_micro_algo)} · q{p.quality_score.toFixed(2)} · {p.role}
                  {p.failed === true && <span className="failed-tag"> failed</span>}
                </div>
                <div className="metric-row">
                  <span className="metric-label">price</span>
                  <div className="metric-track">
                    <div
                      className="metric-fill metric-price"
                      style={{ width: `${(100 - (Number(p.price_micro_algo) / maxPrice) * 100).toFixed(0)}%` }}
                    />
                  </div>
                </div>
                <div className="metric-row">
                  <span className="metric-label">latency</span>
                  <div className="metric-track">
                    <div
                      className="metric-fill metric-latency"
                      style={{ width: `${(100 - (p.latency_hint_ms / maxLatency) * 100).toFixed(0)}%` }}
                    />
                  </div>
                </div>
                <div className="metric-row">
                  <span className="metric-label">quality</span>
                  <div className="metric-track">
                    <div
                      className="metric-fill metric-quality"
                      style={{ width: `${(p.quality_score * 100).toFixed(0)}%` }}
                    />
                  </div>
                </div>
                <div className="provider-actions">
                  <select
                    className="failmode-select"
                    value={p.failMode ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      void toggleFailMode(p.provider_id, v === "" ? null : (v as ProviderFailMode));
                    }}
                    title="fail-mode knob — how this provider fails when forced"
                  >
                    <option value="">normal</option>
                    <option value="after_402">fail after payment</option>
                    <option value="deliver">fail on deliver</option>
                    <option value="rate_limit">rate limit</option>
                    <option value="price_drift">price drift</option>
                    <option value="network_mismatch">network mismatch</option>
                  </select>
                  {p.failed === true ? (
                    <button
                      className="btn sm"
                      onClick={() => void toggleProvider(p.provider_id, false)}
                    >
                      recover
                    </button>
                  ) : (
                    <button
                      className="btn sm danger"
                      onClick={() => void toggleProvider(p.provider_id, true)}
                    >
                      fail
                    </button>
                  )}
                </div>
              </div>
            ))}
          </section>
        </aside>

        <main className="stage">
          <div className="budget-bar-wrap">
            {budget === null ? (
              <span className="muted">no budget reserved yet</span>
            ) : (
              <BudgetBar
                spent={parseMicroAlgo(budget.spent)}
                reserved={parseMicroAlgo(budget.reserved)}
                available={parseMicroAlgo(budget.available)}
                cap={parseMicroAlgo(budget.cap)}
              />
            )}
          </div>
          {state.goal !== null && <div className="goal-line">{state.goal}</div>}
          <div className="graph-wrap">
            {graph === null ? (
              <div className="empty-state">
                <p>No task graph yet.</p>
                <p className="muted">Run a task to see the plan and live node states.</p>
              </div>
            ) : (
              <TaskGraphView
                graph={graph}
                nodeStates={state.nodes}
                providersById={providersById}
                reroutes={state.reroutes}
              />
            )}
          </div>
        </main>

        <aside className="inspector">
          <div className="tabs">
            <button
              className={`tab ${tab === "events" ? "active" : ""}`}
              onClick={() => setTab("events")}
            >
              Events
            </button>
            <button
              className={`tab ${tab === "replay" ? "active" : ""}`}
              onClick={() => setTab("replay")}
            >
              Ledger
            </button>
            <button
              className={`tab ${tab === "reconcile" ? "active" : ""}`}
              onClick={() => setTab("reconcile")}
            >
              Reconcile
            </button>
          </div>

          {tab === "events" ? (
            <div className="events" ref={eventsRef}>
              {state.events.length === 0 && <p className="muted">waiting for events…</p>}
              {state.events.map((e, i) => {
                const reason = e.tag === "reroute" ? routeReasonFor(e.nodeId) : null;
                return (
                  <div
                    className={`event ${e.tag === "reroute" ? "event-reroute" : ""}`}
                    key={i}
                  >
                    <span className="event-time">{timeOf(e.at)}</span>
                    <span className="event-text">
                      {e.text}
                      {reason !== null && (
                        <span className="route-reason"> · route_reason: {reason}</span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : tab === "replay" ? (
            <div className="replay">
              <div className="replay-actions">
                <input
                  value={replayTaskId}
                  onChange={(e) => setReplayTaskId(e.target.value)}
                  placeholder="task id (t-…)"
                />
                <button
                  className="btn sm"
                  onClick={() => void handleReplay()}
                  disabled={replayTaskId.trim() === ""}
                >
                  Load task
                </button>
                <button className="btn sm" onClick={() => void refreshLedger()}>
                  All rows
                </button>
              </div>
              {replayExport !== null && (
                <div className="export-info">
                  task {replayExport.task_id}: {replayExport.row_count} rows · replayed at{" "}
                  {timeOf(replayExport.exported_at)}
                </div>
              )}
              {ledgerRows.length === 0 ? (
                <p className="muted">no ledger rows yet</p>
              ) : (
                <table className="ledger-table">
                  <thead>
                    <tr>
                      <th>node</th>
                      <th>provider</th>
                      <th>idem key</th>
                      <th>outcome</th>
                      <th>viol</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledgerRows.map((r) => (
                      <tr key={r.ledger_id}>
                        <td title={r.ledger_id}>{r.node_id}</td>
                        <td title={r.route_reason}>{r.provider_id}</td>
                        <td className="idem-key" title={r.idempotency_key}>
                          {r.idempotency_key.slice(0, 12)}…
                        </td>
                        <td className={`outcome-${r.outcome}`}>{r.outcome}</td>
                        <td>{r.violations?.length ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ) : (
            <div className="replay">
              <div className="replay-actions">
                <span className="export-info">
                  reconcile · {state.taskId ?? "no task"}
                </span>
                <button className="btn sm" onClick={() => void refreshReconcile()}>
                  refresh
                </button>
              </div>
              {reconcileError !== null && (
                <div className="error-banner">{reconcileError}</div>
              )}
              {reconcile === null ? (
                <p className="muted">
                  {reconcileError !== null
                    ? "reconciliation unavailable (task may still be running)"
                    : "run a task, then open this tab"}
                </p>
              ) : (
                <>
                  <div className="rec-meta">
                    task {reconcile.task_id} · {reconcile.row_count} rows · generated at{" "}
                    {timeOf(reconcile.generated_at)}
                  </div>
                  <div className="rec-summary">
                    <div className="rec-card">
                      <div className="rec-value">{formatMicroAlgo(reconcile.totals.total_paid)}</div>
                      <div className="rec-label">total paid</div>
                    </div>
                    <div className="rec-card">
                      <div className="rec-value">{reconcile.totals.success_count}</div>
                      <div className="rec-label">success</div>
                    </div>
                    <div className="rec-card">
                      <div className="rec-value">{reconcile.totals.declared_failure_count}</div>
                      <div className="rec-label">declared failure</div>
                    </div>
                    <div className="rec-card">
                      <div className="rec-value">{reconcile.totals.pending_count}</div>
                      <div className="rec-label">pending</div>
                    </div>
                    <div
                      className={`rec-card ${reconcile.totals.dup_payment_rate === 1 ? "rec-ok" : "rec-bad"}`}
                      title="dup-payment check — 1.0 means every payment used a unique idempotency key"
                    >
                      <div className="rec-value">
                        {(reconcile.totals.dup_payment_rate * 100).toFixed(0)}%
                      </div>
                      <div className="rec-label">
                        {reconcile.totals.dup_payment_rate === 1 ? "dup-payment: none" : "dup-payment risk"}
                      </div>
                    </div>
                    <div
                      className={`rec-card ${reconcile.totals.budget_adherence_ok ? "rec-ok" : "rec-bad"}`}
                    >
                      <div className="rec-value">
                        {reconcile.totals.budget_adherence_ok ? "0 overspend" : "overspend"}
                      </div>
                      <div className="rec-label">budget adherence</div>
                    </div>
                  </div>
                  <table className="rec-table">
                    <thead>
                      <tr>
                        <th>node</th>
                        <th>capability</th>
                        <th>provider</th>
                        <th>scheme</th>
                        <th>quoted</th>
                        <th>actual</th>
                        <th>idem key</th>
                        <th>tx_ref</th>
                        <th>outcome</th>
                        <th>viol</th>
                        <th>stages</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reconcile.rows.map((r) => (
                        <tr key={r.ledger_id}>
                          <td>{r.node_id}</td>
                          <td>{r.capability}</td>
                          <td title={r.provider_id}>{r.provider_id}</td>
                          <td>{r.scheme ?? "—"}</td>
                          <td>{formatMicroAlgo(r.quoted_amount)}</td>
                          <td>
                            {r.actual_amount !== undefined
                              ? formatMicroAlgo(r.actual_amount)
                              : "—"}
                          </td>
                          <td className="idem-key" title={r.idempotency_key}>
                            {r.idempotency_key.slice(0, 12)}…
                          </td>
                          <td className="tx-col" title={r.tx_ref ?? ""}>
                            {r.tx_ref !== undefined ? `${r.tx_ref.slice(0, 12)}…` : "—"}
                          </td>
                          <td className={`outcome-${r.outcome}`}>{r.outcome}</td>
                          <td>{r.violations?.length ?? 0}</td>
                          <td>
                            <details className="stages-details">
                              <summary>stages</summary>
                              {STAGE_ORDER.map((name) => {
                                const st = r.stages[name];
                                if (st === undefined) return null;
                                return (
                                  <div className="stage-row" key={name}>
                                    <span className={`stage-status stage-${st.status}`}>
                                      {st.status}
                                    </span>
                                    <span className="stage-name">{name}</span>
                                    <span className="stage-time">
                                      {st.at === "" ? "—" : timeOf(st.at)}
                                    </span>
                                  </div>
                                );
                              })}
                            </details>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function BudgetBar({
  spent,
  reserved,
  available,
  cap,
}: {
  spent: bigint;
  reserved: bigint;
  available: bigint;
  cap: bigint;
}) {
  const frac = budgetFraction(spent, reserved, cap);
  return (
    <div className="budget-bar">
      <div className="budget-track">
        <div className="budget-fill" style={{ width: `${(frac * 100).toFixed(1)}%` }} />
      </div>
      <div className="budget-labels">
        <span>cap {formatMicroAlgo(cap)}</span>
        <span>spent {formatMicroAlgo(spent)}</span>
        <span>reserved {formatMicroAlgo(reserved)}</span>
        <span>available {formatMicroAlgo(available)}</span>
      </div>
    </div>
  );
}

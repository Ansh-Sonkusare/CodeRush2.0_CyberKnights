import { assign, createActor, fromPromise, setup, toPromise } from "xstate";
import {
  type BudgetStatus,
  type MicroAlgo,
  type NodeState,
  type PauseInfo,
  type PlanOutcome,
  type RouteDecision,
  type RouteProfile,
  type RouteProfileResolution,
  type TaskGraph,
  type TaskId,
  type TaskStep,
  type WsMessage,
} from "@sentinel/schemas";
import type { OrchestratorDeps } from "./types.js";
import type { NodeOutput } from "./nodeMachine.js";

/**
 * TaskMachine — one XState actor per task run.
 *
 * ```
 * planning → executing ⇄ paused → executing → completed
 *    ↘ aborted                          ↘ aborted
 * ```
 *
 * The machine owns the OBSERVABLE lifecycle (status, node states, budget,
 * pause/approve semantics). It does NOT spawn node actors itself — the
 * TaskRunner (src/taskRunner.ts) does that, because running a node means
 * creating a real XState actor, subscribing to its signals, and forwarding
 * them here as events (NODE_STATE / NODE_NEEDS_APPROVAL / NODE_FINAL). The
 * machine calls the injected `spawnReady` action with the ids that are ready
 * to run; the runner turns that into createActor(nodeMachine, …).
 *
 * Events are the same discriminated union the UI consumes — no parallel
 * "UI event" shape exists.
 */

export type TaskEvent =
  | { type: "NODE_STATE"; nodeId: string; state: NodeState }
  | { type: "NODE_NEEDS_APPROVAL"; nodeId: string; pauseInfo: PauseInfo }
  | { type: "NODE_FINAL"; nodeId: string; output: NodeOutput }
  | { type: "APPROVE"; delta: MicroAlgo }
  | { type: "REJECT" };

export interface TaskInput {
  taskId: TaskId;
  goal: string;
  cap: MicroAlgo;
  attackNode?: { nodeId: string; providerId: string } | undefined;
  deps: OrchestratorDeps;
  /** Planner call (apps/service-orchestrator wraps hc<PlannerRoutes>). */
  plan: (goal: string, taskId: string) => Promise<PlanOutcome>;
  /** Task-level WS broadcast (gateway hub in a later phase). */
  broadcast: (msg: WsMessage) => void;
  /** Spawn a NodeMachine actor for a ready node (TaskRunner implements).
   * `upstream` carries the settled results of this node's dependencies —
   * computed from the in-transition context so a node that becomes ready in
   * the same transition its dep finalizes still gets the fresh result. */
  spawnReady: (ready: {
    node: TaskStep;
    decision: RouteDecision;
    upstream: Record<string, Record<string, unknown>>;
  }[]) => void;
  /**
   * Factory to rebuild the router for this run when the plan returns a
   * route_profile. The task machine calls this once — after planning —
   * to swap the initial goal-heuristic router for a profile-aware one.
   * This is a run-local mutation: only the in-context router is replaced.
   */
  rebuildRouter: (profile: RouteProfile) => void;
}

export interface TaskOutput {
  status: "completed" | "aborted";
  error?: string;
  durationMs: number;
}

interface TaskContext {
  taskId: TaskId;
  goal: string;
  cap: MicroAlgo;
  attackNode: { nodeId: string; providerId: string } | undefined;
  deps: OrchestratorDeps;
  plan: (goal: string, taskId: string) => Promise<PlanOutcome>;
  broadcast: (msg: WsMessage) => void;
  spawnReady: (ready: {
    node: TaskStep;
    decision: RouteDecision;
    upstream: Record<string, Record<string, unknown>>;
  }[]) => void;
  rebuildRouter: (profile: RouteProfile) => void;
  graph: TaskGraph | undefined;
  planSource: "planner" | "fallback" | undefined;
  route_profile: RouteProfileResolution | undefined;
  nodes: Record<string, NodeState>;
  started: string[];
  waiting: string[];
  results: Record<string, Record<string, unknown>>;
  budget: BudgetStatus;
  pauseInfo: PauseInfo | undefined;
  error: string | undefined;
  startedAt: string;
  finishedAt: string | undefined;
}

// ─── Planning actor ───────────────────────────────────────────────────────────

interface PlanInput {
  goal: string;
  taskId: string;
  plan: (goal: string, taskId: string) => Promise<PlanOutcome>;
}

const planTask = ({ input }: { input: PlanInput }): Promise<PlanOutcome> =>
  input.plan(input.goal, input.taskId);

// ─── Setup (binds assign/action/guard helpers to this machine's types) ────────

const machine = setup({
  types: {
    context: {} as TaskContext,
    input: {} as TaskInput,
    events: {} as TaskEvent,
  },
  actors: {
    planTask: fromPromise(planTask),
  },
  guards: {
    allFinal: ({ context }) => {
      const graph = context.graph;
      if (!graph) return false;
      return graph.steps.every((s) => isFinal(context.nodes[s.id]));
    },
  },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FINAL_KINDS = new Set<NodeState["kind"]>(["settled", "blocked", "failed"]);

function isFinal(state: NodeState | undefined): boolean {
  return state !== undefined && FINAL_KINDS.has(state.kind);
}

/** Initial route decision per node — attackNode forces a provider (demo knob). */
function initialDecisionFor(
  step: TaskStep,
  deps: OrchestratorDeps,
  attackNode: { nodeId: string; providerId: string } | undefined,
): RouteDecision | undefined {
  if (attackNode && attackNode.nodeId === step.id) {
    const forced = deps.adapters.find(
      (a) => a.providerId === attackNode.providerId && a.capability === step.capability,
    );
    if (forced) {
      return { adapter: forced, score: 0, reason: `attack scenario: forced ${forced.providerId}` };
    }
  }
  const picked = deps.router.select(step.capability, []);
  return picked.ok ? picked.value : undefined;
}

// ─── Actions ──────────────────────────────────────────────────────────────────

/**
 * Compute which nodes are ready (all deps settled), spawn them via the
 * injected spawnReady callback, and mark every node whose dependency chain
 * ends in a failed/blocked node (or that has no provider) as failed locally.
 *
 * Failure propagation is a fixpoint over the graph: a node whose dep just
 * failed in the same pass also fails its own dependents, transitively. Without
 * the cascade a downstream node would sit "pending" forever and the task would
 * never reach a terminal state. Side-effect heavy, but the runner is the only
 * other party that touches actors, and this keeps readiness a single decision
 * in one place.
 */
const spawnReadyNodes = machine.assign(({ context }) => {
  const graph = context.graph;
  if (!graph) return {};

  const ready: {
    node: TaskStep;
    decision: RouteDecision;
    upstream: Record<string, Record<string, unknown>>;
  }[] = [];
  const failedNow: { node: TaskStep; reason: string }[] = [];
  const nodes: Record<string, NodeState> = { ...context.nodes };
  const scheduled = new Set<string>(context.started);

  const markFailed = (step: TaskStep, reason: string): void => {
    nodes[step.id] = { kind: "failed", error: reason };
    failedNow.push({ node: step, reason });
    scheduled.add(step.id);
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const step of graph.steps) {
      if (scheduled.has(step.id)) continue;
      const cur = nodes[step.id];
      if (cur !== undefined && (cur.kind === "failed" || cur.kind === "blocked")) {
        scheduled.add(step.id);
        continue;
      }

      const depFailed = step.dependsOn.some((d) => {
        const s = nodes[d];
        return s !== undefined && (s.kind === "failed" || s.kind === "blocked");
      });
      if (depFailed) {
        markFailed(step, `dependency ${step.dependsOn.join(", ")} failed or was blocked`);
        changed = true;
        continue;
      }

      const depsSettled = step.dependsOn.every((d) => nodes[d]?.kind === "settled");
      if (!depsSettled) continue;

      const decision = initialDecisionFor(step, context.deps, context.attackNode);
      if (decision === undefined) {
        markFailed(step, `no provider available for "${step.capability}"`);
        changed = true;
        continue;
      }
      const upstream: Record<string, Record<string, unknown>> = {};
      for (const dep of step.dependsOn) {
        const r = context.results[dep];
        if (r !== undefined) upstream[dep] = r;
      }
      ready.push({ node: step, decision, upstream });
      scheduled.add(step.id);
      changed = true;
    }
  }

  for (const { node, decision, upstream } of ready) {
    context.spawnReady([{ node, decision, upstream }]);
  }

  for (const { node } of failedNow) {
    context.broadcast({
      event: "node_state",
      taskId: context.taskId,
      nodeId: node.id,
      state: nodes[node.id] as NodeState,
      budget: context.deps.treasury.status(),
      at: new Date().toISOString(),
    });
  }

  return { started: [...scheduled], nodes };
});

const applyNodeState = machine.assign(({ context, event }) => {
  if (event.type !== "NODE_STATE") return {};
  return { nodes: { ...context.nodes, [event.nodeId]: event.state }, budget: context.deps.treasury.status() };
});

const applyNodeFinal = machine.assign(({ context, event }) => {
  if (event.type !== "NODE_FINAL") return {};
  const results = { ...context.results };
  if (event.output.result !== undefined) results[event.nodeId] = event.output.result;
  return { results, budget: context.deps.treasury.status() };
});

const pauseTask = machine.assign(({ context, event }) => {
  if (event.type !== "NODE_NEEDS_APPROVAL") return {};
  const pauseInfo: PauseInfo = event.pauseInfo;
  const waiting = context.waiting.includes(event.nodeId) ? context.waiting : [...context.waiting, event.nodeId];
  return {
    nodes: { ...context.nodes, [event.nodeId]: { kind: "pending" } },
    waiting,
    pauseInfo,
    budget: context.deps.treasury.status(),
  };
});

const mergePause = machine.assign(({ context, event }) => {
  if (event.type !== "NODE_NEEDS_APPROVAL") return {};
  const prev = context.pauseInfo ?? event.pauseInfo;
  const nodeIds = [...new Set([...prev.nodeIds, ...event.pauseInfo.nodeIds])];
  const amounts = [...prev.amounts, ...event.pauseInfo.amounts];
  const waiting = [...new Set([...context.waiting, ...event.pauseInfo.nodeIds])];
  return {
    nodes: { ...context.nodes, [event.nodeId]: { kind: "pending" } },
    waiting,
    pauseInfo: { nodeIds, amounts, overspend: prev.overspend, projected: prev.projected, cap: prev.cap },
  };
});

const approveOverspend = machine.assign(({ context, event }) => {
  if (event.type !== "APPROVE") return {};
  context.deps.treasury.approveOverspend(event.delta);
  const waiting = context.waiting;
  const started = context.started.filter((id) => !waiting.includes(id));
  return { started, waiting: [], budget: context.deps.treasury.status(), pauseInfo: undefined };
});

const broadcastTaskPaused = machine.createAction(({ context }) => {
  const budget = context.deps.treasury.status();
  const pauseInfo = context.pauseInfo;
  if (!pauseInfo) return;
  context.broadcast({
    event: "task_paused",
    taskId: context.taskId,
    pauseInfo,
    budget,
    at: new Date().toISOString(),
  });
});

const broadcastTaskDone = machine.createAction(({ context }) => {
  const durationMs = Date.now() - new Date(context.startedAt).getTime();
  context.broadcast({
    event: "task_done",
    taskId: context.taskId,
    budget: context.deps.treasury.status(),
    durationMs,
    at: new Date().toISOString(),
  });
});

const broadcastTaskAborted = machine.createAction(({ context }) => {
  const msg: WsMessage = { event: "task_aborted", taskId: context.taskId, at: new Date().toISOString() };
  if (context.error !== undefined) msg.error = context.error;
  context.broadcast(msg);
});

// ─── Machine ──────────────────────────────────────────────────────────────────

export const taskMachine = machine.createMachine({
  id: "taskMachine",
  context: ({ input }) => ({
    taskId: input.taskId,
    goal: input.goal,
    cap: input.cap,
    attackNode: input.attackNode,
    deps: input.deps,
    plan: input.plan,
    broadcast: input.broadcast,
    spawnReady: input.spawnReady,
    rebuildRouter: input.rebuildRouter,
    graph: undefined,
    planSource: undefined,
    route_profile: undefined,
    nodes: {},
    started: [],
    waiting: [],
    results: {},
    budget: input.deps.treasury.status(),
    pauseInfo: undefined,
    error: undefined,
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
  }),
  output: ({ context }): TaskOutput => {
    const out: TaskOutput = { status: "completed", durationMs: 0 };
    if (context.error !== undefined) {
      out.status = "aborted";
      out.error = context.error;
    }
    out.durationMs = Date.now() - new Date(context.startedAt).getTime();
    return out;
  },
  initial: "planning",
  states: {
    planning: {
      invoke: {
        id: "planTask",
        src: "planTask",
        input: ({ context }) => ({ goal: context.goal, taskId: context.taskId, plan: context.plan }),
        onDone: {
          target: "executing",
          actions: [
            assign(({ context, event }) => {
              const outcome = event.output as PlanOutcome;
              const nodes: Record<string, NodeState> = {};
              for (const step of outcome.graph.steps) nodes[step.id] = { kind: "pending" };
              // If the plan (LLM or heuristic fallback) carries a route_profile,
              // rebuild the run-local router with profile-aware weights so
              // retries and fallbacks use the same routing preference.
              if (outcome.route_profile !== undefined) {
                context.rebuildRouter(outcome.route_profile.profile);
              }
              return {
                graph: outcome.graph,
                planSource: outcome.source,
                route_profile: outcome.route_profile,
                nodes,
                budget: context.deps.treasury.status(),
              };
            }),
            ({ context }) => {
              const graph = context.graph;
              if (!graph) return;
              context.broadcast({
                event: "task_started",
                taskId: context.taskId,
                goal: context.goal,
                graph,
                planSource: context.planSource ?? "planner",
                route_profile: context.route_profile,
                at: new Date().toISOString(),
              });
            },
          ],
        },
        onError: {
          target: "aborted",
          actions: [
            assign(({ event }) => ({
              error: event.error instanceof Error ? event.error.message : String(event.error),
            })),
            ({ context }) => {
              const msg: WsMessage = { event: "task_aborted", taskId: context.taskId, at: new Date().toISOString() };
              if (context.error !== undefined) msg.error = context.error;
              context.broadcast(msg);
            },
          ],
        },
      },
    },

    executing: {
      entry: spawnReadyNodes,
      always: { guard: "allFinal", target: "completed" },
      on: {
        NODE_STATE: { actions: applyNodeState },
        NODE_NEEDS_APPROVAL: {
          target: "paused",
          actions: [pauseTask, broadcastTaskPaused],
        },
        NODE_FINAL: {
          actions: [applyNodeFinal, spawnReadyNodes],
        },
        REJECT: {
          target: "aborted",
          actions: [machine.assign({ error: "rejected by operator" }), broadcastTaskAborted],
        },
      },
    },

    paused: {
      entry: broadcastTaskPaused,
      on: {
        NODE_STATE: { actions: applyNodeState },
        NODE_FINAL: { actions: applyNodeFinal },
        NODE_NEEDS_APPROVAL: { actions: mergePause },
        APPROVE: {
          target: "executing",
          actions: approveOverspend,
        },
        REJECT: {
          target: "aborted",
          actions: [machine.assign({ error: "rejected by operator" }), broadcastTaskAborted],
        },
      },
    },

    completed: {
      type: "final",
      entry: [
        machine.assign({ finishedAt: new Date().toISOString() }),
        broadcastTaskDone,
      ],
    },

    aborted: {
      type: "final",
      entry: [machine.assign({ finishedAt: new Date().toISOString() }), broadcastTaskAborted],
    },
  },
});

export { createActor, toPromise };

import { randomUUID } from "node:crypto";
import { createActor, toPromise, waitFor, type Actor } from "xstate";
import {
  microAlgo,
  taskId,
  type BudgetStatus,
  type ExecutionStatus,
  type MicroAlgo,
  type NodeState,
  type PauseInfo,
  type PlanOutcome,
  type ProviderAdapter,
  type RouteDecision,
  type RunRequest,
  type RunResponse,
  type TaskId,
  type TaskStatus,
  type TaskStep,
  type WsMessage,
} from "@sentinel/schemas";
import { Treasury } from "@sentinel/treasury";
import type { LedgerStore } from "@sentinel/ledger";
import type { Router } from "@sentinel/router";
import type { X402Client } from "@sentinel/x402-client";
import { nodeMachine, type NodeOutput } from "./nodeMachine.js";
import { taskMachine, type TaskEvent } from "./taskMachine.js";

/**
 * TaskRunner — the driver that connects the XState machines to the outside.
 *
 * createTaskRunner wires the shared engines once (ledger, x402 client, router,
 * catalog adapters) plus the planner call and the WS broadcast. Each run():
 *  1. allocates a task id + a per-task Treasury (budget owns scope),
 *  2. starts a TaskMachine actor (planning → executing → …),
 *  3. on `spawnReady` events from the machine, creates a NodeMachine actor per
 *     ready node and forwards its NodeSignal events back to the TaskMachine.
 *
 * The machines stay observable (snapshots), while all actor plumbing lives
 * here — so the HTTP layer only ever calls run/approve/reject/status/nodes.
 */

export interface TaskRunnerOptions {
  /** Shared engines (no treasury — a fresh one is created per run). */
  x402: X402Client;
  ledger: LedgerStore;
  router: Router;
  adapters: ProviderAdapter[];
  plan: (goal: string, taskId: string) => Promise<PlanOutcome>;
  broadcast: (msg: WsMessage) => void;
}

/** Default budget cap when RunRequest.cap is omitted. */
export const DEFAULT_RUN_CAP: MicroAlgo = microAlgo(1000n);

interface RunHandle {
  taskId: TaskId;
  goal: string;
  treasury: Treasury;
  deps: {
    treasury: Treasury;
    x402: X402Client;
    ledger: LedgerStore;
    router: Router;
    adapters: ProviderAdapter[];
  };
  actor: Actor<typeof taskMachine>;
}

export interface TaskRunner {
  run(request: RunRequest): Promise<RunResponse>;
  approve(taskId: string, delta: MicroAlgo): Promise<BudgetStatus | undefined>;
  reject(taskId: string): void;
  status(taskId: string): ExecutionStatus | undefined;
  nodes(taskId: string): NodeState[] | undefined;
}

export function createTaskRunner(options: TaskRunnerOptions): TaskRunner {
  const runs = new Map<string, RunHandle>();

  function spawnReady(
    handle: RunHandle,
    ready: {
      node: TaskStep;
      decision: RouteDecision;
      upstream: Record<string, Record<string, unknown>>;
    }[],
  ): void {
    for (const { node, decision, upstream } of ready) {
      const nodeInput = {
        taskId: handle.taskId,
        node,
        goal: handle.goal,
        input: upstream,
        deps: handle.deps,
        initialDecision: decision,
        broadcast: (signal: { kind: "node_state"; state: NodeState } | { kind: "needs_approval"; pauseInfo: PauseInfo }) => {
          if (signal.kind === "node_state") {
            handle.actor.send({ type: "NODE_STATE", nodeId: node.id, state: signal.state });
            options.broadcast({
              event: "node_state",
              taskId: handle.taskId,
              nodeId: node.id,
              state: signal.state,
              at: new Date().toISOString(),
            });
          } else {
            handle.actor.send({ type: "NODE_NEEDS_APPROVAL", nodeId: node.id, pauseInfo: signal.pauseInfo });
          }
        },
      };

      const actor = createActor(nodeMachine, { input: nodeInput });
      toPromise(actor)
        .then((output: NodeOutput) => {
          if (output.pauseInfo !== undefined) return; // pause handled via signal; re-spawned on resume
          // The task machine can reach `completed` on the last node's settled
          // NODE_STATE before this node actor stops — don't send NODE_FINAL
          // into a stopped machine (the ledger row is already final by then).
          if (handle.actor.getSnapshot().status !== "active") return;
          handle.actor.send({ type: "NODE_FINAL", nodeId: node.id, output });
        })
        .catch(() => {
          handle.actor.send({
            type: "NODE_STATE",
            nodeId: node.id,
            state: { kind: "failed", error: "node machine stopped unexpectedly" },
          });
        });
      actor.start();
    }
  }

  return {
    async run(request: RunRequest): Promise<RunResponse> {
      const runTaskId = taskId(`t-${randomUUID().slice(0, 8)}`);
      const cap = request.cap === undefined ? DEFAULT_RUN_CAP : microAlgo(BigInt(request.cap));
      const treasury = new Treasury(runTaskId, cap);

      const deps = {
        treasury,
        x402: options.x402,
        ledger: options.ledger,
        router: options.router,
        adapters: options.adapters,
      };

      const handle: RunHandle = {
        taskId: runTaskId,
        goal: request.goal,
        treasury,
        deps,
        actor: undefined as unknown as Actor<typeof taskMachine>,
      };

      const actor = createActor(taskMachine, {
        input: {
          taskId: runTaskId,
          goal: request.goal,
          cap,
          attackNode: request.attackNode,
          deps,
          plan: options.plan,
          broadcast: options.broadcast,
          spawnReady: (ready) => spawnReady(handle, ready),
        },
      });

      handle.actor = actor;
      runs.set(runTaskId, handle);
      actor.start();

      return { taskId: runTaskId };
    },

    async approve(taskIdValue: string, delta: MicroAlgo): Promise<BudgetStatus | undefined> {
      const handle = runs.get(taskIdValue);
      if (!handle) return undefined;
      if (!handle.actor.getSnapshot().matches("paused")) return handle.treasury.status();
      handle.actor.send({ type: "APPROVE", delta } satisfies TaskEvent);
      await waitFor(handle.actor, (snap) => snap.matches("executing"), { timeout: 5000 });
      return handle.treasury.status();
    },

    reject(taskIdValue: string): void {
      const handle = runs.get(taskIdValue);
      if (!handle) return;
      if (!handle.actor.getSnapshot().matches("paused")) return;
      handle.actor.send({ type: "REJECT" } satisfies TaskEvent);
    },

    status(taskIdValue: string): ExecutionStatus | undefined {
      const handle = runs.get(taskIdValue);
      if (!handle) return undefined;
      const snap = handle.actor.getSnapshot();
      const ctx = snap.context;
      const status: ExecutionStatus = {
        taskId: handle.taskId,
        status: snap.value as TaskStatus,
        nodes: ctx.nodes,
        budget: ctx.budget,
        startedAt: ctx.startedAt,
      };
      if (ctx.pauseInfo !== undefined) status.pauseInfo = ctx.pauseInfo;
      if (ctx.finishedAt !== undefined) status.finishedAt = ctx.finishedAt;
      return status;
    },

    nodes(taskIdValue: string): NodeState[] | undefined {
      const handle = runs.get(taskIdValue);
      if (!handle) return undefined;
      return Object.values(handle.actor.getSnapshot().context.nodes);
    },
  };
}

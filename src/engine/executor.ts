import { TaskGraph, TaskStep } from "../types.js";
import { Ledger } from "../ledger/ledger.js";
import { SimulatedWallet } from "../wallet/wallet.js";
import { Treasury, BudgetStatus } from "../treasury/treasury.js";
import { OptimizerWeights, DEFAULT_WEIGHTS, RouteDecision, pickProvider, pickFallback } from "./routeOptimizer.js";
import { runPaidCall, idempotencyKey } from "./paidCall.js";
import { createLedgerRow } from "../ledger/schema.js";
import { ExecutorBus } from "./executorEvents.js";

export type StepStatus =
  | "running"
  | "success"
  | "declared_failure"
  | "pending_approval"
  | "aborted";

export interface StepExecution {
  step: TaskStep;
  status: StepStatus;
  providerId?: string;
  ledgerId?: string;
  routeReason?: string;
  price?: number;
  txRef?: string;
  startedAt?: string;
  finishedAt?: string;
  result?: Record<string, unknown>;
  error?: string;
}

export interface PauseInfo {
  nodeId: string;
  amounts: number[];
  overspend: number;
  projected: number;
  cap: number;
  ledgerIds: string[];
}

export interface ExecutionSummary {
  taskId: string;
  status: "completed" | "aborted";
  steps: StepExecution[];
  budget: BudgetStatus;
  durationMs: number;
}

type Verdict = "approved" | "rejected";

export class TaskExecutor {
  private ledger: Ledger;
  private wallet: SimulatedWallet;
  private treasury: Treasury;
  private graph: TaskGraph;
  private weights: OptimizerWeights;
  private goal: string;
  private scopeMax: number;
  private bus?: ExecutorBus;

  private outputs = new Map<string, Record<string, unknown>>();
  private results = new Map<string, StepExecution>();
  private started = new Set<string>();
  private pendingLedger = new Map<string, string>();

  private status: "running" | "paused" | "completed" | "aborted" = "running";
  private pauseInfo?: PauseInfo;
  private approvalResolver?: (v: Verdict) => void;

  constructor(opts: {
    ledger: Ledger;
    wallet: SimulatedWallet;
    treasury: Treasury;
    graph: TaskGraph;
    weights?: OptimizerWeights;
    goal?: string;
    /** Per-provider "pay up to X" safety token. Defaults to the task budget cap. */
    scope_max?: number;
    /** Optional event bus for real-time UI streaming. Existing callers can omit this. */
    bus?: ExecutorBus;
  }) {
    this.ledger = opts.ledger;
    this.wallet = opts.wallet;
    this.treasury = opts.treasury;
    this.graph = opts.graph;
    this.weights = opts.weights ?? DEFAULT_WEIGHTS;
    this.goal = opts.goal ?? opts.graph.goal;
    this.scopeMax = opts.scope_max ?? opts.graph.budget_cap;
    this.bus = opts.bus;
  }

  async run(): Promise<ExecutionSummary> {
    this.bus?.emit("task_started", { taskId: this.graph.task_id, graph: this.graph });
    const t0 = Date.now();
    while (this.status === "running") {
      const ready = this.readySteps();
      if (ready.length === 0) {
        const remaining = this.graph.steps.filter((s) => !this.started.has(s.id));
        if (remaining.length === 0) break;
        for (const s of remaining) {
          this.results.set(s.id, {
            step: s,
            status: "aborted",
            error: "dependency failed — step never ran",
          });
        }
        this.status = "aborted";
        break;
      }

      const decisions = new Map<string, RouteDecision>();
      let decideFailed = false;
      for (const s of ready) {
        try {
          decisions.set(s.id, pickProvider(s.capability, this.weights));
        } catch (err) {
          decideFailed = true;
          this.started.add(s.id);
          this.results.set(s.id, {
            step: s,
            status: "declared_failure",
            error: String(err),
          });
        }
      }
      if (decideFailed) continue;

      const amounts = ready.map((s) => decisions.get(s.id)!.provider.price);

      if (!this.treasury.canReserveAll(amounts)) {
        await this.pauseForApproval(ready, decisions);
        continue;
      }

      await Promise.all(ready.map((s) => this.runStep(s, decisions.get(s.id)!)));
    }

    const steps = this.graph.steps
      .map((s) => this.results.get(s.id)!)
      .filter((e) => e !== undefined);

    const summary: ExecutionSummary = {
      taskId: this.graph.task_id,
      status: this.status === "aborted" ? "aborted" : "completed",
      steps,
      budget: this.treasury.status(),
      durationMs: Date.now() - t0,
    };
    if (summary.status === "aborted") {
      this.bus?.emit("task_aborted", { summary });
    } else {
      this.bus?.emit("task_done", { summary });
    }
    return summary;
  }

  getPauseInfo(): PauseInfo | undefined {
    return this.pauseInfo;
  }

  isPaused(): boolean {
    return this.status === "paused";
  }

  /** Human approves raising the cap; the paused wave resumes. */
  approve(additionalCap: number): void {
    this.treasury.approveOverspend(additionalCap);
    this.pauseInfo = undefined;
    this.status = "running";
    this.bus?.emit("task_approved", { delta: additionalCap, budget: this.treasury.status() });
    this.approvalResolver?.("approved");
    this.approvalResolver = undefined;
  }

  /** Human rejects; the wave is marked declared_failure and the task continues. */
  reject(): void {
    for (const [stepId, ledgerId] of this.pendingLedger) {
      void this.ledger.setOutcome(ledgerId, "declared_failure");
      this.started.add(stepId);
      const step = this.graph.steps.find((s) => s.id === stepId)!;
      this.results.set(stepId, {
        step,
        status: "declared_failure",
        ledgerId,
        error: "budget approval rejected — step not executed",
      });
      this.bus?.emit("node_failed", { nodeId: stepId, error: "budget approval rejected" });
    }
    this.pendingLedger.clear();
    this.pauseInfo = undefined;
    this.status = "running";
    this.bus?.emit("task_rejected", {});
    this.approvalResolver?.("rejected");
    this.approvalResolver = undefined;
  }

  private async pauseForApproval(
    ready: TaskStep[],
    decisions: Map<string, RouteDecision>,
  ): Promise<void> {
    const amounts = ready.map((s) => decisions.get(s.id)!.provider.price);
    const { projected, overspend } = this.treasury.projection(
      amounts.reduce((a, b) => a + b, 0),
    );
    const ledgerIds: string[] = [];
    for (const s of ready) {
      const d = decisions.get(s.id)!;
      const row = createLedgerRow({
        ledger_id: this.ledger.nextLedgerId(),
        task_id: this.graph.task_id,
        node_id: s.id,
        idempotency_key: idempotencyKey(
          this.graph.task_id,
          s.id,
          d.provider.provider_id,
        ),
        provider_id: d.provider.provider_id,
        capability: s.capability,
        route_reason: d.reason,
      });
      await this.ledger.append(row);
      this.pendingLedger.set(s.id, row.ledger_id);
      ledgerIds.push(row.ledger_id);
    }

    this.status = "paused";
    this.pauseInfo = {
      nodeId: ready[0].id,
      amounts,
      overspend,
      projected,
      cap: this.treasury.status().cap,
      ledgerIds,
    };
    this.bus?.emit("task_paused", { pauseInfo: this.pauseInfo, budget: this.treasury.status() });

    await new Promise<Verdict>((resolve) => {
      this.approvalResolver = resolve;
    });
    this.pendingLedger.clear();
  }

  private async runStep(step: TaskStep, decision: RouteDecision): Promise<void> {
    this.started.add(step.id);
    const entry: StepExecution = {
      step,
      status: "running",
      providerId: decision.provider.provider_id,
      routeReason: decision.reason,
      price: decision.provider.price,
      startedAt: new Date().toISOString(),
    };
    this.results.set(step.id, entry);
    this.bus?.emit("node_queued", { nodeId: step.id, capability: step.capability, label: step.label });

    let current = decision;
    const tried = new Set<string>([decision.provider.provider_id]);
    let existingLedgerId = this.pendingLedger.get(step.id);
    this.pendingLedger.delete(step.id);
    const attempts: string[] = [];
    let attemptNum = 0;

    // Retry loop: on provider failure, fall back to the next-best provider
    // (idempotency keys are provider-scoped, so retrying the same provider
    // can never double-settle; a different provider is a separate purchase).
    while (true) {
      entry.providerId = current.provider.provider_id;
      entry.routeReason = current.reason;
      entry.price = current.provider.price;
      this.treasury.reserve(step.id, current.provider.price);
      attemptNum++;
      this.bus?.emit("node_started", {
        nodeId: step.id,
        provider: current.provider.provider_id,
        price: current.provider.price,
        attempt: attemptNum,
      });

      try {
        const res = await runPaidCall({
          ledger: this.ledger,
          wallet: this.wallet,
          task_id: this.graph.task_id,
          node_id: step.id,
          capability: step.capability,
          goal: this.goal,
          provider_id: current.provider.provider_id,
          scope_token: `pay:${this.graph.task_id}:up-to:${this.scopeMax}:for:${current.provider.provider_id}`,
          scope_max: this.scopeMax,
          route_reason: current.reason,
          input: this.assembleInput(step),
          existing_ledger_id: existingLedgerId,
        });
        this.treasury.settle(step.id);
        this.outputs.set(step.id, res.response);
        entry.status = "success";
        entry.finishedAt = new Date().toISOString();
        entry.txRef = res.settlement.tx_ref;
        entry.ledgerId = res.ledgerId;
        entry.result = res.response;
        this.bus?.emit("node_settled", {
          nodeId: step.id,
          txRef: res.settlement.tx_ref,
          price: res.settlement.amount,
          provider: current.provider.provider_id,
        });
        return;
      } catch (err) {
        this.treasury.release(step.id);
        existingLedgerId = undefined;
        const errMsg = String(err);
        attempts.push(errMsg);

        // Check if this was a guard violation
        if (errMsg.includes("blocked_policy_violation")) {
          // Extract violation from ledger
          const rows = this.ledger.findByTaskId(this.graph.task_id);
          const blocked = rows.find(
            (r) => r.node_id === step.id && r.violations && r.violations.length > 0,
          );
          const violation = blocked?.violations?.[blocked.violations.length - 1];
          if (violation) {
            this.bus?.emit("node_blocked", {
              nodeId: step.id,
              violation,
              provider: current.provider.provider_id,
            });
          }
        }

        const next = pickFallback(step.capability, [...tried], this.weights);
        if (!next) {
          entry.status = "declared_failure";
          entry.finishedAt = new Date().toISOString();
          entry.error = `all providers for "${step.capability}" failed: ${attempts.join(" | ")}`;
          this.bus?.emit("node_failed", { nodeId: step.id, error: entry.error });
          return;
        }
        tried.add(next.provider.provider_id);
        current = next;
      }
    }
  }

  private assembleInput(step: TaskStep): Record<string, unknown> {
    const input: Record<string, unknown> = {};
    for (const dep of step.dependsOn) {
      const out = this.outputs.get(dep);
      if (!out) continue;
      if (Array.isArray(out.urls)) input.sources = out.urls;
      if (Array.isArray(out.snippets) && out.snippets.length > 0) {
        input.raw = out.snippets[0];
      }
      Object.assign(input, out);
    }
    return input;
  }

  private readySteps(): TaskStep[] {
    return this.graph.steps.filter((s) => {
      if (this.started.has(s.id)) return false;
      return s.dependsOn.every(
        (dep) => this.results.get(dep)?.status === "success",
      );
    });
  }
}

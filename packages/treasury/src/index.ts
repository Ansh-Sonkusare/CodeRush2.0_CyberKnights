import { randomUUID } from "node:crypto";
import {
  type BudgetStatus,
  type MicroAlgo,
  type ScopedCapability,
  type ScopedCapabilityToken,
  type TaskId,
  type TaskNodeId,
  microAlgo,
} from "@sentinel/schemas";

export type ReserveDecision =
  | { kind: "ok" }
  | {
      kind: "needs_approval";
      overspend: MicroAlgo;
      projected: MicroAlgo;
      cap: MicroAlgo;
    };

/**
 * Treasury — pure in-memory budget state machine.
 *
 * Flow per node: reserve-on-select -> if over cap, PAUSE for approval
 * (never overspend silently) -> settle (reserved becomes spent) on
 * success, or release on failure.
 *
 * Money is MicroAlgo (bigint branded) — never a floating-point number.
 * The planner can propose a task graph, but only this class owns the
 * budget cap and only it issues payment capabilities.
 */
export class Treasury {
  private readonly taskIdValue: TaskId;
  private cap: MicroAlgo;
  private spent: MicroAlgo = microAlgo(0n);
  private reserved: MicroAlgo = microAlgo(0n);
  private reservations = new Map<TaskNodeId, MicroAlgo>();
  private capabilities = new Map<ScopedCapabilityToken, ScopedCapability>();

  constructor(taskId: TaskId, cap: MicroAlgo) {
    this.taskIdValue = taskId;
    this.cap = cap;
  }

  get task(): TaskId {
    return this.taskIdValue;
  }

  setCap(cap: MicroAlgo): void {
    this.cap = cap;
  }

  status(): BudgetStatus {
    return {
      cap: this.cap,
      spent: this.spent,
      reserved: this.reserved,
      available: microAlgo(this.cap - this.spent - this.reserved),
    };
  }

  /** Check whether `amount` could be reserved without exceeding the cap. */
  canReserve(amount: MicroAlgo): boolean {
    return this.spent + this.reserved + amount <= this.cap;
  }

  /** Check whether the whole next wave of amounts fits under the cap. */
  canReserveAll(amounts: MicroAlgo[]): boolean {
    const total = amounts.reduce((s, a) => s + a, 0n);
    return this.spent + this.reserved + total <= this.cap;
  }

  /** What the budget would look like after reserving `amount`. */
  projection(amount: MicroAlgo): { projected: MicroAlgo; overspend: MicroAlgo } {
    const projected = microAlgo(this.spent + this.reserved + amount);
    return { projected, overspend: microAlgo(projected - this.cap) };
  }

  /**
   * Reserve funds for a node. Returns needs_approval (without reserving)
   * if it would exceed the cap — the caller must pause and ask.
   */
  reserve(nodeId: TaskNodeId, amount: MicroAlgo): ReserveDecision {
    const { projected } = this.projection(amount);
    if (projected <= this.cap) {
      this.reservations.set(nodeId, amount);
      this.reserved = microAlgo(this.reserved + amount);
      return { kind: "ok" };
    }
    return {
      kind: "needs_approval",
      projected,
      overspend: microAlgo(projected - this.cap),
      cap: this.cap,
    };
  }

  /** On success: reserved -> spent. */
  settle(nodeId: TaskNodeId): void {
    const amount = this.reservations.get(nodeId);
    if (amount === undefined) return;
    this.reservations.delete(nodeId);
    this.reserved = microAlgo(this.reserved - amount);
    this.spent = microAlgo(this.spent + amount);
  }

  /** On failure: free the reservation. */
  release(nodeId: TaskNodeId): void {
    const amount = this.reservations.get(nodeId);
    if (amount === undefined) return;
    this.reservations.delete(nodeId);
    this.reserved = microAlgo(this.reserved - amount);
  }

  /** One-time human approval that lifts the cap to cover a planned overspend. */
  approveOverspend(additionalCap: MicroAlgo): void {
    this.cap = microAlgo(this.cap + additionalCap);
  }

  /**
   * Issue a scoped capability ("pay up to `max` ALGO to `providerId` for
   * node `nodeId`"). The planner/router/LLM never see a signer — only this
   * token, and only the x402-client can redeem it.
   */
  issueCapability(
    nodeId: TaskNodeId,
    providerId: string,
    max: MicroAlgo,
  ): ScopedCapability {
    const token =
      `cap-${this.taskIdValue}-${nodeId}-${providerId}-${randomUUID().slice(0, 8)}` as ScopedCapabilityToken;
    const capability: ScopedCapability = {
      token,
      taskId: this.taskIdValue,
      nodeId,
      providerId,
      maxAmount: max,
    };
    this.capabilities.set(token, capability);
    return capability;
  }

  getCapability(token: ScopedCapabilityToken): ScopedCapability | undefined {
    return this.capabilities.get(token);
  }
}

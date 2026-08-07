export interface BudgetStatus {
  cap: number;
  spent: number;
  reserved: number;
  available: number;
}

export type ReserveDecision =
  | { kind: "ok" }
  | {
      kind: "needs_approval";
      overspend: number;
      projected: number;
      cap: number;
    };

const round = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Treasury / budget object.
 *
 * Flow per step: reserve-on-select -> if over cap, PAUSE for approval
 * (never overspend silently) -> settle (reserved becomes spent) on
 * success, or release on failure.
 */
export class Treasury {
  private taskId: string;
  private cap: number;
  private spent = 0;
  private reserved = 0;
  private reservations = new Map<string, number>();

  constructor(taskId: string, cap: number) {
    this.taskId = taskId;
    this.cap = round(cap);
  }

  get task(): string {
    return this.taskId;
  }

  setCap(cap: number): void {
    this.cap = round(cap);
  }

  status(): BudgetStatus {
    return {
      cap: round(this.cap),
      spent: round(this.spent),
      reserved: round(this.reserved),
      available: round(this.cap - this.spent - this.reserved),
    };
  }

  /** Check whether `amount` could be reserved without exceeding the cap. */
  canReserve(amount: number): boolean {
    return round(this.spent + this.reserved + amount) <= round(this.cap);
  }

  /** Check whether the whole next wave of amounts fits under the cap. */
  canReserveAll(amounts: number[]): boolean {
    const total = amounts.reduce((s, a) => s + a, 0);
    return round(this.spent + this.reserved + total) <= round(this.cap);
  }

  /** What the budget would look like after reserving `amount`. */
  projection(amount: number): { projected: number; overspend: number } {
    const projected = round(this.spent + this.reserved + amount);
    return { projected, overspend: round(projected - this.cap) };
  }

  /**
   * Reserve funds for a node. Returns needs_approval (without reserving)
   * if it would exceed the cap — the caller must pause and ask.
   */
  reserve(nodeId: string, amount: number): ReserveDecision {
    const { projected } = this.projection(amount);
    if (projected <= this.cap) {
      this.reservations.set(nodeId, round(amount));
      this.reserved = round(this.reserved + amount);
      return { kind: "ok" };
    }
    return {
      kind: "needs_approval",
      projected,
      overspend: round(projected - this.cap),
      cap: this.cap,
    };
  }

  /** On success: reserved -> spent. */
  settle(nodeId: string): void {
    const amount = this.reservations.get(nodeId);
    if (amount === undefined) return;
    this.reservations.delete(nodeId);
    this.reserved = round(this.reserved - amount);
    this.spent = round(this.spent + amount);
  }

  /** On failure: free the reservation. */
  release(nodeId: string): void {
    const amount = this.reservations.get(nodeId);
    if (amount === undefined) return;
    this.reservations.delete(nodeId);
    this.reserved = round(this.reserved - amount);
  }

  /** One-time human approval that lifts the cap to cover a planned overspend. */
  approveOverspend(additionalCap: number): void {
    this.cap = round(this.cap + additionalCap);
  }
}

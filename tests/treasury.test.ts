import { describe, expect, it } from "vitest";
import { microAlgo, taskId, taskNodeId } from "@sentinel/schemas";
import { Treasury } from "@sentinel/treasury";

// ─── Treasury lifecycle ───────────────────────────────────────────────────────
// Treasury owns the budget, unconditionally. Reserve → release-on-failure →
// settle-on-success, overspend pauses for approval, and only treasury issues
// payment capabilities. Money is MicroAlgo (bigint) throughout.

const TASK = taskId("t-test");
const n1 = taskNodeId("n-wallet");
const n2 = taskNodeId("n-summary");

describe("Treasury reserve/release/settle", () => {
  it("reserves funds and reports them in status", () => {
    const t = new Treasury(TASK, microAlgo(1000n));
    expect(t.reserve(n1, microAlgo(300n))).toEqual({ kind: "ok" });

    const status = t.status();
    expect(status.cap).toBe(microAlgo(1000n));
    expect(status.reserved).toBe(microAlgo(300n));
    expect(status.spent).toBe(microAlgo(0n));
    expect(status.available).toBe(microAlgo(700n));
  });

  it("settle moves reserved → spent", () => {
    const t = new Treasury(TASK, microAlgo(1000n));
    t.reserve(n1, microAlgo(300n));
    t.settle(n1);
    expect(t.status().reserved).toBe(microAlgo(0n));
    expect(t.status().spent).toBe(microAlgo(300n));
    expect(t.status().available).toBe(microAlgo(700n));
  });

  it("release frees the reservation on failure", () => {
    const t = new Treasury(TASK, microAlgo(1000n));
    t.reserve(n1, microAlgo(300n));
    t.release(n1);
    expect(t.status().reserved).toBe(microAlgo(0n));
    expect(t.status().spent).toBe(microAlgo(0n));
    expect(t.status().available).toBe(microAlgo(1000n));
  });

  it("never overspends silently — needs_approval instead", () => {
    const t = new Treasury(TASK, microAlgo(500n));
    expect(t.reserve(n1, microAlgo(300n))).toEqual({ kind: "ok" });

    const decision = t.reserve(n2, microAlgo(300n));
    expect(decision.kind).toBe("needs_approval");
    if (decision.kind === "needs_approval") {
      expect(decision.projected).toBe(microAlgo(600n));
      expect(decision.overspend).toBe(microAlgo(100n));
      expect(decision.cap).toBe(microAlgo(500n));
    }
    // nothing was reserved for the rejected node
    expect(t.status().reserved).toBe(microAlgo(300n));
  });

  it("approveOverspend lifts the cap and unblocks the reserve", () => {
    const t = new Treasury(TASK, microAlgo(500n));
    t.reserve(n1, microAlgo(300n));
    const before = t.reserve(n2, microAlgo(300n));
    expect(before.kind).toBe("needs_approval");

    t.approveOverspend(microAlgo(200n));
    expect(t.reserve(n2, microAlgo(300n))).toEqual({ kind: "ok" });
    expect(t.status().cap).toBe(microAlgo(700n));
    expect(t.status().reserved).toBe(microAlgo(600n));
  });
});

describe("Treasury budget queries", () => {
  it("canReserve / canReserveAll respect the cap", () => {
    const t = new Treasury(TASK, microAlgo(1000n));
    expect(t.canReserve(microAlgo(400n))).toBe(true);
    expect(t.canReserve(microAlgo(1200n))).toBe(false);
    expect(t.canReserveAll([microAlgo(300n), microAlgo(400n)])).toBe(true);
    expect(t.canReserveAll([microAlgo(300n), microAlgo(900n)])).toBe(false);
  });

  it("projection reports projected + overspend", () => {
    const t = new Treasury(TASK, microAlgo(1000n));
    t.reserve(n1, microAlgo(400n));
    const { projected, overspend } = t.projection(microAlgo(800n));
    expect(projected).toBe(microAlgo(1200n));
    expect(overspend).toBe(microAlgo(200n));
  });
});

describe("Treasury capability issuance", () => {
  it("issues a scoped capability with max = reservation amount", () => {
    const t = new Treasury(TASK, microAlgo(1000n));
    t.reserve(n1, microAlgo(300n));
    const cap = t.issueCapability(n1, "provider-a", microAlgo(300n));

    expect(cap.taskId).toBe(TASK);
    expect(cap.nodeId).toBe(n1);
    expect(cap.providerId).toBe("provider-a");
    expect(cap.maxAmount).toBe(microAlgo(300n));
    expect(t.getCapability(cap.token)).toEqual(cap);
  });
});

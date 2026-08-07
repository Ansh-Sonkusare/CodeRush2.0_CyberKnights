import { describe, expect, it } from "vitest";
import {
  RunRequestSchema,
  WalletDataResponseSchema,
  jsonStringify,
  microAlgo,
} from "@sentinel/schemas";

// ─── Schema contract tests ────────────────────────────────────────────────────
// Bigint leaves serialize as decimal strings at the boundary (jsonStringify);
// .strict() schemas reject undeclared fields structurally. Both rules are the
// mechanism the policy guard + wire layer depend on — if these break, provider
// responses could smuggle fields into treasury/ledger state.

describe("jsonStringify", () => {
  it("converts bigint leaves to decimal strings", () => {
    const raw = jsonStringify({ amount: microAlgo(123n), nested: { spent: 456n } });
    expect(raw).toBe('{"amount":"123","nested":{"spent":"456"}}');
  });

  it("leaves ordinary JSON values untouched", () => {
    const raw = jsonStringify({ taskId: "t-x", ok: true, score: 0.5 });
    expect(raw).toBe('{"taskId":"t-x","ok":true,"score":0.5}');
  });
});

describe("strict schemas (trust boundary)", () => {
  it("RunRequestSchema rejects undeclared fields", () => {
    const parsed = RunRequestSchema.safeParse({
      goal: "assess wallet X",
      cap: "1000",
      attacker: "smuggle",
    });
    expect(parsed.success).toBe(false);
  });

  it("RunRequestSchema accepts cap as a decimal string", () => {
    const parsed = RunRequestSchema.safeParse({ goal: "assess wallet X", cap: "1000" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.cap).toBe("1000");
  });

  it("RunRequestSchema rejects a non-decimal cap", () => {
    const parsed = RunRequestSchema.safeParse({ goal: "g", cap: "1.5" });
    expect(parsed.success).toBe(false);
  });

  it("a provider response with an undeclared field is rejected", () => {
    const parsed = WalletDataResponseSchema.safeParse({
      wallet_address: "ALGO...",
      portfolio_value_usd: "123.45",
      fetched_at: "2026-08-07T00:00:00.000Z",
      bonus: "unexpected",
    });
    expect(parsed.success).toBe(false);
  });

  it("a well-formed wallet-data response passes", () => {
    const parsed = WalletDataResponseSchema.safeParse({
      wallet_address: "ALGO...",
      portfolio_value_usd: "123.45",
      fetched_at: "2026-08-07T00:00:00.000Z",
    });
    expect(parsed.success).toBe(true);
  });
});

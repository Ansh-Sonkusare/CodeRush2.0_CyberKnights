import { describe, expect, it } from "vitest";
import {
  type Capability,
  type DeliverResponse,
  type ProviderAdapter,
  type QuoteResponse,
  microAlgo,
} from "@sentinel/schemas";
import {
  BanditRouter,
  DEFAULT_WEIGHTS,
  WeightedRouter,
  createRouter,
  profileForGoal,
  resolveWeights,
  weightsForGoal,
  weightsForProfile,
} from "@sentinel/router";

// ─── Prompt-aware router tests ────────────────────────────────────────────────
// Covers the keyword heuristic (profileForGoal), the per-profile weights, the
// LLM-vs-heuristic precedence, and the weighted/bandit selection behavior —
// including the optional network filter added for multi-network prep.

const CAP = "fetch_wallet_data";

function mockAdapter(
  providerId: string,
  capability: Capability,
  opts: {
    priceMicroAlgo: bigint;
    latencyMs: number;
    quality: number;
    role?: "primary" | "backup";
    network?: string;
  },
): ProviderAdapter {
  const { priceMicroAlgo, latencyMs, quality, role = "primary", network } = opts;
  return {
    providerId,
    capability,
    priceHint: microAlgo(priceMicroAlgo),
    latencyHintMs: latencyMs,
    qualityScore: quality,
    baseUrl: `https://mock.${providerId}.invalid`,
    role,
    integration: "mock",
    ...(network !== undefined ? { network } : {}),
    async quote(): Promise<{ ok: true; value: QuoteResponse }> {
      return {
        ok: true,
        value: {
          invoice_id: `inv-${providerId}`,
          provider_id: providerId,
          capability,
          price: Number(priceMicroAlgo),
          currency: "uAlgo",
          schema: "x402@0.1",
          terms_expires_at: new Date(Date.now() + 60_000).toISOString(),
          payment_required: true,
        },
      };
    },
    async deliver(): Promise<{ ok: true; value: DeliverResponse }> {
      return {
        ok: true,
        value: {
          result: { ok: true },
          receipt: {
            receipt_id: `r-${providerId}`,
            tx_ref: `ref-${providerId}`,
            provider_id: providerId,
            settled_at: new Date().toISOString(),
            already_settled: false,
          },
        },
      };
    },
    async health() {
      return { ok: true };
    },
  };
}

describe("profileForGoal — keyword heuristic", () => {
  it("maps price keywords to price", () => {
    expect(profileForGoal("find me the cheapest route")).toBe("price");
    expect(profileForGoal("stick to a strict budget")).toBe("price");
    expect(profileForGoal("keep the cost down")).toBe("price");
    expect(profileForGoal("low price preferred")).toBe("price");
  });

  it("maps quality keywords to quality", () => {
    expect(profileForGoal("best reliable provider")).toBe("quality");
    expect(profileForGoal("premium quality please")).toBe("quality");
  });

  it("maps latency keywords to latency", () => {
    expect(profileForGoal("low latency is required")).toBe("latency");
    expect(profileForGoal("make it fast")).toBe("latency");
    expect(profileForGoal("quick and speedy")).toBe("latency");
  });

  it("maps an unmatched goal to balanced", () => {
    expect(profileForGoal("hello world")).toBe("balanced");
    expect(profileForGoal("assess this wallet")).toBe("balanced");
  });

  it("resolves a cross-profile keyword tie to balanced", () => {
    expect(profileForGoal("CHEAP AND FAST")).toBe("balanced");
    expect(profileForGoal("cheap but reliable")).toBe("balanced");
  });

  it("matches case-insensitively", () => {
    expect(profileForGoal("BUDGET")).toBe("price");
    expect(profileForGoal("QUALITY")).toBe("quality");
  });
});

describe("weightsForProfile — exact per-profile weights", () => {
  it("returns the exact price weights", () => {
    expect(weightsForProfile("price")).toEqual({
      price: 0.8,
      latency: 0.1,
      quality: 0.1,
      qualityThreshold: 0.7,
    });
  });

  it("returns the exact quality weights with a raised quality bar", () => {
    expect(weightsForProfile("quality")).toEqual({
      price: 0.1,
      latency: 0.1,
      quality: 0.8,
      qualityThreshold: 0.85,
    });
  });

  it("returns the exact latency weights", () => {
    expect(weightsForProfile("latency")).toEqual({
      price: 0.2,
      latency: 0.7,
      quality: 0.1,
      qualityThreshold: 0.7,
    });
  });

  it("returns balanced weights equal to — but not identical to — DEFAULT_WEIGHTS", () => {
    const balanced = weightsForProfile("balanced");
    expect(balanced).toEqual(DEFAULT_WEIGHTS);
    expect(balanced).not.toBe(DEFAULT_WEIGHTS);
  });

  it("never mutates DEFAULT_WEIGHTS", () => {
    weightsForProfile("price");
    weightsForProfile("quality");
    weightsForProfile("latency");
    weightsForProfile("balanced");
    expect(DEFAULT_WEIGHTS).toEqual({
      price: 0.5,
      latency: 0.3,
      quality: 0.2,
      qualityThreshold: 0.7,
    });
  });
});

describe("weightsForGoal — heuristic weights", () => {
  it("derives price weights from a cheap goal", () => {
    expect(weightsForGoal("cheapest possible")).toEqual(weightsForProfile("price"));
  });

  it("derives quality weights from a quality goal", () => {
    expect(weightsForGoal("best reliable provider")).toEqual(weightsForProfile("quality"));
  });

  it("derives the default weights from an unmatched goal", () => {
    expect(weightsForGoal("hello world")).toEqual(DEFAULT_WEIGHTS);
  });
});

describe("resolveWeights — precedence", () => {
  it("lets the LLM profile win over goal keywords", () => {
    expect(resolveWeights("cheapest possible", "quality")).toEqual(
      weightsForProfile("quality"),
    );
  });

  it("falls back to the heuristic when no LLM profile is given", () => {
    expect(resolveWeights("cheapest possible")).toEqual(weightsForProfile("price"));
  });

  it("falls back to balanced defaults for an unmatched goal with no LLM profile", () => {
    const resolved = resolveWeights("hello world");
    expect(resolved).toEqual(DEFAULT_WEIGHTS);
    expect(resolved).not.toBe(DEFAULT_WEIGHTS);
  });
});

describe("WeightedRouter — profile-aware selection", () => {
  const cheap = mockAdapter("cheap-mock", CAP, {
    priceMicroAlgo: 100n,
    latencyMs: 50,
    quality: 0.7,
  });
  const premium = mockAdapter("premium-mock", CAP, {
    priceMicroAlgo: 1000n,
    latencyMs: 50,
    quality: 0.95,
  });
  const adapters = [cheap, premium];

  it("picks the cheap provider under price weights", () => {
    const router = new WeightedRouter(adapters, weightsForProfile("price"));
    const pick = router.select(CAP);
    expect(pick.ok).toBe(true);
    if (pick.ok) expect(pick.value.adapter.providerId).toBe("cheap-mock");
  });

  it("picks the premium provider under quality weights", () => {
    const router = new WeightedRouter(adapters, weightsForProfile("quality"));
    const pick = router.select(CAP);
    expect(pick.ok).toBe(true);
    if (pick.ok) expect(pick.value.adapter.providerId).toBe("premium-mock");
  });

  it("picks the fast provider under latency weights", () => {
    const slow = mockAdapter("slow-mock", CAP, {
      priceMicroAlgo: 100n,
      latencyMs: 1000,
      quality: 0.7,
    });
    const fast = mockAdapter("fast-mock", CAP, {
      priceMicroAlgo: 1000n,
      latencyMs: 100,
      quality: 0.95,
    });
    const router = new WeightedRouter([slow, fast], weightsForProfile("latency"));
    const pick = router.select(CAP);
    expect(pick.ok).toBe(true);
    if (pick.ok) expect(pick.value.adapter.providerId).toBe("fast-mock");
  });

  it("createRouter passes profile weights through unchanged", () => {
    const router = createRouter(adapters, { weights: weightsForProfile("price") });
    const pick = router.select(CAP);
    expect(pick.ok).toBe(true);
    if (pick.ok) expect(pick.value.adapter.providerId).toBe("cheap-mock");
  });
});

describe("select — optional network filter", () => {
  const testnet = mockAdapter("testnet-provider", "search", {
    priceMicroAlgo: 100n,
    latencyMs: 50,
    quality: 0.9,
    network: "testnet",
  });
  const beta = mockAdapter("beta-provider", "search", {
    priceMicroAlgo: 200n,
    latencyMs: 50,
    quality: 0.9,
    network: "algorand:beta",
  });

  it("restricts candidates to the requested network", () => {
    const router = new WeightedRouter([testnet, beta]);
    const betaPick = router.select("search", [], "algorand:beta");
    expect(betaPick.ok).toBe(true);
    if (betaPick.ok) expect(betaPick.value.adapter.providerId).toBe("beta-provider");

    const testnetPick = router.select("search", [], "testnet");
    expect(testnetPick.ok).toBe(true);
    if (testnetPick.ok) expect(testnetPick.value.adapter.providerId).toBe("testnet-provider");
  });

  it("behaves as before when no network filter is given", () => {
    const router = new WeightedRouter([testnet, beta]);
    const pick = router.select("search");
    expect(pick.ok).toBe(true);
    if (pick.ok) {
      expect(["testnet-provider", "beta-provider"]).toContain(pick.value.adapter.providerId);
    }
  });

  it("treats an adapter without a network as testnet", () => {
    const noNetwork = mockAdapter("no-net", "extract", {
      priceMicroAlgo: 100n,
      latencyMs: 50,
      quality: 0.9,
    });
    const explicit = mockAdapter("explicit-testnet", "extract", {
      priceMicroAlgo: 150n,
      latencyMs: 50,
      quality: 0.9,
      network: "testnet",
    });
    const router = new WeightedRouter([noNetwork, explicit]);
    const pick = router.select("extract", [], "testnet");
    expect(pick.ok).toBe(true);
    if (pick.ok) {
      expect(["no-net", "explicit-testnet"]).toContain(pick.value.adapter.providerId);
    }
  });

  it("errors cleanly when no provider is registered on the requested network", () => {
    const router = new WeightedRouter([testnet, beta]);
    const pick = router.select("search", [], "mainnet");
    expect(pick.ok).toBe(false);
    if (!pick.ok) {
      expect(pick.error.kind).toBe("capability_unsupported");
      expect(pick.error.message).toContain('"mainnet"');
    }
  });

  it("BanditRouter accepts the same optional network filter", () => {
    const router = new BanditRouter([testnet, beta]);
    const betaPick = router.select("search", [], "algorand:beta");
    expect(betaPick.ok).toBe(true);
    if (betaPick.ok) expect(betaPick.value.adapter.providerId).toBe("beta-provider");

    const noFilter = router.select("search");
    expect(noFilter.ok).toBe(true);
  });
});

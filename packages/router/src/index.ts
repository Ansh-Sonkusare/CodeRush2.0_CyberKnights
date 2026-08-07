import {
  type Capability,
  type IdempotencyKey,
  type ProviderAdapter,
  type Result,
  type RouteDecision,
  type RouterError,
  err,
  idempotencyKey as makeIdempotencyKey,
  ok,
} from "@sentinel/schemas";

// ─── Idempotency keys ─────────────────────────────────────────────────────────
// Generated ONCE per (task, node, provider) triple, in one canonical place.
// Consumers import from here, never re-derive keys ad hoc at retry time.
export { makeIdempotencyKey as idempotencyKey };

// ─── Weights ──────────────────────────────────────────────────────────────────

export interface RouterWeights {
  price: number;
  latency: number;
  quality: number;
  qualityThreshold: number;
}

export const DEFAULT_WEIGHTS: RouterWeights = {
  price: 0.5,
  latency: 0.3,
  quality: 0.2,
  qualityThreshold: 0.7,
};

export type RouterMode = "weighted" | "bandit";

export interface Router {
  select(
    capability: Capability,
    excludeProviderIds?: readonly string[],
  ): Result<RouteDecision, RouterError>;
}

const round = (n: number, places = 4): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

// ─── Weighted scoring (baseline) ──────────────────────────────────────────────

interface ScoredCandidate {
  adapter: ProviderAdapter;
  score: number;
  cheapest: boolean;
  fastest: boolean;
  highestQuality: boolean;
}

function scoreCandidates(
  candidates: ProviderAdapter[],
  weights: RouterWeights,
): ScoredCandidate[] {
  // priceHint is MicroAlgo (bigint); convert to number for min/max
  // normalization only — never used as a payment amount.
  const prices = candidates.map((a) => Number(a.priceHint));
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const latencies = candidates.map((a) => a.latencyHintMs);
  const minLat = Math.min(...latencies);
  const maxLat = Math.max(...latencies);
  const maxQuality = Math.max(...candidates.map((a) => a.qualityScore));

  return candidates.map((adapter) => {
    const price = Number(adapter.priceHint);
    const priceNorm = maxPrice > minPrice ? (price - minPrice) / (maxPrice - minPrice) : 0;
    const latencyNorm = maxLat > minLat ? (adapter.latencyHintMs - minLat) / (maxLat - minLat) : 0;
    const qualityPenalty = 1 - adapter.qualityScore;
    const score =
      weights.price * priceNorm +
      weights.latency * latencyNorm +
      weights.quality * qualityPenalty;

    return {
      adapter,
      score,
      cheapest: price === minPrice,
      fastest: adapter.latencyHintMs === minLat,
      highestQuality: adapter.qualityScore === maxQuality,
    };
  });
}

function toDecision(c: ScoredCandidate, capability: Capability, weights: RouterWeights): RouteDecision {
  const factors: string[] = [];
  if (c.cheapest) factors.push(`lowest price ${Number(c.adapter.priceHint)}uAlgo`);
  if (c.fastest) factors.push(`lowest latency ${c.adapter.latencyHintMs}ms`);
  if (c.highestQuality) factors.push(`highest quality ${c.adapter.qualityScore}`);
  const why = factors.length > 0 ? ` — ${factors.join(", ")}` : "";
  const role = c.adapter.role === "backup" ? " [BACKUP]" : "";

  const reason =
    `picked ${c.adapter.providerId}${role} for "${capability}" (score ${round(c.score)}): ` +
    `price ${Number(c.adapter.priceHint)}uAlgo, latency ${c.adapter.latencyHintMs}ms, ` +
    `quality ${c.adapter.qualityScore} >= threshold ${weights.qualityThreshold}` +
    why;

  return { adapter: c.adapter, score: round(c.score), reason };
}

/**
 * Baseline weighted router. price/latency are normalized min-max over
 * candidates; quality is a penalty term (1 - quality). A hard quality
 * threshold filters out providers that are too unreliable, whatever the price.
 */
export class WeightedRouter implements Router {
  constructor(
    private readonly adapters: ProviderAdapter[],
    private readonly weights: RouterWeights = DEFAULT_WEIGHTS,
  ) {}

  select(
    capability: Capability,
    excludeProviderIds: readonly string[] = [],
  ): Result<RouteDecision, RouterError> {
    const forCapability = this.adapters.filter((a) => a.capability === capability);
    if (forCapability.length === 0) {
      return err({
        kind: "capability_unsupported",
        capability,
        message: `no provider registered for capability "${capability}"`,
      });
    }

    const excluded = new Set(excludeProviderIds);
    const remaining = forCapability.filter((a) => !excluded.has(a.providerId));
    if (remaining.length === 0) {
      return err({
        kind: "no_candidate",
        capability,
        message: `all providers for "${capability}" are excluded (${[...excluded].join(", ")})`,
      });
    }

    const candidates = remaining.filter(
      (a) => a.qualityScore >= this.weights.qualityThreshold,
    );
    if (candidates.length === 0) {
      return err({
        kind: "all_below_threshold",
        capability,
        message:
          `no candidate for "${capability}" meets quality threshold ` +
          `${this.weights.qualityThreshold} (all: ` +
          `${remaining.map((p) => `${p.providerId}=${p.qualityScore}`).join(", ")})`,
      });
    }

    const scored = scoreCandidates(candidates, this.weights).sort((a, b) => a.score - b.score);
    const best = scored[0];
    if (!best) {
      return err({
        kind: "unknown",
        capability,
        message: `no candidate could be scored for "${capability}"`,
      });
    }
    return ok(toDecision(best, capability, this.weights));
  }
}

// ─── UCB1 bandit (stretch optimizer) ──────────────────────────────────────────

/** Per-provider bandit stats for one capability. */
export interface ArmStats {
  providerId: string;
  nPulls: number;
  totalReward: number;
  meanReward: number;
}

/**
 * Composite reward signal: higher = better provider, normalised on [0, 1].
 * qualityScore contributes positively; price/latency negatively.
 */
export function computeReward(
  qualityScore: number,
  latencyMs: number,
  priceHint: bigint,
  maxLatency = 700,
  maxPriceMicroAlgo = 100_000,
): number {
  const latencyNorm = Math.max(0, 1 - latencyMs / maxLatency);
  const priceNorm = Math.max(0, 1 - Number(priceHint) / maxPriceMicroAlgo);
  // weights: quality 40%, latency 30%, price 30%
  return 0.4 * qualityScore + 0.3 * latencyNorm + 0.3 * priceNorm;
}

/**
 * UCB1 multi-armed bandit router. Maintains per-capability arm stats and uses
 * the UCB1 exploration bonus to choose providers, updating beliefs after each
 * observed outcome. Falls back to exploration of untouched arms first.
 */
export class BanditRouter implements Router {
  private arms = new Map<string, Map<string, ArmStats>>();
  private totalPulls = new Map<string, number>();

  constructor(private readonly adapters: ProviderAdapter[]) {}

  select(
    capability: Capability,
    excludeProviderIds: readonly string[] = [],
  ): Result<RouteDecision, RouterError> {
    const forCapability = this.adapters.filter((a) => a.capability === capability);
    if (forCapability.length === 0) {
      return err({
        kind: "capability_unsupported",
        capability,
        message: `no provider registered for capability "${capability}"`,
      });
    }

    const excluded = new Set(excludeProviderIds);
    const candidates = forCapability.filter((a) => !excluded.has(a.providerId));
    if (candidates.length === 0) {
      return err({
        kind: "no_candidate",
        capability,
        message: `all providers for "${capability}" are excluded (${[...excluded].join(", ")})`,
      });
    }

    const capArms = this.getCapArms(capability);
    const t = this.totalPulls.get(capability) ?? 0;

    const scored = candidates.map((adapter) => {
      const arm = capArms.get(adapter.providerId);
      if (!arm || arm.nPulls === 0) {
        // Unexplored arm — highest priority (UCB1: treat as +Inf)
        return { adapter, ucb: Infinity, arm };
      }
      const ucb = arm.meanReward + Math.sqrt((2 * Math.log(t + 1)) / arm.nPulls);
      return { adapter, ucb, arm };
    });

    scored.sort((a, b) => b.ucb - a.ucb);
    const best = scored[0];
    if (!best) {
      return err({
        kind: "unknown",
        capability,
        message: `no candidate could be selected for "${capability}"`,
      });
    }
    const arm = best.arm;

    const explorationNote =
      !arm || arm.nPulls === 0
        ? " [EXPLORING — never tried]"
        : ` [UCB1 score=${best.ucb.toFixed(4)}, pulls=${arm.nPulls}, mean_reward=${arm.meanReward.toFixed(4)}]`;

    const reason =
      `bandit picked ${best.adapter.providerId} for "${capability}" ` +
      `(price ${Number(best.adapter.priceHint)}uAlgo, latency ${best.adapter.latencyHintMs}ms, ` +
      `quality ${best.adapter.qualityScore})` +
      explorationNote;

    return ok({ adapter: best.adapter, score: 0, reason });
  }

  /** Call once per successful or failed provider interaction. */
  updateArm(
    capability: Capability,
    providerId: string,
    qualityScore: number,
    latencyMs: number,
    priceHint: bigint,
    success: boolean,
  ): void {
    const reward = success ? computeReward(qualityScore, latencyMs, priceHint) : 0;
    const capArms = this.getCapArms(capability);
    let arm = capArms.get(providerId);
    if (!arm) {
      arm = { providerId, nPulls: 0, totalReward: 0, meanReward: 0 };
      capArms.set(providerId, arm);
    }
    arm.nPulls += 1;
    arm.totalReward += reward;
    arm.meanReward = arm.totalReward / arm.nPulls;
    this.totalPulls.set(capability, (this.totalPulls.get(capability) ?? 0) + 1);
  }

  /** Dump current arm stats for the evaluation harness. */
  getStats(): Record<string, Record<string, ArmStats>> {
    const out: Record<string, Record<string, ArmStats>> = {};
    for (const [cap, arms] of this.arms) {
      out[cap] = {};
      for (const [pid, stats] of arms) {
        out[cap][pid] = { ...stats };
      }
    }
    return out;
  }

  private getCapArms(capability: Capability): Map<string, ArmStats> {
    let m = this.arms.get(capability);
    if (!m) {
      m = new Map();
      this.arms.set(capability, m);
    }
    return m;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createRouter(
  adapters: ProviderAdapter[],
  options: { mode?: RouterMode; weights?: RouterWeights } = {},
): Router {
  return options.mode === "bandit"
    ? new BanditRouter(adapters)
    : new WeightedRouter(adapters, options.weights ?? DEFAULT_WEIGHTS);
}

export type { IdempotencyKey };

import { Capability, ProviderCatalogEntry } from "../types.js";
import { PROVIDER_CATALOG } from "../config/providers.js";

/** Per-provider bandit stats for one capability. */
export interface ArmStats {
  provider_id: string;
  n_pulls: number;
  total_reward: number;
  mean_reward: number;
}

function initArm(providerId: string): ArmStats {
  return { provider_id: providerId, n_pulls: 0, total_reward: 0, mean_reward: 0 };
}

/**
 * Composite reward signal: higher = better provider.
 * Normalised on [0, 1] where:
 *   quality_score contributes positively,
 *   price and latency contribute negatively (normalized by rough maxima).
 */
export function computeReward(
  qualityScore: number,
  latencyMs: number,
  price: number,
  maxLatency = 700,
  maxPrice = 0.1,
): number {
  const latencyNorm = Math.max(0, 1 - latencyMs / maxLatency);
  const priceNorm = Math.max(0, 1 - price / maxPrice);
  // weights: quality 40%, latency 30%, price 30%
  return 0.4 * qualityScore + 0.3 * latencyNorm + 0.3 * priceNorm;
}

/**
 * UCB1 Multi-Armed Bandit optimizer.
 * Maintains per-capability arm stats and uses UCB1 exploration bonus to
 * choose providers, updating beliefs after each observed outcome.
 *
 * Falls back to baseline scoring before any arm has been pulled.
 */
export class BanditOptimizer {
  /** arms[capability][provider_id] = ArmStats */
  private arms = new Map<Capability, Map<string, ArmStats>>();
  private totalPulls = new Map<Capability, number>();

  /** Call once per successful or failed provider interaction. */
  updateArm(
    capability: Capability,
    providerId: string,
    qualityScore: number,
    latencyMs: number,
    price: number,
    success: boolean,
  ): void {
    const reward = success ? computeReward(qualityScore, latencyMs, price) : 0;
    const capArms = this.getCapArms(capability);
    let arm = capArms.get(providerId);
    if (!arm) {
      arm = initArm(providerId);
      capArms.set(providerId, arm);
    }
    arm.n_pulls += 1;
    arm.total_reward += reward;
    arm.mean_reward = arm.total_reward / arm.n_pulls;
    this.totalPulls.set(capability, (this.totalPulls.get(capability) ?? 0) + 1);
  }

  /**
   * Pick the best provider for a capability using UCB1.
   * Unpulled arms are explored first (UCB1 convention).
   * Returns the selected provider and the reason string.
   */
  pick(
    capability: Capability,
    excludeProviderIds: string[] = [],
  ): { provider: ProviderCatalogEntry; reason: string } | null {
    const excluded = new Set(excludeProviderIds);
    const candidates = PROVIDER_CATALOG.filter(
      (p) => p.capability === capability && !excluded.has(p.provider_id),
    );
    if (candidates.length === 0) return null;

    const capArms = this.getCapArms(capability);
    const t = this.totalPulls.get(capability) ?? 0;

    // Score each candidate via UCB1
    const scored = candidates.map((p) => {
      const arm = capArms.get(p.provider_id);
      if (!arm || arm.n_pulls === 0) {
        // Unexplored arm — highest priority (UCB1: treat as +Inf)
        return { provider: p, ucb: Infinity, arm };
      }
      const ucb = arm.mean_reward + Math.sqrt((2 * Math.log(t + 1)) / arm.n_pulls);
      return { provider: p, ucb, arm };
    });

    scored.sort((a, b) => b.ucb - a.ucb);
    const best = scored[0];
    const arm = best.arm;

    const explorationNote =
      !arm || arm.n_pulls === 0
        ? " [EXPLORING — never tried]"
        : ` [UCB1 score=${best.ucb.toFixed(4)}, pulls=${arm.n_pulls}, mean_reward=${arm.mean_reward.toFixed(4)}]`;

    const reason =
      `bandit picked ${best.provider.provider_id} for "${capability}" ` +
      `(price $${best.provider.price.toFixed(4)}, latency ${best.provider.latency_ms}ms, ` +
      `quality ${best.provider.quality_score})` +
      explorationNote;

    return { provider: best.provider, reason };
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
    if (!m) { m = new Map(); this.arms.set(capability, m); }
    return m;
  }
}

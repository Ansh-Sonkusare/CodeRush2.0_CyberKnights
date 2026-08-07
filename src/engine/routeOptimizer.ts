import { Capability, ProviderCatalogEntry } from "../types.js";
import { catalogFor } from "../config/providers.js";

export interface OptimizerWeights {
  price: number;
  latency: number;
  quality: number;
  quality_threshold: number;
}

export const DEFAULT_WEIGHTS: OptimizerWeights = {
  price: 0.5,
  latency: 0.3,
  quality: 0.2,
  quality_threshold: 0.7,
};

export interface RouteDecision {
  provider: ProviderCatalogEntry;
  /** Lower is better (0 = ideal). */
  score: number;
  priceNorm: number;
  latencyNorm: number;
  qualityPenalty: number;
  reason: string;
}

const round = (n: number, places = 4) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

interface ScoredCandidate {
  provider: ProviderCatalogEntry;
  score: number;
  priceNorm: number;
  latencyNorm: number;
  qualityPenalty: number;
  cheapest: boolean;
  fastest: boolean;
  highestQuality: boolean;
}

function scoreCandidates(
  candidates: ProviderCatalogEntry[],
  weights: OptimizerWeights,
): ScoredCandidate[] {
  const minPrice = Math.min(...candidates.map((c) => c.price));
  const maxPrice = Math.max(...candidates.map((c) => c.price));
  const minLat = Math.min(...candidates.map((c) => c.latency_ms));
  const maxLat = Math.max(...candidates.map((c) => c.latency_ms));
  const maxQuality = Math.max(...candidates.map((c) => c.quality_score));

  return candidates.map((provider) => {
    const priceNorm =
      maxPrice > minPrice ? (provider.price - minPrice) / (maxPrice - minPrice) : 0;
    const latencyNorm =
      maxLat > minLat ? (provider.latency_ms - minLat) / (maxLat - minLat) : 0;
    const qualityPenalty = 1 - provider.quality_score;
    const score =
      weights.price * priceNorm +
      weights.latency * latencyNorm +
      weights.quality * qualityPenalty;

    return {
      provider,
      score,
      priceNorm,
      latencyNorm,
      qualityPenalty,
      cheapest: provider.price === minPrice,
      fastest: provider.latency_ms === minLat,
      highestQuality: provider.quality_score === maxQuality,
    };
  });
}

function toDecision(c: ScoredCandidate, capability: Capability, weights: OptimizerWeights): RouteDecision {
  const factors = [];
  if (c.cheapest) factors.push(`lowest price $${c.provider.price.toFixed(4)}`);
  if (c.fastest) factors.push(`lowest latency ${c.provider.latency_ms}ms`);
  if (c.highestQuality) factors.push(`highest quality ${c.provider.quality_score}`);
  const why = factors.length > 0 ? ` — ${factors.join(", ")}` : "";
  const role = c.provider.role === "backup" ? " [BACKUP]" : "";

  const reason =
    `picked ${c.provider.provider_id}${role} for "${capability}" (score ${round(c.score)}): ` +
    `price $${c.provider.price.toFixed(4)}, latency ${c.provider.latency_ms}ms, ` +
    `quality ${c.provider.quality_score} >= threshold ${weights.quality_threshold}` +
    why;

  return {
    provider: c.provider,
    score: round(c.score),
    priceNorm: round(c.priceNorm),
    latencyNorm: round(c.latencyNorm),
    qualityPenalty: round(c.qualityPenalty),
    reason,
  };
}

/**
 * Picks the best provider for a capability using a weighted score.
 * price/latency are normalized min-max over candidates; quality is a
 * penalty term (1 - quality). A hard quality threshold filters out
 * providers that are too unreliable, whatever the price.
 */
export function pickProvider(
  capability: Capability,
  weights: OptimizerWeights = DEFAULT_WEIGHTS,
): RouteDecision {
  const all = catalogFor(capability);
  const candidates = all.filter((p) => p.quality_score >= weights.quality_threshold);

  if (candidates.length === 0) {
    throw new Error(
      `route optimizer: no candidate for "${capability}" meets quality threshold ` +
        `${weights.quality_threshold} (all: ${all.map((p) => `${p.provider_id}=${p.quality_score}`).join(", ")})`,
    );
  }

  const scored = scoreCandidates(candidates, weights).sort((a, b) => a.score - b.score);
  return toDecision(scored[0], capability, weights);
}

/**
 * Next-best provider for a capability, excluding already-tried providers.
 * Returns null when no other candidate is usable — the caller should then
 * declare the step failed and let dependents abort.
 */
export function pickFallback(
  capability: Capability,
  excludeProviderIds: string[],
  weights: OptimizerWeights = DEFAULT_WEIGHTS,
): RouteDecision | null {
  const excluded = new Set(excludeProviderIds);
  const all = catalogFor(capability).filter((p) => !excluded.has(p.provider_id));
  if (all.length === 0) return null;

  const candidates = all.filter((p) => p.quality_score >= weights.quality_threshold);
  if (candidates.length === 0) return null;

  const scored = scoreCandidates(candidates, weights).sort((a, b) => a.score - b.score);
  return toDecision(scored[0], capability, weights);
}

export function formatReason(d: RouteDecision): string {
  return d.reason;
}

export type { ProviderCatalogEntry };

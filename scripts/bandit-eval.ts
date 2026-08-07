import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Capability } from "../src/types.js";
import { PROVIDER_CATALOG } from "../src/config/providers.js";
import { pickProvider, DEFAULT_WEIGHTS } from "../src/engine/routeOptimizer.js";
import { BanditOptimizer, computeReward } from "../src/engine/banditOptimizer.js";

// ── Phase 5: held-out eval harness ───────────────────────────────────────────
// Proves the UCB1 bandit beats the static-weighted baseline when providers'
// REAL behavior differs from what the catalog advertises. Both arms play the
// SAME pre-generated outcome table (common random numbers) so the comparison
// is fair: the only difference is how each arm chooses a provider.
//
// Headline metric = cumulative delivered reward (the composite reward the
// agent actually gets across all paid calls). Regret vs the per-capability
// oracle is reported as secondary. A control scenario (truthful catalog)
// shows the bandit does NOT win when there is nothing to learn.

const ALL_CAPS: Capability[] = ["search", "extract", "translate", "rank", "verify"];

const ROUNDS = 1000;
const QUALITY_SIGMA = 0.03;
const LATENCY_SIGMA = 15;

/** Seeded PRNG so the whole run is reproducible (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

interface Scenario {
  name: string;
  description: string;
  /** "provider_id:capability" -> REAL (held-out) mean quality, overriding the catalog claim. */
  trueQuality?: Record<string, number>;
  /** "provider_id:capability" -> multiplier on REAL (held-out) mean latency. */
  latencyMul?: Record<string, number>;
}

const SCENARIOS: Scenario[] = [
  {
    name: "adversarial-holdout",
    description:
      "Every capability's catalog favorite secretly under-delivers: the provider the baseline buys for each step claims to be cheap/good but its real quality is ~0.15 and latency ~4-5x the catalog. The baseline trusts the catalog and keeps buying duds; the bandit must discover the true ranking.",
    trueQuality: {
      "search-a:search": 0.15,
      "lingo-b:extract": 0.2,
      "lingo-b:translate": 0.2,
      "fastrank-c:rank": 0.15,
      "fastrank-c:verify": 0.15,
    },
    latencyMul: {
      "search-a:search": 4,
      "lingo-b:extract": 4,
      "lingo-b:translate": 4,
      "fastrank-c:rank": 5,
      "fastrank-c:verify": 5,
    },
  },
  {
    name: "control-truthful",
    description:
      "Control: the catalog claims are accurate. A competent static baseline should be near-optimal here — the bandit should only pay a small exploration cost and roughly tie.",
  },
];

interface ProviderTrue {
  provider_id: string;
  price: number;
  true_quality: number;
  true_latency_ms: number;
}

interface Outcome {
  quality: number;
  latency_ms: number;
}

interface ArmAggregate {
  picks: Record<string, number>;
  total_cost: number;
  reward_sum: number;
  quality_sum: number;
  latency_sum: number;
  regret: number;
  n: number;
}

function newAggregate(): ArmAggregate {
  return { picks: {}, total_cost: 0, reward_sum: 0, quality_sum: 0, latency_sum: 0, regret: 0, n: 0 };
}

function recordPick(agg: ArmAggregate, providerId: string, price: number): void {
  agg.picks[providerId] = (agg.picks[providerId] ?? 0) + 1;
  agg.total_cost += price;
  agg.n += 1;
}

function buildTrueMeans(scenario: Scenario): Map<Capability, ProviderTrue[]> {
  const byCap = new Map<Capability, ProviderTrue[]>();
  for (const cap of ALL_CAPS) {
    const providers = PROVIDER_CATALOG.filter((p) => p.capability === cap);
    byCap.set(
      cap,
      providers.map((p) => ({
        provider_id: p.provider_id,
        price: p.price,
        true_quality:
          scenario.trueQuality?.[`${p.provider_id}:${cap}`] ?? p.quality_score,
        true_latency_ms:
          (scenario.latencyMul?.[`${p.provider_id}:${cap}`] ?? 1) * p.latency_ms,
      })),
    );
  }
  return byCap;
}

function evaluateScenario(
  scenario: Scenario,
  seed: number,
): {
  byCapability: Record<string, { baseline: ArmAggregate; bandit: ArmAggregate; winner: string }>;
  totals: { baseline: ArmAggregate; bandit: ArmAggregate };
  learned: Record<string, Record<string, unknown>>;
  trueBest: Record<string, string>;
} {
  const trueMeans = buildTrueMeans(scenario);
  const rng = mulberry32(seed);

  // Common random numbers: one outcome per (provider, round) that BOTH arms see.
  const outcomes = new Map<string, Outcome[]>();
  for (const cap of ALL_CAPS) {
    for (const p of trueMeans.get(cap)!) {
      const series: Outcome[] = [];
      for (let r = 0; r < ROUNDS; r++) {
        const quality = Math.min(1, Math.max(0, p.true_quality + gaussian(rng) * QUALITY_SIGMA));
        const latency = Math.max(0, p.true_latency_ms + gaussian(rng) * LATENCY_SIGMA);
        series.push({ quality, latency_ms: latency });
      }
      outcomes.set(`${p.provider_id}:${cap}`, series);
    }
  }

  const bandit = new BanditOptimizer();
  const byCapability: Record<string, { baseline: ArmAggregate; bandit: ArmAggregate; winner: string }> = {};
  const trueBest: Record<string, string> = {};

  for (const cap of ALL_CAPS) {
    const baseline = newAggregate();
    const banditAgg = newAggregate();
    const capTrue = trueMeans.get(cap)!;
    const oracle = Math.max(
      ...capTrue.map((p) => computeReward(p.true_quality, p.true_latency_ms, p.price)),
    );
    trueBest[cap] = capTrue.find(
      (p) => computeReward(p.true_quality, p.true_latency_ms, p.price) === oracle,
    )!.provider_id;

    for (let r = 0; r < ROUNDS; r++) {
      // Baseline: static weighted score on the catalog claims (never learns).
      const basePick = pickProvider(cap, DEFAULT_WEIGHTS).provider;
      const baseOut = outcomes.get(`${basePick.provider_id}:${cap}`)![r];
      recordPick(baseline, basePick.provider_id, basePick.price);
      baseline.reward_sum += computeReward(baseOut.quality, baseOut.latency_ms, basePick.price);
      baseline.quality_sum += baseOut.quality;
      baseline.latency_sum += baseOut.latency_ms;
      const baseTrue = capTrue.find((p) => p.provider_id === basePick.provider_id)!;
      baseline.regret += oracle - computeReward(baseTrue.true_quality, baseTrue.true_latency_ms, baseTrue.price);

      // Bandit: UCB1 pick, learns from the realized outcome.
      const bbPick = bandit.pick(cap)!;
      const bbOut = outcomes.get(`${bbPick.provider.provider_id}:${cap}`)![r];
      recordPick(banditAgg, bbPick.provider.provider_id, bbPick.provider.price);
      banditAgg.reward_sum += computeReward(bbOut.quality, bbOut.latency_ms, bbPick.provider.price);
      banditAgg.quality_sum += bbOut.quality;
      banditAgg.latency_sum += bbOut.latency_ms;
      bandit.updateArm(cap, bbPick.provider.provider_id, bbOut.quality, bbOut.latency_ms, bbPick.provider.price, true);
      const bbTrue = capTrue.find((p) => p.provider_id === bbPick.provider.provider_id)!;
      banditAgg.regret += oracle - computeReward(bbTrue.true_quality, bbTrue.true_latency_ms, bbTrue.price);
    }

    const eps = 1e-6;
    const winner =
      Math.abs(baseline.reward_sum - banditAgg.reward_sum) < eps
        ? "tie"
        : banditAgg.reward_sum > baseline.reward_sum
          ? "bandit"
          : "baseline";
    byCapability[cap] = { baseline, bandit: banditAgg, winner };
  }

  const totals = { baseline: newAggregate(), bandit: newAggregate() };
  for (const cap of ALL_CAPS) {
    for (const arm of ["baseline", "bandit"] as const) {
      const agg = byCapability[cap][arm];
      totals[arm].total_cost += agg.total_cost;
      totals[arm].reward_sum += agg.reward_sum;
      totals[arm].regret += agg.regret;
      totals[arm].quality_sum += agg.quality_sum;
      totals[arm].latency_sum += agg.latency_sum;
      totals[arm].n += agg.n;
    }
  }

  return {
    byCapability,
    totals,
    learned: bandit.getStats() as unknown as Record<string, Record<string, unknown>>,
    trueBest,
  };
}

function mean(n: number, agg: ArmAggregate): number {
  return n / Math.max(1, agg.n);
}

function printScenario(
  scenario: Scenario,
  res: ReturnType<typeof evaluateScenario>,
): void {
  const LINE = "─".repeat(78);
  console.log(`\n${LINE}`);
  console.log(`SCENARIO: ${scenario.name}`);
  console.log(`  ${scenario.description}`);

  console.log(
    `\n  ${"capability".padEnd(11)}${"arm".padEnd(8)}${"picks".padEnd(30)}${"reward".padEnd(9)}${"cost".padEnd(9)}${"qual".padEnd(7)}${"lat".padEnd(9)}winner`,
  );
  for (const cap of ALL_CAPS) {
    const c = res.byCapability[cap];
    for (const arm of ["baseline", "bandit"] as const) {
      const a = c[arm];
      const picks = Object.entries(a.picks)
        .map(([pid, n]) => `${pid}=${n}`)
        .join(", ");
      console.log(
        `  ${cap.padEnd(11)}${arm.padEnd(8)}${picks.padEnd(30)}` +
          `${a.reward_sum.toFixed(1).padEnd(9)}` +
          `${a.total_cost.toFixed(2).padEnd(9)}` +
          `${mean(a.quality_sum, a).toFixed(2).padEnd(7)}` +
          `${Math.round(mean(a.latency_sum, a)).toString().padEnd(9)}` +
          `${arm === c.winner ? "✓" : ""}`,
      );
    }
    console.log(`  ${"".padEnd(11)}${"".padEnd(8)}true-best=${res.trueBest[cap]}`);
  }
  const t = res.totals;
  const win = t.bandit.reward_sum > t.baseline.reward_sum;
  console.log(
    `\n  TOTALS: baseline reward=${t.baseline.reward_sum.toFixed(1)} (cost ${t.baseline.total_cost.toFixed(2)})  ` +
      `bandit reward=${t.bandit.reward_sum.toFixed(1)} (cost ${t.bandit.total_cost.toFixed(2)})`,
  );
  console.log(
    `  REGRET: baseline=${t.baseline.regret.toFixed(1)}  bandit=${t.bandit.regret.toFixed(1)}` +
      `  (delivered-reward verdict: ${win ? "bandit" : "baseline"} wins)`,
  );
}

function printLearning(res: ReturnType<typeof evaluateScenario>): void {
  console.log(`\n  learned mean_reward vs true-best (proof the bandit converged):`);
  for (const cap of ALL_CAPS) {
    const arms = Object.entries(res.learned[cap] ?? {});
    const learnedBest = arms.sort((a, b) =>
      (b[1] as { mean_reward: number }).mean_reward - (a[1] as { mean_reward: number }).mean_reward,
    )[0]?.[0];
    const ok = learnedBest === res.trueBest[cap];
    console.log(
      `    ${cap.padEnd(10)}learned-best=${learnedBest}  true-best=${res.trueBest[cap]}  ${ok ? "✓ converged" : "✗ did NOT converge"}`,
    );
  }
}

async function main(): Promise<void> {
  console.log("=== PHASE 5 — UCB1 bandit vs static baseline (held-out eval) ===");
  const scenarios: unknown[] = [];
  SCENARIOS.forEach((scenario, i) => {
    const res = evaluateScenario(scenario, 1000 + i * 17);
    printScenario(scenario, res);
    if (scenario.name.startsWith("adversarial")) printLearning(res);
    scenarios.push({
      name: scenario.name,
      description: scenario.description,
      rounds: ROUNDS,
      by_capability: res.byCapability,
      totals: res.totals,
      learned: res.learned,
      true_best: res.trueBest,
    });
  });

  const report = {
    schema: "bandit-eval/v2",
    generated_at: new Date().toISOString(),
    rounds: ROUNDS,
    notes:
      "Held-out simulation over the real provider catalog with seeded noise and common random numbers " +
      "(both arms observe identical per-round outcomes). Headline metric is cumulative delivered reward; " +
      "regret vs the per-capability oracle is secondary. The control scenario (truthful catalog) verifies " +
      "the bandit does not win when there is nothing to learn.",
    scenarios,
  };
  const outPath = join(process.cwd(), "data", "bandit-report.json");
  await mkdir(join(process.cwd(), "data"), { recursive: true });
  await writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`\nreport written to ${outPath} (served by the dashboard at /api/bandit-report)`);
}

main().catch((err) => {
  console.error("bandit-eval failed:", err);
  process.exitCode = 1;
});

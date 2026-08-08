import { readFileSync } from "node:fs";
import type { AppConfig } from "@sentinel/config";
import {
  ProviderCatalogFileEntrySchema,
  microAlgo,
  z,
  type ProviderAdapter,
  type ProviderCatalogFileEntry,
} from "@sentinel/schemas";
import { LLMCreditScoreProvider, LLMSummaryProvider } from "./providers/llm.js";
import { MockProvider } from "./providers/mock.js";
import { ZerionWalletDataProvider } from "./providers/zerion.js";

/**
 * Data-driven provider catalog.
 *
 * data/catalog.json is the single source of truth for the registry (WS-A).
 * The file holds ProviderCatalogFileEntry shapes: money as decimal strings
 * (JSON has no bigint), base_url canonical at the default :4020 port (the
 * loader rewrites it to the config's providers port so dev/staging/test can
 * re-home the whole catalog with one knob), and the static kind/mode/scheme/
 * role metadata. The runtime fail-mode knob is NOT in the file — it is set via
 * POST /providers/:id/fail-mode and held in memory.
 *
 * The file is untrusted external input — every entry is validated with
 * ProviderCatalogFileEntrySchema (.strict()) at boot, and boot FAILS FAST
 * listing every parse issue rather than skipping bad entries.
 */

function rewritePort(baseUrl: string, port: number): string {
  const url = new URL(baseUrl);
  url.port = String(port);
  return url.toString();
}

/**
 * Load + validate the catalog file. Throws with every parse issue on invalid
 * data so a malformed catalog fails the service at boot, not at first run.
 * The relative URL is identical from src/ (dev) and dist/ (build) because both
 * sit one level below apps/service-providers, where data/catalog.json lives.
 */
export function loadCatalogFile(): ProviderCatalogFileEntry[] {
  const url = new URL("../data/catalog.json", import.meta.url);
  let raw: string;
  try {
    raw = readFileSync(url, "utf8");
  } catch (cause) {
    throw new Error(
      `[catalog] failed to read ${url.href}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const parsed: unknown = JSON.parse(raw);
  const checked = z.array(ProviderCatalogFileEntrySchema).safeParse(parsed);
  if (!checked.success) {
    const issues = checked.error.issues
      .map(
        (issue) =>
          `  - [${issue.path.length > 0 ? issue.path.join(".") : "root"}]: ${issue.message}`,
      )
      .join("\n");
    throw new Error(`[catalog] invalid data/catalog.json:\n${issues}`);
  }
  return checked.data;
}

/**
 * Convert catalog file entries into live ProviderAdapters. Mock/adversarial
 * entries become in-process MockProviders (the same class the factories export,
 * so existing behavior — including resultFor over all 7 capabilities — is
 * preserved); zerion / llm-summary / llm-credit become the real adapters with
 * the entry's metadata as constructor overrides and a surfaceBaseUrl pointing
 * at this service's /mock/{provider_id} routes. When the real API keys are
 * absent the real adapters fail gracefully at quote() and the router falls
 * back to the mock tiers (documented behavior — keep it).
 */
export function loadCatalog(config: AppConfig): ProviderAdapter[] {
  return loadCatalogFile().map((entry) => {
    const baseUrl = rewritePort(entry.base_url, config.ports.providers);
    const priceHint = microAlgo(BigInt(entry.price_micro_algo));

    switch (entry.kind) {
      case "mock":
      case "adversarial":
        return new MockProvider({
          providerId: entry.provider_id,
          capability: entry.capability,
          priceHint,
          latencyHintMs: entry.latency_hint_ms,
          qualityScore: entry.quality_score,
          mode: entry.mode ?? "normal",
          baseUrl,
          ...(entry.role !== undefined ? { role: entry.role } : {}),
          ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
          ...(entry.failMode !== undefined ? { failMode: entry.failMode } : {}),
          ...(entry.scheme !== undefined ? { scheme: entry.scheme } : {}),
          ...(entry.uptoActual !== undefined
            ? { uptoActual: microAlgo(BigInt(entry.uptoActual)) }
            : {}),
          ...(entry.priceDriftPct !== undefined ? { priceDriftPct: entry.priceDriftPct } : {}),
          ...(entry.network !== undefined ? { network: entry.network } : {}),
        });

      case "zerion":
        return new ZerionWalletDataProvider({
          ...(config.zerionApiKey !== undefined ? { apiKey: config.zerionApiKey } : {}),
          surfaceBaseUrl: baseUrl,
          providerId: entry.provider_id,
          priceHint,
          latencyHintMs: entry.latency_hint_ms,
          qualityScore: entry.quality_score,
        });

      case "llm-summary":
        return new LLMSummaryProvider({
          baseUrl: config.llm.baseUrl,
          apiKey: config.llm.apiKey,
          model: config.llm.model,
          surfaceBaseUrl: baseUrl,
          providerId: entry.provider_id,
          priceHint,
          latencyHintMs: entry.latency_hint_ms,
          qualityScore: entry.quality_score,
        });

      case "llm-credit":
        return new LLMCreditScoreProvider({
          baseUrl: config.llm.baseUrl,
          apiKey: config.llm.apiKey,
          model: config.llm.model,
          surfaceBaseUrl: baseUrl,
          providerId: entry.provider_id,
          priceHint,
          latencyHintMs: entry.latency_hint_ms,
          qualityScore: entry.quality_score,
        });

      default:
        throw new Error(
          `[catalog] unsupported provider kind "${String(entry.kind)}" for "${entry.provider_id}"`,
        );
    }
  });
}

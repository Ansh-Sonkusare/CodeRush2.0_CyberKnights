import {
  err,
  microAlgo,
  type Capability,
  type DeliverResponse,
  type MicroAlgo,
  type ProviderAdapter,
  type ProviderError,
  type QuoteResponse,
  type Result,
} from "@sentinel/schemas";

export interface LLMAdapterConfig {
  readonly baseUrl: string | undefined;
  readonly apiKey: string | undefined;
  readonly model: string | undefined;
}

function notImplemented(providerId: string, model: string | undefined): ProviderError {
  return {
    kind: "unknown",
    message: `provider "${providerId}" is a placeholder${
      model ? ` (model "${model}")` : ""
    } — the LLM integration is not wired yet`,
  };
}

const BASE_URL_DEFAULT = "https://generativelanguage.googleapis.com";

/**
 * Placeholder adapters for the AI summary / credit-score services (MIGRATION
 * Phase 7). They implement ProviderAdapter so the registry/catalog/router work
 * against a stable contract; the real LLM integration (packages/llm-client)
 * lands in a later phase. quote()/deliver() fail cleanly, health() reports up.
 */
abstract class LLMProviderPlaceholder implements ProviderAdapter {
  abstract readonly providerId: string;
  abstract readonly capability: Capability;
  abstract readonly priceHint: MicroAlgo;
  abstract readonly latencyHintMs: number;
  abstract readonly qualityScore: number;
  readonly baseUrl: string;
  readonly role: "primary" = "primary";
  protected readonly apiKey: string | undefined;
  protected readonly model: string | undefined;

  constructor(config: LLMAdapterConfig) {
    this.baseUrl = config.baseUrl ?? BASE_URL_DEFAULT;
    this.apiKey = config.apiKey;
    this.model = config.model;
  }

  async quote(_goal: string): Promise<Result<QuoteResponse, ProviderError>> {
    return err(notImplemented(this.providerId, this.model));
  }

  async deliver(
    _invoiceId: string,
    _paymentRef: string,
    _input?: Record<string, unknown>,
  ): Promise<Result<DeliverResponse, ProviderError>> {
    return err(notImplemented(this.providerId, this.model));
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    const detail = [
      "placeholder — not yet connected to the LLM",
      this.model ? `model "${this.model}"` : "no model configured",
      this.apiKey ? "API key configured" : "no API key configured",
    ].join("; ");
    return { ok: true, detail };
  }
}

export class LLMSummaryProvider extends LLMProviderPlaceholder {
  readonly providerId = "llm-summary";
  readonly capability: Capability = "generate_summary";
  readonly priceHint = microAlgo(3n);
  readonly latencyHintMs = 900;
  readonly qualityScore = 0.9;
}

export class LLMCreditScoreProvider extends LLMProviderPlaceholder {
  readonly providerId = "llm-credit-score";
  readonly capability: Capability = "score_credit";
  readonly priceHint = microAlgo(4n);
  readonly latencyHintMs = 700;
  readonly qualityScore = 0.85;
}

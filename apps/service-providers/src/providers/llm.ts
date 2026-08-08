import { randomUUID } from "node:crypto";
import type { LLMConfig, LLMProvider } from "@sentinel/config";
import { createLLMClient, type LLMClient } from "@sentinel/llm-client";
import {
  CreditScoreResponseSchema,
  SummaryResponseSchema,
  err,
  microAlgo,
  ok,
  z,
  type Capability,
  type DeliverResponse,
  type MicroAlgo,
  type ProviderAdapter,
  type ProviderError,
  type QuoteResponse,
  type Result,
} from "@sentinel/schemas";

/**
 * Real LLM adapters for `generate_summary` and `score_credit`.
 *
 * Mirrors MockProvider's wire contract exactly (see providers/mock.ts): quote()
 * produces a microAlgo invoice, deliver() produces a guard-valid result +
 * a receipt whose tx_ref echoes the payment, health() reports { ok, detail }.
 *
 * The LLM call goes through @sentinel/llm-client (the one place an LLM vendor
 * SDK is imported in this repo) with a strict zod schema constraining the
 * structured output — the same schema the policy guard will validate against.
 * All LLM calls are provider-agnostic behind the shared client.
 *
 * deliver()'s input is the assembled upstream node results (keyed by node id,
 * e.g. input["n-wallet"] for the wallet node's result). The summary adapter
 * reads the wallet node's result; the credit adapter reads the summary node's
 * result. Node ids are treated as opaque — results are located by shape so the
 * adapters work with planner-generated graphs, not just the fallback graph.
 */

export interface LLMAdapterConfig {
  /** Upstream LLM API base URL (e.g. Groq /v1, Gemini, or Ollama). */
  readonly baseUrl: string | undefined;
  /** API key for the LLM backend. */
  readonly apiKey: string | undefined;
  /** Model name. */
  readonly model: string | undefined;
  /** Explicit backend; inferred from the other fields when absent. */
  readonly provider?: LLMProvider;
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** Catalog HTTP surface for this provider (quote/deliver/health routes). */
  readonly surfaceBaseUrl?: string;
}

const DEFAULT_PROVIDERS_PORT = 4020;
const TERMS_TTL_MS = 60_000;

function toLLMConfig(config: LLMAdapterConfig): LLMConfig {
  const provider: LLMProvider =
    config.provider ??
    (config.baseUrl !== undefined
      ? "openai-compatible"
      : config.model?.toLowerCase().includes("gemini")
        ? "gemini"
        : config.apiKey?.startsWith("gsk_")
          ? "openai-compatible"
          : config.apiKey !== undefined
            ? "gemini"
            : "ollama");

  return {
    provider,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** First upstream result carrying a wallet_address (any node id). */
function findWalletData(
  input: Record<string, unknown>,
): { wallet_address?: unknown; portfolio_value_usd?: unknown } | undefined {
  for (const value of Object.values(input)) {
    if (isRecord(value) && typeof value.wallet_address === "string") {
      return value as { wallet_address?: unknown; portfolio_value_usd?: unknown };
    }
  }
  return undefined;
}

/** First upstream result carrying a summary string (any node id). */
function findSummary(
  input: Record<string, unknown>,
): { summary?: unknown } | undefined {
  for (const value of Object.values(input)) {
    if (isRecord(value) && typeof value.summary === "string") {
      return value as { summary?: unknown };
    }
  }
  return undefined;
}

export abstract class LLMProviderBase implements ProviderAdapter {
  abstract readonly providerId: string;
  abstract readonly capability: Capability;
  abstract readonly priceHint: MicroAlgo;
  abstract readonly latencyHintMs: number;
  abstract readonly qualityScore: number;
  protected abstract readonly schema: z.ZodTypeAny;
  readonly role: "primary" = "primary";
  readonly integration: "mock" = "mock";

  private readonly llmConfig: LLMConfig;
  private readonly surfaceBaseUrl: string | undefined;
  private client: LLMClient | undefined;
  private clientError: string | undefined;

  constructor(config: LLMAdapterConfig) {
    this.llmConfig = toLLMConfig(config);
    this.surfaceBaseUrl = config.surfaceBaseUrl;
  }

  get baseUrl(): string {
    return (
      this.surfaceBaseUrl ??
      `http://127.0.0.1:${DEFAULT_PROVIDERS_PORT}/mock/${this.providerId}`
    );
  }

  async quote(_goal: string): Promise<Result<QuoteResponse, ProviderError>> {
    const client = this.getClient();
    if (!client.ok) {
      return err({
        kind: "capability_unsupported",
        message: client.error,
        providerUrl: this.baseUrl,
      });
    }

    return ok({
      invoice_id: `inv-${this.providerId}-${randomUUID().slice(0, 8)}`,
      provider_id: this.providerId,
      capability: this.capability,
      price: Number(this.priceHint),
      currency: "microAlgo",
      schema: this.capability,
      terms_expires_at: new Date(Date.now() + TERMS_TTL_MS).toISOString(),
      payment_required: true,
    });
  }

  async deliver(
    invoiceId: string,
    paymentRef: string,
    input?: Record<string, unknown>,
  ): Promise<Result<DeliverResponse, ProviderError>> {
    const client = this.getClient();
    if (!client.ok) {
      return err({
        kind: "capability_unsupported",
        message: client.error,
        providerUrl: this.baseUrl,
      });
    }

    const generated = await client.value.generate(
      this.buildPrompt(input ?? {}),
      this.schema,
    );
    if (!generated.ok) {
      return err({
        kind: "deliver_failed",
        message: `${this.providerId}: ${generated.error.message}`,
        providerUrl: this.baseUrl,
      });
    }

    const output = generated.value;
    if (!isRecord(output)) {
      return err({
        kind: "deliver_failed",
        message: `${this.providerId}: LLM returned non-object output`,
        providerUrl: this.baseUrl,
      });
    }

    return ok({
      result: this.pinWalletAddress(output, input ?? {}),
      receipt: {
        receipt_id: `rcpt-${invoiceId}`,
        tx_ref: paymentRef,
        provider_id: this.providerId,
        settled_at: new Date().toISOString(),
        already_settled: false,
      },
    });
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    const client = this.getClient();
    if (!client.ok) {
      return { ok: false, detail: `${this.providerId}: ${client.error}` };
    }
    return {
      ok: true,
      detail: `${this.providerId} (real LLM — ${client.value.provider}/${client.value.model})`,
    };
  }

  protected abstract buildPrompt(input: Record<string, unknown>): string;

  /** Keep wallet_address consistent with the wallet data upstream produced. */
  private pinWalletAddress(
    result: Record<string, unknown>,
    input: Record<string, unknown>,
  ): Record<string, unknown> {
    const wallet = findWalletData(input);
    if (wallet && typeof wallet.wallet_address === "string") {
      return { ...result, wallet_address: wallet.wallet_address };
    }
    return result;
  }

  private getClient(): Result<LLMClient, string> {
    if (this.client) return ok(this.client);
    if (this.clientError !== undefined) return err(this.clientError);
    try {
      this.client = createLLMClient(this.llmConfig);
      return ok(this.client);
    } catch (cause) {
      this.clientError = cause instanceof Error ? cause.message : String(cause);
      return err(this.clientError);
    }
  }
}

export class LLMSummaryProvider extends LLMProviderBase {
  readonly providerId = "llm-summary";
  readonly capability: Capability = "generate_summary";
  readonly priceHint: MicroAlgo = microAlgo(1n);
  readonly latencyHintMs = 500;
  readonly qualityScore = 0.96;
  protected readonly schema = SummaryResponseSchema;

  protected buildPrompt(input: Record<string, unknown>): string {
    const wallet = findWalletData(input);
    const address =
      typeof wallet?.wallet_address === "string" ? wallet.wallet_address : "unknown";
    const portfolio =
      typeof wallet?.portfolio_value_usd === "string"
        ? wallet.portfolio_value_usd
        : "unknown";

    return [
      "You are a wallet activity summarizer for a policy-driven agent payment router.",
      "",
      `Wallet address: ${address}`,
      `Portfolio value (USD): ${portfolio}`,
      "",
      'Respond with a single JSON object, exactly: {"wallet_address": string, "summary": string, "signals": string[]}',
      "- wallet_address: exactly the wallet address above",
      "- summary: plain-English activity summary, max 1500 characters",
      "- signals: up to 20 short evidence strings derived from the wallet data",
    ].join("\n");
  }
}

export class LLMCreditScoreProvider extends LLMProviderBase {
  readonly providerId = "llm-credit-score";
  readonly capability: Capability = "score_credit";
  readonly priceHint: MicroAlgo = microAlgo(2n);
  readonly latencyHintMs = 500;
  readonly qualityScore = 0.96;
  protected readonly schema = CreditScoreResponseSchema;

  protected buildPrompt(input: Record<string, unknown>): string {
    const wallet = findWalletData(input);
    const summary = findSummary(input);
    const address =
      typeof wallet?.wallet_address === "string" ? wallet.wallet_address : "unknown";
    const summaryText =
      typeof summary?.summary === "string" ? summary.summary : "(no summary available)";

    return [
      "You are an on-chain credit scorer for a policy-driven agent payment router.",
      "",
      `Wallet address: ${address}`,
      `Activity summary: ${summaryText}`,
      "",
      'Respond with a single JSON object, exactly: {"wallet_address": string, "score": number, "rationale": string}',
      "- wallet_address: exactly the wallet address above",
      "- score: integer 0..100 (higher = more creditworthy), based on the activity summary",
      "- rationale: concise explanation, max 800 characters",
    ].join("\n");
  }
}

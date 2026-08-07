import {
  err,
  microAlgo,
  type Capability,
  type DeliverResponse,
  type ProviderAdapter,
  type ProviderError,
  type QuoteResponse,
  type Result,
} from "@sentinel/schemas";

export interface ZerionAdapterConfig {
  /** Zerion API base URL (v1). Defaults to the public Zerion endpoint. */
  readonly baseUrl: string | undefined;
  /** Bearer token for the Zerion API — held for later wiring, never logged. */
  readonly apiKey: string | undefined;
}

const NOT_IMPLEMENTED: ProviderError = {
  kind: "unknown",
  message:
    'provider "zerion-wallet-data" is a placeholder — the Zerion integration is not wired yet',
};

/**
 * Placeholder for the real Zerion wallet-data adapter (MIGRATION Phase 7).
 *
 * The Zerion API (wallet / portfolio / transaction endpoints) is wired in a
 * later phase behind an x402-payable resource server. Until then this stub
 * keeps the registry, catalog, and /health skeleton live so the service and
 * gateway can be developed against a stable contract: quote()/deliver() fail
 * cleanly, health() reports the service itself is up.
 */
export class ZerionWalletDataProvider implements ProviderAdapter {
  readonly providerId = "zerion-wallet-data";
  readonly capability: Capability = "fetch_wallet_data";
  readonly priceHint = microAlgo(5n);
  readonly latencyHintMs = 350;
  readonly qualityScore = 0.95;
  readonly baseUrl: string;
  readonly role: "primary" = "primary";
  private readonly apiKey: string | undefined;

  constructor(config: ZerionAdapterConfig) {
    this.baseUrl = config.baseUrl ?? "https://api.zerion.io/v1";
    this.apiKey = config.apiKey;
  }

  async quote(_goal: string): Promise<Result<QuoteResponse, ProviderError>> {
    return err(NOT_IMPLEMENTED);
  }

  async deliver(
    _invoiceId: string,
    _paymentRef: string,
    _input?: Record<string, unknown>,
  ): Promise<Result<DeliverResponse, ProviderError>> {
    return err(NOT_IMPLEMENTED);
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    const detail = this.apiKey
      ? "placeholder — API key configured, Zerion integration not wired yet"
      : "placeholder — set ZERION_API_KEY to prepare the integration";
    return { ok: true, detail };
  }
}

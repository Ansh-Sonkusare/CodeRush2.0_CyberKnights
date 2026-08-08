import { randomUUID } from "node:crypto";
import {
  err,
  microAlgo,
  ok,
  type Capability,
  type DeliverResponse,
  type MicroAlgo,
  type ProviderAdapter,
  type ProviderError,
  type QuoteResponse,
  type Result,
} from "@sentinel/schemas";

/**
 * Real Zerion wallet-data provider (capability `fetch_wallet_data`).
 *
 * Mirrors MockProvider's wire contract exactly: quote() produces a microAlgo
 * invoice with the canonical fields (invoice_id, provider_id, capability,
 * price, currency, schema, terms_expires_at, payment_required), deliver()
 * produces a guard-valid result + a receipt whose tx_ref echoes the payment.
 *
 * Zerion serves EVM and Solana wallets only (Algorand is not supported) — the
 * goal is the input source of the wallet address, parsed at quote() time and
 * held per-invoice for deliver(). An Algorand address (or no address) in the
 * goal fails quote() so the node machine falls back to the mock adapter.
 *
 * The result is normalized to WalletDataResponseSchema
 * ({ wallet_address, portfolio_value_usd, fetched_at }) before it reaches the
 * policy guard — the guard's strict parse is what makes any extra field
 * structurally unrepresentable.
 */

export interface ZerionAdapterConfig {
  /** Catalog HTTP surface for this provider (quote/deliver/health routes). */
  readonly baseUrl?: string;
  /** Zerion v1 API base URL. Defaults to the public Zerion endpoint. */
  readonly upstreamBaseUrl?: string;
  /** Zerion API key — used as HTTP Basic username, never logged. */
  readonly apiKey?: string;
  /** Injectable fetch implementation (testability). */
  readonly fetchFn?: typeof fetch;
}

const ZERION_API_BASE = "https://api.zerion.io/v1";
const DEFAULT_PROVIDERS_PORT = 4020;
const TERMS_TTL_MS = 60_000;
const ZERION_TIMEOUT_MS = 15_000;

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ALGORAND_ADDRESS_RE = /^[A-Z2-7]{58}$/;
const TRIM_NON_WORD = /^[^\w]+|[^\w]+$/g;

type AddressParse =
  | { ok: true; value: string }
  | { ok: false; message: string };

/** Extract an EVM (0x…) or Solana (base58) address from the goal text. */
function parseWalletAddress(goal: string): AddressParse {
  const tokens = goal
    .split(/[\s,;:]+/)
    .map((t) => t.replace(TRIM_NON_WORD, ""))
    .filter((t) => t.length > 0);

  for (const token of tokens) {
    if (EVM_ADDRESS_RE.test(token)) return { ok: true, value: token.toLowerCase() };
  }
  for (const token of tokens) {
    if (SOLANA_ADDRESS_RE.test(token)) return { ok: true, value: token };
  }
  for (const token of tokens) {
    if (ALGORAND_ADDRESS_RE.test(token)) {
      return {
        ok: false,
        message:
          `Algorand address "${token}" is not supported — Zerion serves EVM/Solana wallets only; ` +
          "provide an EVM (0x…) or Solana address in the goal",
      };
    }
  }
  return { ok: false, message: `no EVM or Solana wallet address found in goal: "${goal}"` };
}

function basicAuthHeader(apiKey: string): string {
  const encoded = Buffer.from(`${apiKey}:`, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

/** Zerion portfolio response → data.attributes.total.positions (USD). */
function extractTotalValue(body: unknown): number | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const data = (body as { data?: unknown }).data;
  if (data === null || typeof data !== "object") return undefined;
  const attributes = (data as { attributes?: unknown }).attributes;
  if (attributes === null || typeof attributes !== "object") return undefined;
  const total = (attributes as { total?: unknown }).total;
  if (total === null || typeof total !== "object") return undefined;
  const positions = (total as { positions?: unknown }).positions;
  return typeof positions === "number" ? positions : undefined;
}

export class ZerionWalletDataProvider implements ProviderAdapter {
  readonly providerId = "zerion-wallet-data";
  readonly capability: Capability = "fetch_wallet_data";
  readonly priceHint: MicroAlgo = microAlgo(3n);
  readonly latencyHintMs = 100;
  readonly qualityScore = 0.98;
  readonly role: "primary" = "primary";
  readonly baseUrl: string;

  private readonly upstreamBaseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly invoiceAddresses = new Map<string, string>();

  constructor(config: ZerionAdapterConfig = {}) {
    this.upstreamBaseUrl = config.upstreamBaseUrl ?? ZERION_API_BASE;
    this.apiKey = config.apiKey;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
    this.baseUrl =
      config.baseUrl ??
      `http://127.0.0.1:${DEFAULT_PROVIDERS_PORT}/mock/${this.providerId}`;
  }

  async quote(goal: string): Promise<Result<QuoteResponse, ProviderError>> {
    const parsed = parseWalletAddress(goal);
    if (!parsed.ok) {
      return err({
        kind: "capability_unsupported",
        message: parsed.message,
        providerUrl: this.baseUrl,
      });
    }

    const invoiceId = `inv-${this.providerId}-${randomUUID().slice(0, 8)}`;
    this.invoiceAddresses.set(invoiceId, parsed.value);

    return ok({
      invoice_id: invoiceId,
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
    _input?: Record<string, unknown>,
  ): Promise<Result<DeliverResponse, ProviderError>> {
    const address = this.invoiceAddresses.get(invoiceId);
    if (!address) {
      return err({
        kind: "unknown",
        message: `no wallet address quoted for invoice "${invoiceId}"`,
        providerUrl: this.baseUrl,
      });
    }

    const total = await this.fetchPortfolioValue(address);
    if (!total.ok) return total;

    return ok({
      result: {
        wallet_address: address,
        portfolio_value_usd: total.value,
        fetched_at: new Date().toISOString(),
      },
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
    return { ok: true, detail: "zerion-wallet-data (real Zerion API)" };
  }

  private async fetchPortfolioValue(
    address: string,
  ): Promise<Result<string, ProviderError>> {
    const url = `${this.upstreamBaseUrl}/wallets/${address}/portfolio?currency=usd&filter[positions]=only_simple`;

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        headers: {
          authorization: basicAuthHeader(this.apiKey ?? ""),
          accept: "application/json",
        },
        signal: AbortSignal.timeout(ZERION_TIMEOUT_MS),
      });
    } catch (cause) {
      return err({
        kind: "timeout",
        message: `Zerion API unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
        providerUrl: this.upstreamBaseUrl,
      });
    }

    if (!res.ok) {
      return err({
        kind: "deliver_failed",
        message: `Zerion API returned HTTP ${res.status} for wallet ${address}`,
        providerUrl: this.upstreamBaseUrl,
      });
    }

    const total = extractTotalValue(await res.json());
    if (typeof total !== "number" || !Number.isFinite(total)) {
      return err({
        kind: "unknown",
        message: "Zerion portfolio response is missing a numeric total value",
        providerUrl: this.upstreamBaseUrl,
      });
    }

    return ok((Math.round(total * 100) / 100).toFixed(2));
  }
}

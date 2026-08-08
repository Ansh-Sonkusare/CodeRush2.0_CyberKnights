import { randomUUID } from "node:crypto";
import {
  QuoteResponseSchema,
  err,
  microAlgo,
  type Capability,
  type DeliverResponse,
  type MicroAlgo,
  type ProviderAdapter,
  type ProviderCatalogEntry,
  type ProviderError,
  type ProviderFailMode,
  type ProviderKind,
  type ProviderMode,
  type QuoteResponse,
  type Result,
} from "@sentinel/schemas";
import {
  decodePaymentRequiredHeader,
  type X402Client,
} from "@sentinel/x402-client";

/**
 * Adapter for a REAL x402 resource server.
 *
 * Unlike RemoteProviderAdapter (which proxies a /quote + /deliver + /health
 * wire contract), this adapter points `base_url` directly at a pay-per-request
 * x402 resource. The payment + content delivery happen in ONE request:
 *
 *   - quote()      plain GET → the server answers 402 with a Payment-Required
 *                  header (the invoice/terms). We surface the resource metadata
 *                  as a QuoteResponse; the treasury budget is driven by the
 *                  catalog priceHint, while the actual spend settles on-chain
 *                  in USDC through the x402 facilitator.
 *   - pay()        the orchestrator's x402 client performs the paid fetch; the
 *                  response body IS the deliverable and is cached in the client
 *                  keyed by invoice id.
 *   - deliver()    reads the paid content back out of the x402 client — NO
 *                  second request, so nothing can be double-charged.
 *
 * Quote/deliver failures are typed ProviderErrors exactly like every other
 * adapter, so the router/treasury/guard never special-case this provider.
 */
export class X402ProviderAdapter implements ProviderAdapter {
  readonly providerId: string;
  readonly capability: Capability;
  readonly priceHint: MicroAlgo;
  readonly latencyHintMs: number;
  readonly qualityScore: number;
  readonly baseUrl: string;
  readonly role: "primary" | "backup";
  readonly integration = "x402" as const;
  readonly kind?: ProviderKind;
  readonly mode?: ProviderMode;
  readonly failMode?: ProviderFailMode;
  readonly scheme?: "exact" | "upto";
  readonly uptoActual?: MicroAlgo;
  readonly priceDriftPct?: number;
  readonly network?: string;

  constructor(
    entry: ProviderCatalogEntry,
    private readonly x402?: X402Client,
  ) {
    this.providerId = entry.provider_id;
    this.capability = entry.capability;
    this.priceHint = microAlgo(entry.price_micro_algo);
    this.latencyHintMs = entry.latency_hint_ms;
    this.qualityScore = entry.quality_score;
    this.baseUrl = entry.base_url;
    this.role = entry.role ?? "primary";
    if (entry.kind !== undefined) this.kind = entry.kind;
    if (entry.mode !== undefined) this.mode = entry.mode;
    if (entry.failMode !== undefined) this.failMode = entry.failMode;
    if (entry.scheme !== undefined) this.scheme = entry.scheme;
    if (entry.uptoActual !== undefined) this.uptoActual = microAlgo(entry.uptoActual);
    if (entry.priceDriftPct !== undefined) this.priceDriftPct = entry.priceDriftPct;
    if (entry.network !== undefined) this.network = entry.network;
  }

  async quote(_goal: string): Promise<Result<QuoteResponse, ProviderError>> {
    try {
      const res = await fetch(this.baseUrl);
      const header =
        res.headers.get("payment-required") ??
        res.headers.get("Payment-Required") ??
        res.headers.get("payment_required");
      if (!header) {
        return err({
          kind: "invoice_failed",
          message: `"${this.providerId}" did not issue a Payment-Required challenge (HTTP ${res.status})`,
          providerUrl: this.baseUrl,
        });
      }
      let paymentRequired: ReturnType<typeof decodePaymentRequiredHeader>;
      try {
        paymentRequired = decodePaymentRequiredHeader(header);
      } catch {
        return err({
          kind: "invoice_failed",
          message: `"${this.providerId}" returned an unparseable Payment-Required header`,
          providerUrl: this.baseUrl,
        });
      }
      const accepts = paymentRequired.accepts[0];
      if (!accepts) {
        return err({
          kind: "invoice_failed",
          message: `"${this.providerId}" advertised no payment options`,
          providerUrl: this.baseUrl,
        });
      }
      const maxTimeoutSeconds = accepts.maxTimeoutSeconds ?? 60;
      const quote: QuoteResponse = {
        invoice_id: `inv-${this.providerId}-${randomUUID().slice(0, 8)}`,
        provider_id: this.providerId,
        capability: this.capability,
        // Budget hint in microAlgo — the on-chain USDC amount is set by the
        // resource server and settled via x402; the ledger tracks the budget.
        price: Number(this.priceHint),
        currency: "microAlgo",
        schema: this.capability,
        terms_expires_at: new Date(Date.now() + maxTimeoutSeconds * 1000).toISOString(),
        payment_required: true,
      };
      const checked = QuoteResponseSchema.safeParse(quote);
      if (!checked.success) {
        return err({
          kind: "invoice_failed",
          message: `"${this.providerId}" produced an invalid quote`,
          providerUrl: this.baseUrl,
        });
      }
      return { ok: true, value: checked.data };
    } catch (cause) {
      return err({
        kind: "timeout",
        message: `quote failed for "${this.providerId}": ${(cause as Error).message}`,
        providerUrl: this.baseUrl,
      });
    }
  }

  async deliver(
    invoiceId: string,
    paymentRef: string,
    _input?: Record<string, unknown>,
  ): Promise<Result<DeliverResponse, ProviderError>> {
    if (!this.x402) {
      return err({
        kind: "deliver_failed",
        message: `"${this.providerId}": no x402 client configured — catalog-only registration`,
        providerUrl: this.baseUrl,
      });
    }
    const content = this.x402.getResourceContent(invoiceId);
    if (content === undefined) {
      return err({
        kind: "deliver_failed",
        message: `"${this.providerId}": no paid content for invoice "${invoiceId}" — the payment was not performed via this client`,
        providerUrl: this.baseUrl,
      });
    }
    const result =
      typeof content === "object" && content !== null
        ? (content as Record<string, unknown>)
        : { data: content };
    return {
      ok: true,
      value: {
        result,
        receipt: {
          receipt_id: `rcpt-${invoiceId}`,
          tx_ref: paymentRef,
          provider_id: this.providerId,
          settled_at: new Date().toISOString(),
          already_settled: false,
        },
      },
    };
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await fetch(this.baseUrl);
      // 402 (payment required) means the resource is live and selling access.
      const ok = res.status === 402 || res.ok;
      return ok
        ? { ok: true, detail: `${this.providerId} (real x402 resource, HTTP ${res.status})` }
        : { ok: false, detail: `${this.providerId} at ${this.baseUrl} returned HTTP ${res.status}` };
    } catch (cause) {
      return {
        ok: false,
        detail: `"${this.providerId}" unreachable at ${this.baseUrl}: ${(cause as Error).message}`,
      };
    }
  }
}

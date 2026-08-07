import {
  DeliverResponseSchema,
  QuoteResponseSchema,
  RemoteHealthSchema,
  err,
  microAlgo,
  type Capability,
  type DeliverResponse,
  type MicroAlgo,
  type ProviderAdapter,
  type ProviderCatalogEntry,
  type ProviderError,
  type QuoteResponse,
  type Result,
} from "@sentinel/schemas";

/**
 * Generic HTTP proxy adapter — delegates quote/deliver/health to a running
 * provider server. Attached via POST /providers/register so external servers
 * (mock/adversarial guard-demo providers, self-hosted resource servers) join
 * the catalog with zero code changes.
 *
 * Wire contract a registered server must speak:
 *   quote    POST {base_url}/quote    body { goal }
 *   deliver  POST {base_url}/deliver  body { invoice_id, payment_ref, input }
 *   health   GET  {base_url}/health
 *
 * Every response is validated with a .strict() schema — an external server is
 * untrusted input, the same as any provider.
 */
export class RemoteProviderAdapter implements ProviderAdapter {
  readonly providerId: string;
  readonly capability: Capability;
  readonly priceHint: MicroAlgo;
  readonly latencyHintMs: number;
  readonly qualityScore: number;
  readonly baseUrl: string;
  readonly role: "primary" | "backup";

  constructor(entry: ProviderCatalogEntry) {
    this.providerId = entry.provider_id;
    this.capability = entry.capability;
    this.priceHint = microAlgo(entry.price_micro_algo);
    this.latencyHintMs = entry.latency_hint_ms;
    this.qualityScore = entry.quality_score;
    this.baseUrl = entry.base_url;
    this.role = entry.role ?? "primary";
  }

  async quote(goal: string): Promise<Result<QuoteResponse, ProviderError>> {
    try {
      const res = await fetch(`${this.baseUrl}/quote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal }),
      });
      const parsed = QuoteResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        return err({ kind: "unknown", message: `invalid quote from "${this.providerId}"`, providerUrl: this.baseUrl });
      }
      return { ok: true, value: parsed.data };
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
    input?: Record<string, unknown>,
  ): Promise<Result<DeliverResponse, ProviderError>> {
    try {
      const res = await fetch(`${this.baseUrl}/deliver`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invoice_id: invoiceId, payment_ref: paymentRef, input }),
      });
      const parsed = DeliverResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        return err({ kind: "unknown", message: `invalid deliver from "${this.providerId}"`, providerUrl: this.baseUrl });
      }
      return { ok: true, value: parsed.data };
    } catch (cause) {
      return err({
        kind: "timeout",
        message: `deliver failed for "${this.providerId}": ${(cause as Error).message}`,
        providerUrl: this.baseUrl,
      });
    }
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      const parsed = RemoteHealthSchema.safeParse(await res.json());
      if (!parsed.success) {
        return { ok: false, detail: `invalid /health response from "${this.providerId}"` };
      }
      const { ok, detail } = parsed.data;
      return detail === undefined ? { ok } : { ok, detail };
    } catch (cause) {
      return {
        ok: false,
        detail: `"${this.providerId}" unreachable at ${this.baseUrl}: ${(cause as Error).message}`,
      };
    }
  }
}

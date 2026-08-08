import {
  DeliverResponseSchema,
  ProviderCatalogEntryWireSchema,
  QuoteResponseSchema,
  RemoteHealthSchema,
  err,
  microAlgo,
  type Capability,
  type DeliverResponse,
  type MicroAlgo,
  type ProviderAdapter,
  type ProviderCatalogEntry,
  type ProviderCatalogEntryWire,
  type ProviderError,
  type ProviderFailMode,
  type ProviderKind,
  type ProviderMode,
  type QuoteResponse,
  type Result,
} from "@sentinel/schemas";

/**
 * Generic HTTP proxy adapter — delegates quote/deliver/health to a running
 * provider server. Attached via POST /providers/register (service-providers) so
 * external servers join the catalog with zero code changes, and constructed by
 * service-orchestrator from the fetched catalog so NodeMachine can pay and
 * deliver against any registered provider.
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
  readonly integration: "mock";
  readonly kind?: ProviderKind;
  readonly mode?: ProviderMode;
  readonly failMode?: ProviderFailMode;
  readonly scheme?: "exact" | "upto";
  readonly uptoActual?: MicroAlgo;
  readonly priceDriftPct?: number;
  readonly network?: string;

  constructor(entry: ProviderCatalogEntry) {
    this.providerId = entry.provider_id;
    this.capability = entry.capability;
    this.priceHint = microAlgo(entry.price_micro_algo);
    this.latencyHintMs = entry.latency_hint_ms;
    this.qualityScore = entry.quality_score;
    this.baseUrl = entry.base_url;
    this.role = entry.role ?? "primary";
    // A RemoteProviderAdapter proxies a /quote+/deliver+/health server — the
    // classic (non-x402) wire contract. Real x402 providers get their own
    // adapter class (X402ProviderAdapter) so routing stays type-honest.
    this.integration = "mock";
    if (entry.kind !== undefined) this.kind = entry.kind;
    if (entry.mode !== undefined) this.mode = entry.mode;
    if (entry.failMode !== undefined) this.failMode = entry.failMode;
    if (entry.scheme !== undefined) this.scheme = entry.scheme;
    if (entry.uptoActual !== undefined) this.uptoActual = microAlgo(entry.uptoActual);
    if (entry.priceDriftPct !== undefined) this.priceDriftPct = entry.priceDriftPct;
    if (entry.network !== undefined) this.network = entry.network;
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

// ─── Wire conversions ─────────────────────────────────────────────────────────
// In-process catalog entries keep price_micro_algo as a bigint (MicroAlgo); the
// HTTP wire shape (ProviderCatalogEntryWire) carries it as a decimal string.

export function toWire(adapter: ProviderAdapter): ProviderCatalogEntryWire {
  return {
    provider_id: adapter.providerId,
    capability: adapter.capability,
    price_micro_algo: adapter.priceHint.toString(),
    latency_hint_ms: adapter.latencyHintMs,
    quality_score: adapter.qualityScore,
    base_url: adapter.baseUrl,
    role: adapter.role,
    integration: adapter.integration,
    ...(adapter.kind !== undefined ? { kind: adapter.kind } : {}),
    ...(adapter.mode !== undefined ? { mode: adapter.mode } : {}),
    ...(adapter.failMode !== undefined ? { failMode: adapter.failMode } : {}),
    ...(adapter.scheme !== undefined ? { scheme: adapter.scheme } : {}),
    ...(adapter.uptoActual !== undefined ? { uptoActual: adapter.uptoActual.toString() } : {}),
    ...(adapter.priceDriftPct !== undefined ? { priceDriftPct: adapter.priceDriftPct } : {}),
    ...(adapter.network !== undefined ? { network: adapter.network } : {}),
  };
}

export function fromWire(wire: ProviderCatalogEntryWire): ProviderCatalogEntry {
  const checked = ProviderCatalogEntryWireSchema.safeParse(wire);
  if (!checked.success) {
    throw new Error(
      `invalid provider catalog wire entry: ${checked.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return {
    provider_id: checked.data.provider_id,
    capability: checked.data.capability,
    price_micro_algo: BigInt(checked.data.price_micro_algo),
    latency_hint_ms: checked.data.latency_hint_ms,
    quality_score: checked.data.quality_score,
    base_url: checked.data.base_url,
    role: checked.data.role,
    integration: checked.data.integration,
    ...(checked.data.kind !== undefined ? { kind: checked.data.kind } : {}),
    ...(checked.data.mode !== undefined ? { mode: checked.data.mode } : {}),
    ...(checked.data.failMode !== undefined ? { failMode: checked.data.failMode } : {}),
    ...(checked.data.scheme !== undefined ? { scheme: checked.data.scheme } : {}),
    ...(checked.data.uptoActual !== undefined ? { uptoActual: BigInt(checked.data.uptoActual) } : {}),
    ...(checked.data.priceDriftPct !== undefined ? { priceDriftPct: checked.data.priceDriftPct } : {}),
    ...(checked.data.network !== undefined ? { network: checked.data.network } : {}),
  };
}

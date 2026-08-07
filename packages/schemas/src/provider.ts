import { z } from "zod";
import type { Capability } from "./capability.js";
import { CapabilitySchema } from "./capability.js";
import type { MicroAlgo } from "./branded.js";
import type { Result } from "./result.js";

// ─── Provider catalog entry (metadata only, no HTTP) ─────────────────────────

export const ProviderCatalogEntrySchema = z
  .object({
    provider_id: z.string(),
    capability: CapabilitySchema,
    price_micro_algo: z.bigint(),      // MicroAlgo — never plain number
    latency_hint_ms: z.number().int(),
    quality_score: z.number().min(0).max(1),
    base_url: z.string().url(),
    role: z.enum(["primary", "backup"]).optional(),
  })
  .strict();

export type ProviderCatalogEntry = z.infer<typeof ProviderCatalogEntrySchema>;

// ─── HTTP wire shape (Phase 7) ────────────────────────────────────────────────
// The in-process catalog entry keeps price_micro_algo as a bigint (MicroAlgo);
// bigint is not JSON-representable, so every provider HTTP boundary carries it
// as a decimal string. Convert with toWireEntry / fromWireEntry in the service.

export const ProviderCatalogEntryWireSchema = z
  .object({
    provider_id: z.string(),
    capability: CapabilitySchema,
    price_micro_algo: z.string().regex(/^\d+$/, "microAlgo as decimal string"),
    latency_hint_ms: z.number().int(),
    quality_score: z.number().min(0).max(1),
    base_url: z.string().url(),
    role: z.enum(["primary", "backup"]).optional(),
    // Registry-local demo knob: whether this provider is currently marked
    // failed (excluded from routing). Absent on entries that can't report it.
    failed: z.boolean().optional(),
  })
  .strict();

export type ProviderCatalogEntryWire = z.infer<typeof ProviderCatalogEntryWireSchema>;

/** Full catalog list (GET /providers response) — used by the orchestrator to
 * build routeable adapters from whatever the registry currently holds. */
export const ProviderCatalogEntryWireListSchema = z.array(ProviderCatalogEntryWireSchema);
export type ProviderCatalogEntryWireList = z.infer<typeof ProviderCatalogEntryWireListSchema>;

export const RegisterProviderRequestSchema = z
  .object({
    entry: ProviderCatalogEntryWireSchema,
  })
  .strict();

export type RegisterProviderRequest = z.infer<typeof RegisterProviderRequestSchema>;

export const ProviderHealthResponseSchema = z
  .object({
    provider_id: z.string(),
    ok: z.boolean(),
    detail: z.string().optional(),
  })
  .strict();

export type ProviderHealthResponse = z.infer<typeof ProviderHealthResponseSchema>;

export const ProviderStatusResponseSchema = z
  .object({
    provider_id: z.string(),
    failed: z.boolean(),
  })
  .strict();

export type ProviderStatusResponse = z.infer<typeof ProviderStatusResponseSchema>;

// Liveness contract a registered remote provider server must speak (GET /health).
export const RemoteHealthSchema = z
  .object({
    ok: z.boolean(),
    detail: z.string().optional(),
  })
  .strict();

export type RemoteHealth = z.infer<typeof RemoteHealthSchema>;

// ─── Provider error ───────────────────────────────────────────────────────────

export const ProviderErrorKindSchema = z.enum([
  "invoice_failed",
  "payment_failed",
  "deliver_failed",
  "timeout",
  "capability_unsupported",
  "unknown",
]);
export type ProviderErrorKind = z.infer<typeof ProviderErrorKindSchema>;

export interface ProviderError {
  kind: ProviderErrorKind;
  message: string;
  providerUrl?: string;
}

// ─── Quote / deliver shapes ───────────────────────────────────────────────────

export const QuoteResponseSchema = z
  .object({
    invoice_id: z.string(),
    provider_id: z.string(),
    capability: z.string(),
    price: z.number(),               // raw provider price (in provider's unit)
    currency: z.string(),
    schema: z.string(),
    terms_expires_at: z.string(),
    payment_required: z.boolean(),
  })
  .strict();

export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;

export const DeliverResponseSchema = z
  .object({
    result: z.record(z.string(), z.unknown()),
    receipt: z.record(z.string(), z.unknown()),
  })
  .strict();

export type DeliverResponse = z.infer<typeof DeliverResponseSchema>;

// ─── ProviderAdapter interface ────────────────────────────────────────────────
// Every provider (Zerion, LLM, mock, adversarial) implements this.
// Router and treasury never special-case a specific provider — they work
// through this interface only.

export interface ProviderAdapter {
  readonly providerId: string;
  readonly capability: Capability;
  readonly priceHint: MicroAlgo;       // indicative — authoritative price comes from quote()
  readonly latencyHintMs: number;
  readonly qualityScore: number;
  readonly baseUrl: string;
  readonly role: "primary" | "backup";

  /** Step 1: get invoice + terms (the 402 challenge). */
  quote(goal: string): Promise<Result<QuoteResponse, ProviderError>>;

  /** Step 2: deliver result after payment. */
  deliver(
    invoiceId: string,
    paymentRef: string,
    input?: Record<string, unknown>,
  ): Promise<Result<DeliverResponse, ProviderError>>;

  /** Liveness check — used by service-providers /health endpoint. */
  health(): Promise<{ ok: boolean; detail?: string }>;
}

// ─── ProviderRegistry interface (Phase 7) ─────────────────────────────────────
// Shared contract between apps/service-providers (in-memory impl) and any
// consumer that needs register/lookup semantics. A "failed" provider is a demo
// knob: it stays registered but is hidden from findByCapability so the
// router/fallback path can be demoed.

export interface ProviderRegistry {
  register(adapter: ProviderAdapter): void;
  list(): ProviderAdapter[];
  get(providerId: string): ProviderAdapter | undefined;
  findByCapability(capability: Capability): ProviderAdapter[];
  markFailed(providerId: string): boolean;
  recover(providerId: string): boolean;
  isFailed(providerId: string): boolean;
}

// ─── Route decision ───────────────────────────────────────────────────────────

export interface RouteDecision {
  adapter: ProviderAdapter;
  score: number;
  reason: string;
}

// ─── Router error ─────────────────────────────────────────────────────────────

export const RouterErrorKindSchema = z.enum([
  "no_candidate",
  "all_below_threshold",
  "capability_unsupported",
  "unknown",
]);
export type RouterErrorKind = z.infer<typeof RouterErrorKindSchema>;

export interface RouterError {
  kind: RouterErrorKind;
  capability: Capability;
  message: string;
}

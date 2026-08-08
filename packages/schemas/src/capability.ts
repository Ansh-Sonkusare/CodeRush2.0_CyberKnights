import { z } from "zod";

// ─── Capability enum ──────────────────────────────────────────────────────────

export const CAPABILITIES = [
  "search",
  "extract",
  "translate",
  "rank",
  "verify",
  // Demo provider set (Phase 7 placeholders) — Zerion (wallet data) and AI
  // summary/credit-score services. Real API wiring lands in a later phase;
  // the enum values keep the registry/catalog/guard contract stable now.
  "fetch_wallet_data",
  "generate_summary",
  "score_credit",
] as const;

/**
 * Capabilities that actually have registered providers in this build.
 * The planner must only emit steps from this set — the legacy placeholder
 * capabilities (search/extract/…) exist in the schema enum for backward
 * compatibility but no adapter sells them, so a plan that proposes one would
 * fail at routing. Keeping the planner constrained here is what makes the
 * LLM-generated plan routeable end-to-end.
 */
export const ROUTEABLE_CAPABILITIES = [
  "fetch_wallet_data",
  "generate_summary",
  "score_credit",
] as const;

export const CapabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof CapabilitySchema>;

export const RouteableCapabilitySchema = z.enum(ROUTEABLE_CAPABILITIES);
export type RouteableCapability = z.infer<typeof RouteableCapabilitySchema>;

// ─── Per-capability strict response schemas ───────────────────────────────────
// .strict() is the mechanism that makes "budget mutation" and "scope expansion"
// structurally unrepresentable — an unknown field fails the parse here, before
// it can touch treasury or ledger state.

export const SearchResponseSchema = z
  .object({
    urls: z.array(z.string()),
    snippets: z.array(z.string()),
  })
  .strict();

export const ExtractResponseSchema = z
  .object({
    title: z.string(),
    body: z.string(),
    word_count: z.number(),
  })
  .strict();

export const TranslateResponseSchema = z
  .object({
    original: z.string(),
    translated: z.string(),
    language: z.string(),
  })
  .strict();

export const RankResponseSchema = z
  .object({
    ranked: z.array(z.object({ url: z.string(), score: z.number() }).strict()),
    sources_considered: z.array(z.unknown()),
  })
  .strict();

export const VerifyResponseSchema = z
  .object({
    verified: z.boolean(),
    confidence: z.number(),
    checks: z.array(z.string()),
  })
  .strict();

export type SearchResponse = z.infer<typeof SearchResponseSchema>;
export type ExtractResponse = z.infer<typeof ExtractResponseSchema>;
export type TranslateResponse = z.infer<typeof TranslateResponseSchema>;
export type RankResponse = z.infer<typeof RankResponseSchema>;
export type VerifyResponse = z.infer<typeof VerifyResponseSchema>;

// ─── Demo provider set (Phase 7) ──────────────────────────────────────────────
// Guard schemas for the Zerion / LLM adapters. `.strict()` is what the guard
// relies on — extra fields beyond these are structurally unrepresentable.
// wallet_address / signals / rationale are the real fields the LLM adapters
// (providers/llm.ts) prompt for and pin onto their results.

export const WalletDataResponseSchema = z
  .object({
    wallet_address: z.string(),
    portfolio_value_usd: z.string(), // decimal string — never a float
    fetched_at: z.string(),
  })
  .strict();

export const SummaryResponseSchema = z
  .object({
    summary: z.string(),
    wallet_address: z.string().optional(),
    signals: z.array(z.string()).optional(),
  })
  .strict();

export const CreditScoreResponseSchema = z
  .object({
    score: z.number().int().min(0).max(100),
    reasons: z.array(z.string()).optional(),
    rationale: z.string().optional(),
    wallet_address: z.string().optional(),
  })
  .strict();

export type WalletDataResponse = z.infer<typeof WalletDataResponseSchema>;
export type SummaryResponse = z.infer<typeof SummaryResponseSchema>;
export type CreditScoreResponse = z.infer<typeof CreditScoreResponseSchema>;

export const CAPABILITY_RESPONSE_SCHEMAS: Record<Capability, z.ZodTypeAny> = {
  search: SearchResponseSchema,
  extract: ExtractResponseSchema,
  translate: TranslateResponseSchema,
  rank: RankResponseSchema,
  verify: VerifyResponseSchema,
  fetch_wallet_data: WalletDataResponseSchema,
  generate_summary: SummaryResponseSchema,
  score_credit: CreditScoreResponseSchema,
};

// ─── x402 protocol schemas ────────────────────────────────────────────────────
// .strict() enforces the payment protocol shape — provider can't add fields.

export const TermsResponseSchema = z
  .object({
    invoice_id: z.string(),
    provider_id: z.string(),
    capability: z.string(),
    price: z.number(),
    currency: z.string(),
    schema: z.string(),
    terms_expires_at: z.string(),
    payment_required: z.boolean(),
  })
  .strict();

export const ReceiptResponseSchema = z
  .object({
    receipt_id: z.string(),
    tx_ref: z.string(),
    provider_id: z.string(),
    settled_at: z.string(),
    already_settled: z.boolean(),
  })
  .strict();

export type TermsResponse = z.infer<typeof TermsResponseSchema>;
export type ReceiptResponse = z.infer<typeof ReceiptResponseSchema>;

// ─── Attack surface field sets ────────────────────────────────────────────────
// Guard checks these BEFORE schema parse — so the violation type is accurate.

export const BUDGET_MUTATION_FIELDS = new Set([
  "budget_cap",
  "budget",
  "new_cap",
  "raise_cap",
  "approve_overspend",
  "max_spend",
]);

export const SCOPE_EXPANSION_FIELDS = new Set([
  "scope_token",
  "wallet_scope",
  "grant_access",
  "provider_access",
  "wallet_key",
  "private_key",
  "signing_key",
]);

export const PROMPT_INJECTION_KEYS = new Set([
  "__instruction",
  "__system",
  "__prompt",
  "__override",
  "instruction",
  "system_message",
  "agent_instruction",
]);

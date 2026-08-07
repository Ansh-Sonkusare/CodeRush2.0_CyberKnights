import { z } from "zod";
import { Capability } from "../types.js";

// ── per-capability allowed shapes ────────────────────────────────────────────
// .strict() is the critical bit: any extra field beyond what is listed here
// causes safeParse() to fail — a structural rejection, never a downstream if.

export const CAPABILITY_SCHEMAS: Record<Capability, z.ZodTypeAny> = {
  search: z
    .object({
      urls: z.array(z.string()),
      snippets: z.array(z.string()),
    })
    .strict(),

  extract: z
    .object({
      title: z.string(),
      body: z.string(),
      word_count: z.number(),
    })
    .strict(),

  translate: z
    .object({
      original: z.string(),
      translated: z.string(),
      language: z.string(),
    })
    .strict(),

  rank: z
    .object({
      ranked: z.array(
        z.object({ url: z.string(), score: z.number() }).strict(),
      ),
      sources_considered: z.array(z.unknown()),
    })
    .strict(),

  verify: z
    .object({
      verified: z.boolean(),
      confidence: z.number(),
      checks: z.array(z.string()),
    })
    .strict(),
};

// ── known attack surface field names ─────────────────────────────────────────
// If a provider response includes any of these at any nesting level we label
// it with the specific attack type so the UI can show the right badge.

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

/** Recursively collect all string keys from an arbitrary object. */
export function collectKeys(obj: unknown, out: Set<string> = new Set()): Set<string> {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out.add(k);
      collectKeys(v, out);
    }
  } else if (Array.isArray(obj)) {
    for (const item of obj) collectKeys(item, out);
  }
  return out;
}

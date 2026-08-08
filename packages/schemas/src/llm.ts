import { z } from "zod";

// ─── LLM client errors ────────────────────────────────────────────────────────
// Typed error union returned by LLMClient.generate — a caller must handle the
// failure path explicitly (no throws across the package boundary).

export const LLMErrorKindSchema = z.enum([
  "http",
  "timeout",
  "empty",
  "parse",
  "schema",
  "unknown",
]);
export type LLMErrorKind = z.infer<typeof LLMErrorKindSchema>;

export interface LLMError {
  kind: LLMErrorKind;
  message: string;
  provider: string;
}

// ─── Provider response envelopes ──────────────────────────────────────────────
// These parse raw LLM HTTP bodies so the client never `as`-casts external
// input. `.passthrough()` is intentional here: the envelope is only navigated
// to reach `content`, and that content is re-validated strictly against the
// caller's output schema before anything is trusted.

export const ChatCompletionEnvelopeSchema = z
  .object({
    choices: z.array(
      z
        .object({
          message: z
            .object({
              content: z.string().optional(),
            })
            .passthrough(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type ChatCompletionEnvelope = z.infer<typeof ChatCompletionEnvelopeSchema>;

export const OllamaChatEnvelopeSchema = z
  .object({
    message: z
      .object({
        content: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type OllamaChatEnvelope = z.infer<typeof OllamaChatEnvelopeSchema>;

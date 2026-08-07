import { GoogleGenAI } from "@google/genai";
import type { LLMConfig } from "@sentinel/config";
import {
  ChatCompletionEnvelopeSchema,
  OllamaChatEnvelopeSchema,
  type LLMError,
  type Result,
  err,
  ok,
  z,
} from "@sentinel/schemas";
import { toJSONSchema } from "zod";

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";
export const DEFAULT_OPENAI_BASE_URL = "https://api.groq.com/openai/v1";
export const DEFAULT_OPENAI_MODEL = "llama-3.3-70b-versatile";
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
export const DEFAULT_OLLAMA_MODEL = "qwen2.5-coder";
export const DEFAULT_TEMPERATURE = 0;
export const LLM_TIMEOUT_MS = 45_000;

export type LLMBackend = "gemini" | "openai-compatible" | "ollama";

// ─── Interface ────────────────────────────────────────────────────────────────
// Provider-agnostic structured-output client. The caller supplies the prompt
// and the strict zod schema the output must conform to; the client never sees
// a budget or a scope — it is a pure text-in / validated-JSON-out boundary.

export interface LLMClient {
  readonly provider: LLMBackend;
  readonly model: string;
  generate<T>(prompt: string, schema: z.ZodType<T>): Promise<Result<T, LLMError>>;
}

const stripTrailingSlash = (url: string): string => url.replace(/\/+$/, "");

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Convert a zod schema to JSON Schema for provider structured-output hints. */
function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  try {
    const converted = toJSONSchema(schema) as Record<string, unknown>;
    return converted && typeof converted === "object" ? converted : {};
  } catch {
    return {};
  }
}

function parseStructured<T>(
  text: string,
  schema: z.ZodType<T>,
  provider: string,
): Result<T, LLMError> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return err({
      kind: "parse",
      message: `provider returned non-JSON content: ${messageOf(e)}`,
      provider,
    });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => i.path.join(".") || i.message)
      .join("; ");
    return err({
      kind: "schema",
      message: `structured output failed validation: ${issues}`,
      provider,
    });
  }
  return ok(parsed.data);
}

// ─── Backends ─────────────────────────────────────────────────────────────────

export class OpenAICompatibleLLMClient implements LLMClient {
  readonly provider = "openai-compatible" as const;

  constructor(
    readonly model: string,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly temperature = DEFAULT_TEMPERATURE,
    private readonly maxTokens?: number,
  ) {}

  async generate<T>(prompt: string, schema: z.ZodType<T>): Promise<Result<T, LLMError>> {
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
          temperature: this.temperature,
          ...(this.maxTokens !== undefined ? { max_tokens: this.maxTokens } : {}),
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });
      if (!res.ok) {
        return err({
          kind: "http",
          message: `chat/completions returned HTTP ${res.status}`,
          provider: this.provider,
        });
      }
      const body = await res.json();
      const envelope = ChatCompletionEnvelopeSchema.safeParse(body);
      if (!envelope.success) {
        return err({
          kind: "schema",
          message: "chat completion envelope failed validation",
          provider: this.provider,
        });
      }
      const content = envelope.data.choices[0]?.message?.content;
      if (!content) {
        return err({
          kind: "empty",
          message: "openai-compatible provider returned no message content",
          provider: this.provider,
        });
      }
      return parseStructured(content, schema, this.provider);
    } catch (e) {
      return err({ kind: "unknown", message: messageOf(e), provider: this.provider });
    }
  }
}

export class OllamaLLMClient implements LLMClient {
  readonly provider = "ollama" as const;

  constructor(
    readonly model: string,
    private readonly baseUrl: string,
    private readonly temperature = DEFAULT_TEMPERATURE,
    private readonly maxTokens?: number,
  ) {}

  async generate<T>(prompt: string, schema: z.ZodType<T>): Promise<Result<T, LLMError>> {
    try {
      const jsonSchema = jsonSchemaFor(schema);
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
          stream: false,
          format: jsonSchema,
          options: {
            temperature: this.temperature,
            ...(this.maxTokens !== undefined ? { num_predict: this.maxTokens } : {}),
          },
        }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });
      if (!res.ok) {
        return err({
          kind: "http",
          message: `ollama /api/chat returned HTTP ${res.status}`,
          provider: this.provider,
        });
      }
      const body = await res.json();
      const envelope = OllamaChatEnvelopeSchema.safeParse(body);
      if (!envelope.success) {
        return err({
          kind: "schema",
          message: "ollama chat envelope failed validation",
          provider: this.provider,
        });
      }
      const content = envelope.data.message?.content;
      if (!content) {
        return err({
          kind: "empty",
          message: "ollama returned no message content",
          provider: this.provider,
        });
      }
      return parseStructured(content, schema, this.provider);
    } catch (e) {
      return err({ kind: "unknown", message: messageOf(e), provider: this.provider });
    }
  }
}

export class GeminiLLMClient implements LLMClient {
  readonly provider = "gemini" as const;
  private readonly ai: GoogleGenAI;

  constructor(
    readonly model: string,
    apiKey: string,
    private readonly temperature = DEFAULT_TEMPERATURE,
    private readonly maxTokens?: number,
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async generate<T>(prompt: string, schema: z.ZodType<T>): Promise<Result<T, LLMError>> {
    try {
      const jsonSchema = jsonSchemaFor(schema);
      const res = await this.ai.models.generateContent({
        model: this.model,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          responseMimeType: "application/json",
          ...(Object.keys(jsonSchema).length > 0 ? { responseSchema: jsonSchema } : {}),
          temperature: this.temperature,
          ...(this.maxTokens !== undefined ? { maxOutputTokens: this.maxTokens } : {}),
        },
      });
      const text = res.text;
      if (typeof text !== "string" || text.length === 0) {
        return err({
          kind: "empty",
          message: "gemini returned no text",
          provider: this.provider,
        });
      }
      return parseStructured(text, schema, this.provider);
    } catch (e) {
      return err({ kind: "unknown", message: messageOf(e), provider: this.provider });
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────
// Backend is chosen from an explicit LLM_PROVIDER, or inferred from the API
// keys actually present. Config errors (e.g. missing key for a provider that
// requires one) throw at construction — fail fast, not mid-demo.

export function createLLMClient(config: LLMConfig): LLMClient {
  const temperature = config.temperature ?? DEFAULT_TEMPERATURE;
  const maxTokens = config.maxTokens;

  switch (resolveBackend(config)) {
    case "gemini":
      return new GeminiLLMClient(
        config.model ?? config.geminiModel ?? DEFAULT_GEMINI_MODEL,
        config.geminiApiKey ?? config.apiKey ?? "",
        temperature,
        maxTokens,
      );
    case "openai-compatible": {
      const apiKey = config.apiKey ?? config.groqApiKey ?? config.openaiApiKey;
      if (!apiKey) {
        throw new Error(
          "openai-compatible backend needs LLM_API_KEY / GROQ_API_KEY / OPENAI_API_KEY",
        );
      }
      return new OpenAICompatibleLLMClient(
        config.model ?? config.openaiModel ?? DEFAULT_OPENAI_MODEL,
        stripTrailingSlash(config.baseUrl ?? DEFAULT_OPENAI_BASE_URL),
        apiKey,
        temperature,
        maxTokens,
      );
    }
    case "ollama":
      return new OllamaLLMClient(
        config.model ?? config.ollamaModel ?? DEFAULT_OLLAMA_MODEL,
        stripTrailingSlash(config.baseUrl ?? config.ollamaBaseUrl ?? DEFAULT_OLLAMA_BASE_URL),
        temperature,
        maxTokens,
      );
  }
}

function resolveBackend(config: LLMConfig): LLMBackend {
  if (
    config.provider === "gemini" ||
    config.provider === "openai-compatible" ||
    config.provider === "ollama"
  ) {
    return config.provider;
  }
  if (config.geminiApiKey || config.apiKey) return "gemini";
  if (config.groqApiKey || config.openaiApiKey) return "openai-compatible";
  return "ollama";
}

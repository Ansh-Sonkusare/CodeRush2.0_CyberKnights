import { GoogleGenAI } from "@google/genai";
import { TASK_GRAPH } from "../config/taskGraph.js";
import { TaskGraph } from "../types.js";
import {
  PLANNER_GRAPH_JSON_SCHEMA,
  PLANNER_GRAPH_SCHEMA,
  PlannerGraph,
  containsForbiddenKeys,
  plannerGraphToTaskGraph,
  validateGraph,
} from "./plannerSchema.js";

export type PlannerBackend = "gemini" | "openai-compatible" | "ollama";

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
export const DEFAULT_OLLAMA_MODEL = "qwen2.5-coder";
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";
export const DEFAULT_OPENAI_BASE_URL = "https://api.groq.com/openai/v1";
export const DEFAULT_OPENAI_MODEL = "llama-3.3-70b-versatile";
export const PLANNER_TIMEOUT_MS = 45_000;
export const DEFAULT_BUDGET_CAP = 0.5;
export const DEFAULT_TEMPERATURE = 0;

export const SYSTEM_PROMPT = `You are the task planner for a policy-driven agent payment router.
You decompose a user goal into a dependency-aware task graph of paid capability calls.

The only capabilities providers sell are: ${PLANNER_GRAPH_SCHEMA.shape.steps.element.shape.capability.options.join(", ")}.

Respond with a single JSON object:
{ "task_id": string, "name": string, "goal": string, "steps": [ { "id": string, "label": string, "capability": one of the capabilities above, "dependsOn": string[] } ] }

Rules:
- Every step must use exactly one of the capabilities above.
- Step ids are unique. dependsOn may only reference other step ids (a DAG, no cycles).
- Parallel steps share no dependency; a step must not depend on a step that depends on it.
- Labels are imperative, under 8 words.
- You propose task structure ONLY. Never include any budget, price, amount, cap, scope, wallet, token, key, secret, or credential fields anywhere in the JSON. The treasury sets the budget, not you.`;

export interface PlannerEnv {
  backend: PlannerBackend;
  baseUrl: string | undefined;
  apiKey: string | undefined;
  model: string;
  temperature: number;
  maxTokens: number | undefined;
}

const stripTrailingSlash = (url: string): string => url.replace(/\/+$/, "");

function resolveTemperature(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_TEMPERATURE;
}

function resolveMaxTokens(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export function loadPlannerEnv(): PlannerEnv {
  const geminiKey = process.env.GEMINI_API_KEY || process.env.LLM_API_KEY || undefined;
  const openaiKey =
    process.env.LLM_API_KEY ||
    process.env.GROQ_API_KEY ||
    process.env.OPENAI_API_KEY ||
    undefined;
  const requested = process.env.LLM_PROVIDER;

  let backend: PlannerBackend;
  if (requested === "gemini" || requested === "openai-compatible" || requested === "ollama") {
    backend = requested;
  } else if (geminiKey) {
    backend = "gemini";
  } else if (openaiKey) {
    backend = "openai-compatible";
  } else {
    backend = "ollama";
  }

  switch (backend) {
    case "gemini":
      return {
        backend,
        baseUrl: undefined,
        apiKey: geminiKey,
        model: process.env.LLM_MODEL ?? process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
        temperature: resolveTemperature(process.env.LLM_TEMPERATURE),
        maxTokens: resolveMaxTokens(process.env.LLM_MAX_TOKENS),
      };
    case "openai-compatible":
      return {
        backend,
        baseUrl: stripTrailingSlash(process.env.LLM_BASE_URL ?? DEFAULT_OPENAI_BASE_URL),
        apiKey: openaiKey,
        model: process.env.LLM_MODEL ?? process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
        temperature: resolveTemperature(process.env.LLM_TEMPERATURE),
        maxTokens: resolveMaxTokens(process.env.LLM_MAX_TOKENS),
      };
    case "ollama":
      return {
        backend,
        baseUrl: stripTrailingSlash(
          process.env.LLM_BASE_URL ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL,
        ),
        apiKey: undefined,
        model: process.env.LLM_MODEL ?? process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL,
        temperature: resolveTemperature(process.env.LLM_TEMPERATURE),
        maxTokens: resolveMaxTokens(process.env.LLM_MAX_TOKENS),
      };
  }
}

export interface Planner {
  readonly backend: PlannerBackend;
  readonly model: string;
  plan(goal: string): Promise<PlannerGraph>;
}

export class OpenAICompatiblePlanner implements Planner {
  readonly backend = "openai-compatible" as const;

  constructor(
    readonly baseUrl: string,
    readonly model: string,
    readonly apiKey: string,
    private readonly temperature = DEFAULT_TEMPERATURE,
    private readonly maxTokens?: number,
  ) {}

  async plan(goal: string): Promise<PlannerGraph> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: goal },
        ],
        temperature: this.temperature,
        ...(this.maxTokens !== undefined ? { max_tokens: this.maxTokens } : {}),
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(PLANNER_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`chat/completions returned HTTP ${res.status}`);
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("openai-compatible provider returned no message content");
    return PLANNER_GRAPH_SCHEMA.parse(JSON.parse(content));
  }
}

export class OllamaPlanner implements Planner {
  readonly backend = "ollama" as const;
  constructor(
    readonly baseUrl: string,
    readonly model: string,
    private readonly temperature = DEFAULT_TEMPERATURE,
    private readonly maxTokens?: number,
  ) {}

  async plan(goal: string): Promise<PlannerGraph> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: goal },
        ],
        stream: false,
        format: PLANNER_GRAPH_JSON_SCHEMA,
        options: {
          temperature: this.temperature,
          ...(this.maxTokens !== undefined ? { num_predict: this.maxTokens } : {}),
        },
      }),
      signal: AbortSignal.timeout(PLANNER_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`ollama /api/chat returned HTTP ${res.status}`);
    }
    const body = (await res.json()) as { message?: { content?: string } };
    const content = body.message?.content;
    if (!content) throw new Error("ollama returned no message content");
    return PLANNER_GRAPH_SCHEMA.parse(JSON.parse(content));
  }
}

export class GeminiPlanner implements Planner {
  readonly backend = "gemini" as const;
  private readonly ai: GoogleGenAI;

  constructor(
    readonly apiKey: string,
    readonly model: string,
    private readonly temperature = DEFAULT_TEMPERATURE,
    private readonly maxTokens?: number,
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async plan(goal: string): Promise<PlannerGraph> {
    const res = await this.ai.models.generateContent({
      model: this.model,
      contents: [{ role: "user", parts: [{ text: `${SYSTEM_PROMPT}\n\nTask:\n${goal}` }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema: PLANNER_GRAPH_JSON_SCHEMA,
        temperature: this.temperature,
        ...(this.maxTokens !== undefined ? { maxOutputTokens: this.maxTokens } : {}),
      },
    });
    const text = res.text;
    if (!text) throw new Error("gemini returned no text");
    return PLANNER_GRAPH_SCHEMA.parse(JSON.parse(text));
  }
}

export function createPlanner(env: PlannerEnv = loadPlannerEnv()): Planner {
  switch (env.backend) {
    case "gemini":
      return new GeminiPlanner(env.apiKey ?? "", env.model, env.temperature, env.maxTokens);
    case "openai-compatible":
      if (!env.apiKey) {
        throw new Error(
          "openai-compatible backend needs LLM_API_KEY / GROQ_API_KEY / OPENAI_API_KEY",
        );
      }
      return new OpenAICompatiblePlanner(
        env.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
        env.model,
        env.apiKey,
        env.temperature,
        env.maxTokens,
      );
    case "ollama":
      return new OllamaPlanner(
        env.baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
        env.model,
        env.temperature,
        env.maxTokens,
      );
  }
}

export interface PlanOutcome {
  graph: TaskGraph;
  source: "planner" | "fallback";
  reason?: string;
}

export async function planWithFallback(
  planner: Planner,
  goal: string,
  options: { task_id?: string; budget_cap?: number; timeout_ms?: number } = {},
): Promise<PlanOutcome> {
  const timeoutMs = options.timeout_ms ?? PLANNER_TIMEOUT_MS;
  const budgetCap = options.budget_cap ?? DEFAULT_BUDGET_CAP;
  try {
    const raw = await withTimeout(planner.plan(goal), timeoutMs);
    const forbidden = containsForbiddenKeys(raw);
    if (forbidden) {
      throw new Error(
        `planner emitted forbidden field "${forbidden.slice(1)}" — budgets/scopes are treasury-owned`,
      );
    }
    const validated = validateGraph(raw);
    if (!validated.ok) {
      throw new Error(`planner graph invalid: ${validated.errors.join("; ")}`);
    }
    return {
      graph: plannerGraphToTaskGraph(validated.graph, {
        task_id: options.task_id,
        budget_cap: budgetCap,
      }),
      source: "planner",
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { graph: TASK_GRAPH, source: "fallback", reason };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`planner timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

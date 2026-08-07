import { z } from "zod";
import { ok, err, type Result } from "@sentinel/schemas";

/**
 * @sentinel/config
 *
 * Single validated source of environment configuration. Nothing else in the
 * repo reads `process.env` directly — services call loadConfig() at boot and
 * inject the resulting AppConfig.
 *
 * Rules:
 *  - `network` is z.enum(["testnet"]) — mainnet is not representable, so a
 *    mainnet value fails the schema and boot fails structurally.
 *  - Every bad variable is listed in ConfigError.message — fail fast at boot,
 *    not at first use mid-demo.
 *  - Ports default to the values in MIGRATION.md.
 */

export const DEFAULT_FACILITATOR_URL = "https://facilitator.goplausible.xyz";

// ─── Enums ────────────────────────────────────────────────────────────────────

export const NetworkSchema = z.enum(["testnet"]);
export type Network = z.infer<typeof NetworkSchema>;

export const LLMProviderSchema = z.enum(["gemini", "openai-compatible", "ollama"]);
export type LLMProvider = z.infer<typeof LLMProviderSchema>;

const PORT_SCHEMA = z.coerce.number().int().min(1).max(65535);

// ─── CSV "name=port,name=port" parser ─────────────────────────────────────────

function parseNamePortPairs(raw: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      throw new Error(`expected "name=port" pairs, got "${trimmed}"`);
    }
    const name = trimmed.slice(0, eq).trim();
    const portText = trimmed.slice(eq + 1).trim();
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`invalid port "${portText}" in "${trimmed}"`);
    }
    out[name] = port;
  }
  return out;
}

// Parse CSV pairs but never throw — return the raw string on failure so the
// schema below can surface it as a validation issue (zod does NOT catch
// arbitrary throws from transform callbacks).
function tryParseNamePortPairs(raw: string): Record<string, number> | string {
  try {
    return parseNamePortPairs(raw);
  } catch {
    return raw;
  }
}

const NAME_PORT_PAIRS_SCHEMA = z
  .string()
  .default("")
  .transform(tryParseNamePortPairs)
  .refine((v): v is Record<string, number> => typeof v === "object", {
    message: 'expected "name=port" comma-separated pairs (e.g. "search-a=4101")',
  });

// ─── AppConfig schema ─────────────────────────────────────────────────────────

const LLM_CONFIG_SCHEMA = z
  .object({
    provider: LLMProviderSchema.optional(),
    baseUrl: z.string().url().optional(),
    apiKey: z.string().optional(),
    model: z.string().optional(),
    maxTokens: z.coerce.number().int().positive().optional(),
    temperature: z.coerce.number().optional(),
    // Legacy per-backend overrides (used when provider is inferred from keys)
    geminiApiKey: z.string().optional(),
    groqApiKey: z.string().optional(),
    openaiApiKey: z.string().optional(),
    ollamaBaseUrl: z.string().url().optional(),
    ollamaModel: z.string().optional(),
    geminiModel: z.string().optional(),
    openaiModel: z.string().optional(),
  })
  .strict();

export const AppConfigSchema = z
  .object({
    network: NetworkSchema.default("testnet"),
    facilitatorUrl: z.string().url().default(DEFAULT_FACILITATOR_URL),
    ports: z
      .object({
        gateway: PORT_SCHEMA.default(4000),
        orchestrator: PORT_SCHEMA.default(4010),
        providers: PORT_SCHEMA.default(4020),
        planner: PORT_SCHEMA.default(4040),
      })
      .strict(),
    llm: LLM_CONFIG_SCHEMA,
    zerionApiKey: z.string().optional(),
    // SQLite file path for the in-process ledger store (shared by the gateway
    // and the orchestrator). Parent directory is created at boot.
    ledgerPath: z.string().default(".data/ledger.db"),
    mockProviders: NAME_PORT_PAIRS_SCHEMA,
    adversarialProviders: NAME_PORT_PAIRS_SCHEMA,
  })
  .strict();

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type LLMConfig = AppConfig["llm"];

// ─── Config error ─────────────────────────────────────────────────────────────

export class ConfigError extends Error {
  readonly fieldErrors: ReadonlyMap<string, string>;

  constructor(fieldErrors: ReadonlyMap<string, string>) {
    const lines = [...fieldErrors.entries()]
      .map(([field, msg]) => `  - ${field}: ${msg}`)
      .join("\n");
    super(`Invalid environment config:\n${lines}`);
    this.name = "ConfigError";
    this.fieldErrors = fieldErrors;
  }
}

// Maps config paths back to env var names so error messages name the real var.
const ENV_VAR_BY_PATH: Readonly<Record<string, string>> = {
  network: "NETWORK",
  facilitatorUrl: "FACILITATOR_URL",
  "ports.gateway": "GATEWAY_PORT",
  "ports.orchestrator": "ORCHESTRATOR_PORT",
  "ports.providers": "PROVIDERS_PORT",
  "ports.planner": "PLANNER_PORT",
  "llm.provider": "LLM_PROVIDER",
  "llm.baseUrl": "LLM_BASE_URL",
  "llm.apiKey": "LLM_API_KEY",
  "llm.model": "LLM_MODEL",
  "llm.maxTokens": "LLM_MAX_TOKENS",
  "llm.temperature": "LLM_TEMPERATURE",
  "llm.geminiApiKey": "GEMINI_API_KEY",
  "llm.groqApiKey": "GROQ_API_KEY",
  "llm.openaiApiKey": "OPENAI_API_KEY",
  "llm.ollamaBaseUrl": "OLLAMA_BASE_URL",
  "llm.ollamaModel": "OLLAMA_MODEL",
  "llm.geminiModel": "GEMINI_MODEL",
  "llm.openaiModel": "OPENAI_MODEL",
  zerionApiKey: "ZERION_API_KEY",
  ledgerPath: "LEDGER_PATH",
  mockProviders: "MOCK_PROVIDER_PORTS",
  adversarialProviders: "ADVERSARIAL_PROVIDER_PORTS",
};

function rawFromEnv(env: Readonly<Record<string, string | undefined>>): Record<string, unknown> {
  return {
    network: env.NETWORK,
    facilitatorUrl: env.FACILITATOR_URL,
    ports: {
      gateway: env.GATEWAY_PORT,
      orchestrator: env.ORCHESTRATOR_PORT,
      providers: env.PROVIDERS_PORT,
      planner: env.PLANNER_PORT,
    },
    llm: {
      provider: env.LLM_PROVIDER,
      baseUrl: env.LLM_BASE_URL,
      apiKey: env.LLM_API_KEY,
      model: env.LLM_MODEL,
      maxTokens: env.LLM_MAX_TOKENS,
      temperature: env.LLM_TEMPERATURE,
      geminiApiKey: env.GEMINI_API_KEY,
      groqApiKey: env.GROQ_API_KEY,
      openaiApiKey: env.OPENAI_API_KEY,
      ollamaBaseUrl: env.OLLAMA_BASE_URL,
      ollamaModel: env.OLLAMA_MODEL,
      geminiModel: env.GEMINI_MODEL,
      openaiModel: env.OPENAI_MODEL,
    },
    zerionApiKey: env.ZERION_API_KEY,
    ledgerPath: env.LEDGER_PATH,
    mockProviders: env.MOCK_PROVIDER_PORTS,
    adversarialProviders: env.ADVERSARIAL_PROVIDER_PORTS,
  };
}

/**
 * Parse and validate env vars. Throws ConfigError listing every bad variable.
 * The canonical boot-time entry point — call once, inject the result everywhere.
 */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AppConfig {
  const result = loadConfigSafe(env);
  if (!result.ok) throw result.error;
  return result.value;
}

/** Non-throwing variant — returns a typed Result for tests and package boundaries. */
export function loadConfigSafe(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Result<AppConfig, ConfigError> {
  const parsed = AppConfigSchema.safeParse(rawFromEnv(env));
  if (parsed.success) return ok(parsed.data);

  const fieldErrors = new Map<string, string>();
  for (const issue of parsed.error.issues) {
    const key = issue.path.join(".");
    const envVar = ENV_VAR_BY_PATH[key] ?? key;
    fieldErrors.set(envVar, issue.message);
  }
  return err(new ConfigError(fieldErrors));
}

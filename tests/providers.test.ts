import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@sentinel/config";
import {
  CreditScoreResponseSchema,
  SummaryResponseSchema,
  WalletDataResponseSchema,
} from "@sentinel/schemas";
import { ZerionWalletDataProvider } from "../apps/service-providers/src/providers/zerion.js";
import {
  LLMCreditScoreProvider,
  LLMSummaryProvider,
} from "../apps/service-providers/src/providers/llm.js";

// ─── Provider unit tests ───────────────────────────────────────────────────────
// Verifies the Zerion and LLM adapters wire contract with mocked upstream HTTP
// (no network, no API keys required). The live tests at the bottom hit the real
// Zerion / Groq endpoints only when the corresponding env vars are present.

const EVM_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const ALGORAND_ADDRESS = "A".repeat(58);

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── ZerionWalletDataProvider ──────────────────────────────────────────────────

function mockZerionFetch(body: unknown, status = 200): typeof fetch {
  const fake = async (): Promise<Response> =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response;
  return fake as unknown as typeof fetch;
}

const zerionPortfolioBody = {
  data: {
    attributes: {
      total: { positions: 1234.567 },
    },
  },
};

function zerionProvider(fetchFn?: typeof fetch): ZerionWalletDataProvider {
  return new ZerionWalletDataProvider({ fetchFn: fetchFn ?? mockZerionFetch(zerionPortfolioBody) });
}

describe("ZerionWalletDataProvider — quote()", () => {
  it("quotes an EVM wallet from the goal and holds the address for deliver", async () => {
    const provider = zerionProvider();
    const q = await provider.quote(`assess wallet ${EVM_ADDRESS} please`);

    expect(q.ok).toBe(true);
    if (q.ok) {
      expect(q.value.provider_id).toBe("zerion-wallet-data");
      expect(q.value.capability).toBe("fetch_wallet_data");
      expect(q.value.price).toBe(3);
      expect(q.value.currency).toBe("microAlgo");
      expect(q.value.payment_required).toBe(true);
      expect(q.value.terms_expires_at).toBeTruthy();
    }
  });

  it("quotes a Solana wallet from the goal", async () => {
    const provider = zerionProvider();
    const q = await provider.quote("assess So11111111111111111111111111111111111111111");
    expect(q.ok).toBe(true);
  });

  it("rejects an Algorand address (Zerion serves EVM/Solana only)", async () => {
    const provider = zerionProvider();
    const q = await provider.quote(`assess wallet ${ALGORAND_ADDRESS}`);
    expect(q.ok).toBe(false);
    if (!q.ok) {
      expect(q.error.kind).toBe("capability_unsupported");
      expect(q.error.message).toContain("Algorand");
    }
  });

  it("fails cleanly when no wallet address is present", async () => {
    const provider = zerionProvider();
    const q = await provider.quote("assess this wallet");
    expect(q.ok).toBe(false);
    if (!q.ok) expect(q.error.kind).toBe("capability_unsupported");
  });
});

describe("ZerionWalletDataProvider — deliver()", () => {
  it("fetches the portfolio and returns a guard-valid wallet result", async () => {
    const provider = zerionProvider();
    const q = await provider.quote(`assess wallet ${EVM_ADDRESS}`);
    expect(q.ok).toBe(true);
    if (!q.ok) throw new Error(q.error.message);

    const d = await provider.deliver(q.value.invoice_id, "pay-ref-1");
    expect(d.ok).toBe(true);
    if (!d.ok) throw new Error(d.error.message);

    const parsed = WalletDataResponseSchema.safeParse(d.value.result);
    expect(parsed.success).toBe(true);
    expect(d.value.result.wallet_address).toBe(EVM_ADDRESS.toLowerCase());
    expect(d.value.result.portfolio_value_usd).toBe("1234.57");

    // receipt echoes the payment reference
    expect(d.value.receipt.tx_ref).toBe("pay-ref-1");
    expect(d.value.receipt.already_settled).toBe(false);
  });

  it("fails for an unknown invoice id", async () => {
    const provider = zerionProvider();
    const d = await provider.deliver("inv-unknown", "pay-ref-1");
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error.message).toContain('no wallet address quoted for invoice "inv-unknown"');
  });

  it("surfaces an upstream HTTP error", async () => {
    const provider = zerionProvider(mockZerionFetch({ error: "nope" }, 401));
    const q = await provider.quote(`assess wallet ${EVM_ADDRESS}`);
    expect(q.ok).toBe(true);
    if (!q.ok) throw new Error(q.error.message);

    const d = await provider.deliver(q.value.invoice_id, "pay-ref-1");
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.error.kind).toBe("deliver_failed");
      expect(d.error.message).toContain("HTTP 401");
    }
  });

  it("fails when the portfolio total is missing", async () => {
    const provider = zerionProvider(mockZerionFetch({ data: { attributes: {} } }));
    const q = await provider.quote(`assess wallet ${EVM_ADDRESS}`);
    expect(q.ok).toBe(true);
    if (!q.ok) throw new Error(q.error.message);

    const d = await provider.deliver(q.value.invoice_id, "pay-ref-1");
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error.message).toContain("missing a numeric total value");
  });

  it("reports healthy", async () => {
    const h = await zerionProvider().health();
    expect(h.ok).toBe(true);
  });
});

// ─── LLM providers ─────────────────────────────────────────────────────────────

function mockLLM(content: string): void {
  const fake = async (): Promise<Response> =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
    }) as Response;
  vi.stubGlobal("fetch", fake);
}

function llmSummaryProvider() {
  return new LLMSummaryProvider({
    provider: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey: "gsk_test",
    model: "llama-3.3-70b-versatile",
  });
}

function llmCreditProvider() {
  return new LLMCreditScoreProvider({
    provider: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey: "gsk_test",
    model: "llama-3.3-70b-versatile",
  });
}

describe("LLMSummaryProvider", () => {
  it("quotes an invoice at the summary price", async () => {
    mockLLM('{"summary":"x"}');
    const q = await llmSummaryProvider().quote("assess wallet 0x123");
    expect(q.ok).toBe(true);
    if (q.ok) {
      expect(q.value.provider_id).toBe("llm-summary");
      expect(q.value.capability).toBe("generate_summary");
      expect(q.value.price).toBe(1);
      expect(q.value.payment_required).toBe(true);
    }
  });

  it("delivers a summary that passes the strict summary schema", async () => {
    mockLLM('{"summary":"Holding summary for the wallet"}');
    const provider = llmSummaryProvider();
    const d = await provider.deliver("inv-llm-summary-1", "pay-ref-2");
    expect(d.ok).toBe(true);
    if (!d.ok) throw new Error(d.error.message);

    const parsed = SummaryResponseSchema.safeParse(d.value.result);
    expect(parsed.success).toBe(true);
    expect(d.value.result.summary).toBe("Holding summary for the wallet");
    expect(d.value.receipt.tx_ref).toBe("pay-ref-2");
  });

  it("pins the upstream wallet_address onto the generated result", async () => {
    mockLLM('{"summary":"pinned address test"}');
    const provider = llmSummaryProvider();
    const d = await provider.deliver("inv-llm-summary-2", "pay-ref-3", {
      "n-wallet": { wallet_address: EVM_ADDRESS, portfolio_value_usd: "12.5" },
    });
    expect(d.ok).toBe(true);
    if (!d.ok) throw new Error(d.error.message);
    expect(d.value.result.wallet_address).toBe(EVM_ADDRESS);
  });

  it("propagates an LLM failure as a deliver_failed error", async () => {
    mockLLM("not json");
    const provider = llmSummaryProvider();
    const d = await provider.deliver("inv-llm-summary-3", "pay-ref-4");
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error.kind).toBe("deliver_failed");
  });

  it("reports healthy with the configured backend/model", async () => {
    mockLLM('{"summary":"x"}');
    const h = await llmSummaryProvider().health();
    expect(h.ok).toBe(true);
    if (h.ok) expect(h.detail).toContain("openai-compatible");
  });
});

describe("LLMCreditScoreProvider", () => {
  it("delivers a credit score that passes the strict credit schema", async () => {
    mockLLM('{"score": 88, "reasons": ["token diversity"]}');
    const provider = llmCreditProvider();
    const d = await provider.deliver("inv-llm-credit-1", "pay-ref-5");
    expect(d.ok).toBe(true);
    if (!d.ok) throw new Error(d.error.message);

    const parsed = CreditScoreResponseSchema.safeParse(d.value.result);
    expect(parsed.success).toBe(true);
    expect(d.value.result.score).toBe(88);
    expect(d.value.receipt.tx_ref).toBe("pay-ref-5");
  });

  it("reads the upstream summary from the input for its prompt", async () => {
    mockLLM('{"score": 70, "reasons": ["moderate activity"]}');
    const provider = llmCreditProvider();
    const d = await provider.deliver("inv-llm-credit-2", "pay-ref-6", {
      "n-wallet": { wallet_address: EVM_ADDRESS },
      "n-summary": { summary: "Active trader" },
    });
    expect(d.ok).toBe(true);
    if (!d.ok) throw new Error(d.error.message);
    expect(d.value.result.wallet_address).toBe(EVM_ADDRESS);
  });
});

// ─── Live integration tests ────────────────────────────────────────────────────
// Run only when the real API keys are present in the environment (.env is
// loaded by vitest). These verify the providers actually work against the real
// Zerion and Groq endpoints — no mocks.

const config = loadConfig();
const hasLLM = config.llm.apiKey !== undefined || config.llm.groqApiKey !== undefined || config.llm.openaiApiKey !== undefined;
const hasZerion = config.zerionApiKey !== undefined;

const llmAdapterConfig = {
  provider: config.llm.provider,
  baseUrl: config.llm.baseUrl,
  apiKey: config.llm.apiKey,
  model: config.llm.model,
  temperature: config.llm.temperature,
  maxTokens: config.llm.maxTokens,
};

describe.runIf(hasZerion)("ZerionWalletDataProvider — live", () => {
  it("fetches a real portfolio for an EVM wallet", async () => {
    const provider = new ZerionWalletDataProvider({ apiKey: config.zerionApiKey });
    const q = await provider.quote(`assess wallet ${EVM_ADDRESS}`);
    expect(q.ok).toBe(true);
    if (!q.ok) throw new Error(q.error.message);

    const d = await provider.deliver(q.value.invoice_id, "pay-live-zerion");
    expect(d.ok).toBe(true);
    if (!d.ok) throw new Error(d.error.message);

    const parsed = WalletDataResponseSchema.safeParse(d.value.result);
    expect(parsed.success).toBe(true);
    expect(d.value.result.wallet_address).toBe(EVM_ADDRESS.toLowerCase());
  }, 60_000);
});

describe.runIf(hasLLM)("LLMSummaryProvider — live", () => {
  it("generates a real summary from Groq", async () => {
    const provider = new LLMSummaryProvider(llmAdapterConfig);
    const d = await provider.deliver("inv-live-summary", "pay-live-summary", {
      "n-wallet": {
        wallet_address: EVM_ADDRESS,
        portfolio_value_usd: "123.45",
        fetched_at: new Date().toISOString(),
      },
    });
    if (!d.ok) throw new Error(JSON.stringify(d.error));
    expect(d.ok).toBe(true);
    if (!d.ok) throw new Error(d.error.message);
    expect(typeof d.value.result.summary).toBe("string");
    expect(d.value.result.summary.length).toBeGreaterThan(0);
  }, 60_000);
});

describe.runIf(hasLLM)("LLMCreditScoreProvider — live", () => {
  it("generates a real credit score from Groq", async () => {
    const provider = new LLMCreditScoreProvider(llmAdapterConfig);
    const d = await provider.deliver("inv-live-credit", "pay-live-credit", {
      "n-wallet": { wallet_address: EVM_ADDRESS, portfolio_value_usd: "123.45" },
      "n-summary": { summary: "Active wallet with stable holdings." },
    });
    if (!d.ok) throw new Error(JSON.stringify(d.error));
    expect(d.ok).toBe(true);
    if (!d.ok) throw new Error(d.error.message);
    expect(typeof d.value.result.score).toBe("number");
  }, 60_000);
});

import { serve } from "@hono/node-server";
import { loadConfig } from "@sentinel/config";
import { X402ProviderAdapter } from "@sentinel/providers";
import { type ProviderAdapter } from "@sentinel/schemas";
import { createProvidersApp } from "./app.js";
import { createInMemoryRegistry } from "./registry.js";
import { ZerionWalletDataProvider } from "./providers/zerion.js";
import { LLMCreditScoreProvider, LLMSummaryProvider } from "./providers/llm.js";
import {
  adversarialSummaryMock,
  adversarialWalletMock,
  creditScoreMock,
  summaryMock,
  walletDataMock,
} from "./providers/mock.js";
import {
  X402_CREDIT_SCORE_PATH,
  X402_SUMMARY_PATH,
  X402_WALLET_DATA_PATH,
  createX402ResourceMiddleware,
  creditScorePayload,
  summaryPayload,
  walletDataPayload,
} from "./x402-resource-server.js";

const config = loadConfig();

const registry = createInMemoryRegistry();

// createProvidersApp reads from the registry lazily per request, so the app can
// be built before registration happens below.
const app = createProvidersApp(registry);

// Real x402 resource providers — ONLY registered when the operator has
// committed to real TestNet payments (X402_MODE=algorand). In that mode every
// routable provider must be payable through the real AlgorandX402Client, which
// requires a 402 challenge: the mock/zerion/LLM adapters return 200 directly
// and can never be paid, so they are excluded from the catalog entirely rather
// than being tried and failing every run. In simulated mode the catalog stays
// the full mock+placeholders set so routing never reaches a provider it can't
// pay for.
if (config.x402Mode === "algorand") {
  const x402Middleware = createX402ResourceMiddleware(config);
  if (!x402Middleware) {
    console.warn(
      "[providers] X402_MODE=algorand but the x402 resource server could not be built — no providers registered",
    );
  } else {
    app.use(x402Middleware);
    app.get(X402_WALLET_DATA_PATH, (c) => c.json(walletDataPayload()));
    app.get(X402_SUMMARY_PATH, (c) => c.json(summaryPayload()));
    app.get(X402_CREDIT_SCORE_PATH, (c) => c.json(creditScorePayload()));

    const x402Base = (path: string): string =>
      `http://127.0.0.1:${config.ports.providers}${path}`;
    const x402Entry = (
      providerId: string,
      capability: "fetch_wallet_data" | "generate_summary" | "score_credit",
      priceMicroAlgo: bigint,
      latencyHintMs: number,
      qualityScore: number,
      path: string,
    ): ProviderAdapter =>
      new X402ProviderAdapter({
        provider_id: providerId,
        capability,
        price_micro_algo: priceMicroAlgo,
        latency_hint_ms: latencyHintMs,
        quality_score: qualityScore,
        base_url: x402Base(path),
        integration: "x402",
      });

    registry.register(x402Entry("x402-wallet-data", "fetch_wallet_data", 5n, 300, 0.95, X402_WALLET_DATA_PATH));
    registry.register(x402Entry("x402-summary", "generate_summary", 3n, 600, 0.9, X402_SUMMARY_PATH));
    registry.register(x402Entry("x402-credit-score", "score_credit", 4n, 500, 0.88, X402_CREDIT_SCORE_PATH));

    console.log(
      `[providers] real x402 resource servers enabled — ${x402Base(X402_WALLET_DATA_PATH)}, ` +
        `${x402Base(X402_SUMMARY_PATH)}, ${x402Base(X402_CREDIT_SCORE_PATH)} (each pays 0.001 USDC on Algorand TestNet via facilitator)`,
    );
  }
} else {
  registry.register(
    new ZerionWalletDataProvider({ baseUrl: undefined, apiKey: config.zerionApiKey }),
  );
  registry.register(
    new LLMSummaryProvider({
      baseUrl: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
      model: config.llm.model,
    }),
  );
  registry.register(
    new LLMCreditScoreProvider({
      baseUrl: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
      model: config.llm.model,
    }),
  );

  // In-process demo providers — routable, paying, delivering (see providers/mock).
  // The well-behaved set wins the router over the placeholders on price; the
  // adversarial set exists so the policy guard can be demoed live via the run
  // request's attackNode. Their catalog base URLs point back at this service's
  // /mock/:id/* routes so the orchestrator's RemoteProviderAdapter can reach them.
  const mockBase = (id: string): string =>
    `http://127.0.0.1:${config.ports.providers}/mock/${id}`;

  registry.register(walletDataMock(mockBase("mock-wallet-data")));
  registry.register(summaryMock(mockBase("mock-summary")));
  registry.register(creditScoreMock(mockBase("mock-credit-score")));
  registry.register(adversarialWalletMock(mockBase("mock-wallet-data-adversarial")));
  registry.register(adversarialSummaryMock(mockBase("mock-summary-adversarial")));
}

serve({ fetch: app.fetch, port: config.ports.providers }, (info) => {
  console.log(`[providers] listening on :${info.port}`);
});

import { serve } from "@hono/node-server";
import { loadConfig } from "@sentinel/config";
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

const config = loadConfig();

const registry = createInMemoryRegistry();
registry.register(
  new ZerionWalletDataProvider({
    ...(config.zerionApiKey !== undefined ? { apiKey: config.zerionApiKey } : {}),
  }),
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

const app = createProvidersApp(registry);

serve({ fetch: app.fetch, port: config.ports.providers }, (info) => {
  console.log(`[providers] listening on :${info.port}`);
});

import { serve } from "@hono/node-server";
import { loadConfig } from "@sentinel/config";
import { createProvidersApp } from "./app.js";
import { createInMemoryRegistry } from "./registry.js";
import { ZerionWalletDataProvider } from "./providers/zerion.js";
import { LLMCreditScoreProvider, LLMSummaryProvider } from "./providers/llm.js";

const config = loadConfig();

const registry = createInMemoryRegistry();
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

const app = createProvidersApp(registry);

serve({ fetch: app.fetch, port: config.ports.providers }, (info) => {
  console.log(`[providers] listening on :${info.port}`);
});

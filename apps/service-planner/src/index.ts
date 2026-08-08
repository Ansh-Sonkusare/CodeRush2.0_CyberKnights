import { serve } from "@hono/node-server";
import { loadEnv, loadConfig } from "@sentinel/config";
import { createLLMClient } from "@sentinel/llm-client";
import { createPlannerApp } from "./app.js";

loadEnv();
const config = loadConfig();
const client = createLLMClient(config.llm);
const app = createPlannerApp(client);

serve({ fetch: app.fetch, port: config.ports.planner }, (info) => {
  console.log(`[planner] listening on :${info.port}`);
});

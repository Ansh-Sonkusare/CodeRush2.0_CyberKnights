import { serve } from "@hono/node-server";
import { loadConfig } from "@sentinel/config";
import { createLLMClient } from "@sentinel/llm-client";
import { createPlannerApp } from "./app.js";

const config = loadConfig();
const client = createLLMClient(config.llm);
const app = createPlannerApp(client);

serve({ fetch: app.fetch, port: config.ports.planner }, (info) => {
  console.log(`[planner] listening on :${info.port}`);
});

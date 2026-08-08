import { serve } from "@hono/node-server";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig, resolveLedgerPath } from "@sentinel/config";
import { createLedgerStore } from "@sentinel/ledger";
import { createGatewayApp } from "./app.js";
import { createWsHub } from "./wsHub.js";

const config = loadConfig();
const ledgerPath = resolveLedgerPath(config);
mkdirSync(dirname(ledgerPath), { recursive: true });
const ledger = createLedgerStore(ledgerPath);
const app = createGatewayApp(config, ledger);

const server = serve(
  { fetch: app.fetch, port: config.ports.gateway },
  (info) => {
    console.log(`[gateway] listening on :${info.port}`);
  },
);

// ─── WS hub /ws ───────────────────────────────────────────────────────────────
// The orchestrator's SSE stream is the event source for every UI frame; the hub
// just re-broadcasts. Returns a handle so the bridge can be restarted after the
// server is up (the bridge only needs the orchestrator's URL).
const hub = createWsHub();
server.on("upgrade", hub.handleUpgrade);

const orchestratorEventsUrl = `http://127.0.0.1:${config.ports.orchestrator}/orchestrator/events`;
hub.bridgeOrchestrator(orchestratorEventsUrl).catch((err) => {
  console.error("[gateway] ws hub bridge failed:", err);
});

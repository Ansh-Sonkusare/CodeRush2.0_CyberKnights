import { serve } from "@hono/node-server";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig } from "@sentinel/config";
import { createLedgerStore } from "@sentinel/ledger";
import { createGatewayApp } from "./app.js";

const config = loadConfig();
const ledgerPath = resolve(config.ledgerPath);
mkdirSync(dirname(ledgerPath), { recursive: true });
const ledger = createLedgerStore(ledgerPath);
const app = createGatewayApp(config, ledger);

serve({ fetch: app.fetch, port: config.ports.gateway }, (info) => {
  console.log(`[gateway] listening on :${info.port}`);
});

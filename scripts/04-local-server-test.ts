/**
 * Script 4: 04-local-server-test.ts
 *
 * Boots a minimal local Hono server with @x402/hono paymentMiddleware,
 * then pays it from the same process using wrapFetchWithPayment.
 * This proves the server-side middleware works locally before touching apps/service-providers.
 *
 * Flow:
 *   1. Start Hono server on port 4099 with paymentMiddleware on POST /ping
 *   2. Build paying fetch client from ALGO_MNEMONIC
 *   3. Hit the protected /ping endpoint — middleware returns 402
 *   4. wrapFetchWithPayment auto-pays via facilitator
 *   5. Server verifies + settles, delivers response
 *   6. Print txId + Lora explorer link
 *   7. Shut down server
 *
 * Prerequisites:
 *   Same as Script 3 (funded TestNet account with ALGO + USDC).
 *   ALGO_RECEIVER_ADDRESS must be opted into USDC ASA.
 *
 * Usage:
 *   npx tsx 04-local-server-test.ts
 *   pnpm --filter @sentinel/scripts run 04-local-server-test
 */

import "dotenv/config";
import algosdk from "algosdk";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import {
  paymentMiddleware,
  x402ResourceServer,
} from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/http";
import {
  ALGORAND_TESTNET_GENESIS_HASH,
  USDC_TESTNET_ASA_ID,
  toClientAvmSigner,
} from "@x402/avm";
import { ExactAvmScheme as ClientExactAvmScheme } from "@x402/avm/exact/client";
import { ExactAvmScheme as ServerExactAvmScheme } from "@x402/avm/exact/server";
import {
  x402Client,
  wrapFetchWithPayment,
  decodePaymentResponseHeader,
} from "@x402/fetch";
import type { Server } from "node:http";

// ── Env check ─────────────────────────────────────────────────────────────────
const mnemonic = process.env.ALGO_MNEMONIC;
const receiverAddress = process.env.ALGO_RECEIVER_ADDRESS;
const facilitatorUrl =
  process.env.FACILITATOR_URL ?? "https://facilitator.goplausible.xyz";

if (!mnemonic) {
  console.error("❌ ALGO_MNEMONIC is not set in .env");
  process.exit(1);
}
if (!receiverAddress) {
  console.error("❌ ALGO_RECEIVER_ADDRESS is not set in .env");
  process.exit(1);
}

const PORT = 4099;
const BASE_URL = `http://localhost:${PORT}`;

console.log("\n=== 04-local-server-test ===");
console.log("Server:      ", BASE_URL);
console.log("Facilitator: ", facilitatorUrl);
console.log("Receiver:    ", receiverAddress);
console.log();

// ── Step 1: Build x402 Resource Server (server-side) ─────────────────────────
// The GoPlausible facilitator advertises networks in the full genesis-hash form
// (e.g. "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI="), NOT the
// truncated ALGORAND_TESTNET_CAIP2 constant. Use the full form so the
// resource server's facilitator-support check passes.
const AVM_TESTNET_CAIP2 = `algorand:${ALGORAND_TESTNET_GENESIS_HASH}`;

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
const resourceServer = new x402ResourceServer(facilitatorClient);
resourceServer.register(AVM_TESTNET_CAIP2, new ServerExactAvmScheme());
await resourceServer.initialize();

// ── Step 2: Build Hono app with paymentMiddleware ─────────────────────────────
const app = new Hono();

app.use(
  paymentMiddleware(
    {
      "POST /ping": {
        accepts: [
          {
              scheme: "exact",
              price: "$0.001",
              network: AVM_TESTNET_CAIP2,
              payTo: receiverAddress,
              extra: { asset: USDC_TESTNET_ASA_ID },
          },
        ],
        description: "Local ping — x402 smoke test",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

app.post("/ping", (c) =>
  c.json({ pong: true, timestamp: new Date().toISOString() }),
);

// ── Step 3: Start the server ──────────────────────────────────────────────────
const server = serve(
  { fetch: app.fetch, port: PORT },
  () => console.log(`🚀 Local x402 server started on ${BASE_URL}`),
) as unknown as Server;

// Give the server 800ms to fully bind
await sleep(800);

// ── Step 4: Build paying client ───────────────────────────────────────────────
console.log("\n→ Building AVM signer...");
const account = algosdk.mnemonicToSecretKey(mnemonic);
const secretKeyB64 = Buffer.from(account.sk).toString("base64");
const avmSigner = toClientAvmSigner(secretKeyB64);
console.log("  Signer address:", avmSigner.address);

// The facilitator advertises the full genesis-hash network form, so register a
// wildcard pattern instead of the truncated ALGORAND_TESTNET_CAIP2 constant.
const client = new x402Client();
client.register("algorand:*", new ClientExactAvmScheme(avmSigner));
const payingFetch = wrapFetchWithPayment(fetch, client);

// ── Step 5: Make the paid request ─────────────────────────────────────────────
console.log("\n→ Paying client hitting POST /ping ...");
console.log("  (submits a real TestNet USDC transaction)");

let response: Response;
try {
  response = await payingFetch(`${BASE_URL}/ping`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("\n❌ Payment failed:", msg);
  console.error("\nCommon causes:");
  console.error("  - ALGO_RECEIVER_ADDRESS is not opted into USDC ASA (ID 10458941)");
  console.error("  - Payer account has insufficient USDC or ALGO");
  server.close();
  process.exit(1);
}

// ── Step 6: Read settlement ───────────────────────────────────────────────────
if (!response.ok) {
  const body = await response.text().catch(() => "(unreadable)");
  console.error(`\n❌ Response status ${response.status}: ${body}`);
  server.close();
  process.exit(1);
}

const paymentResponseHeader =
  response.headers.get("PAYMENT-RESPONSE") ??
  response.headers.get("payment-response") ??
  response.headers.get("X-PAYMENT-RESPONSE") ??
  response.headers.get("x-payment-response");

console.log("\n✅ Payment settled!");

if (paymentResponseHeader) {
  try {
    const paymentResponse = decodePaymentResponseHeader(paymentResponseHeader);
    console.log("\nPayment settlement details:");
    console.log(JSON.stringify(paymentResponse, null, 2));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type evolving
    const txId = (paymentResponse as any)?.transaction;
    if (txId) {
      console.log("\n🔗 Lora explorer link:");
      console.log(`   https://lora.algokit.io/testnet/transaction/${String(txId)}`);
    }
  } catch {
    console.log("  (could not decode PAYMENT-RESPONSE header)");
  }
}

const data: unknown = await response.json();
console.log("\n📦 Response body:");
console.log(JSON.stringify(data, null, 2));

// ── Step 7: Shut down ─────────────────────────────────────────────────────────
server.close();
console.log("\n✅ Script 4 passed — local x402 Hono server + client works on Algorand TestNet\n");

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

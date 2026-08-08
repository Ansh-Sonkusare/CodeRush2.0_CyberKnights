/**
 * Script 3: 03-pay-demo.ts
 *
 * Full end-to-end x402 payment on Algorand TestNet.
 * Pays for the GoPlausible demo /examples/weather endpoint using USDC.
 *
 * Flow:
 *   1. Build signer from ALGO_MNEMONIC via algosdk
 *   2. Register ExactAvmScheme (client) for Algorand TestNet
 *   3. wrapFetchWithPayment auto-handles 402 → sign → retry loop
 *   4. Print the real Algorand transaction ID + Lora explorer link
 *   5. Print the weather JSON response body
 *
 * Prerequisites (before running this script):
 *   - ALGO_MNEMONIC account must be funded with TestNet ALGO (for min-balance)
 *   - ALGO_MNEMONIC account must be opted into USDC TestNet ASA (ID 10458941)
 *   - ALGO_MNEMONIC account must hold TestNet USDC
 *   - Get TestNet ALGO:  https://lora.algokit.io/testnet/fund
 *   - Opt into USDC ASA: https://lora.algokit.io/testnet
 *   - Get TestNet USDC:  https://faucet.circle.com/ → select "Algorand Testnet"
 *
 * Usage:
 *   npx tsx 03-pay-demo.ts
 *   pnpm --filter @sentinel/scripts run 03-pay-demo
 */

import "dotenv/config";
import algosdk from "algosdk";
import { toClientAvmSigner, ALGORAND_TESTNET_CAIP2 } from "@x402/avm";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { x402Client, wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";

// ── Env check ─────────────────────────────────────────────────────────────────
const mnemonic = process.env.ALGO_MNEMONIC;
if (!mnemonic) {
  console.error("❌ ALGO_MNEMONIC is not set in .env");
  process.exit(1);
}

const DEMO_URL = "https://x402.goplausible.xyz/examples/weather";

console.log("\n=== 03-pay-demo ===");
console.log("Target URL:", DEMO_URL);
console.log("Network:   ", ALGORAND_TESTNET_CAIP2);
console.log();

// ── Build signer ──────────────────────────────────────────────────────────────
console.log("→ Building AVM signer from ALGO_MNEMONIC...");
const account = algosdk.mnemonicToSecretKey(mnemonic);
const secretKeyB64 = Buffer.from(account.sk).toString("base64");
const avmSigner = toClientAvmSigner(secretKeyB64);
console.log("  Signer address:", avmSigner.address);

// ── Build x402 client ─────────────────────────────────────────────────────────
// The facilitator advertises the full genesis-hash network form
// (e.g. "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI="), so register a
// wildcard pattern instead of the truncated ALGORAND_TESTNET_CAIP2 constant.
const client = new x402Client();
client.register("algorand:*", new ExactAvmScheme(avmSigner));

// ── Wrap fetch ────────────────────────────────────────────────────────────────
const payingFetch = wrapFetchWithPayment(fetch, client);

// ── Make the paid request ─────────────────────────────────────────────────────
console.log("→ Making paid request (submits a real TestNet USDC transaction)...");

let response: Response;
try {
  response = await payingFetch(DEMO_URL, { method: "GET" });
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("\n❌ Payment failed:", msg);
  console.error("\nCommon causes:");
  console.error("  - Account not funded with TestNet ALGO");
  console.error("    → https://lora.algokit.io/testnet/fund");
  console.error("  - Account not opted into USDC ASA (ID 10458941)");
  console.error("    → https://lora.algokit.io/testnet");
  console.error("  - Account has no TestNet USDC");
  console.error("    → https://faucet.circle.com/ (select Algorand Testnet)");
  process.exit(1);
}

if (!response.ok) {
  const body = await response.text().catch(() => "(unreadable body)");
  console.error(`\n❌ Request failed with status ${response.status}: ${body}`);
  process.exit(1);
}

// ── Read settlement info ──────────────────────────────────────────────────────
// The server returns a PAYMENT-RESPONSE header with base64-encoded JSON
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
} else {
  console.log("  (no PAYMENT-RESPONSE header found — settlement headers:", [...response.headers.keys()].join(", "), ")");
}

// ── Print response body ───────────────────────────────────────────────────────
const data: unknown = await response.json();
console.log("\n📦 Response body:");
console.log(JSON.stringify(data, null, 2));

console.log("\n✅ Script 3 passed — full end-to-end x402 payment on Algorand TestNet\n");

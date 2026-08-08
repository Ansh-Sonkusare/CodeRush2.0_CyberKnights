/**
 * Script 1: 01-check-signer.ts
 *
 * Derives an Algorand address from ALGO_MNEMONIC and prints it.
 * Verifies the mnemonic is valid and key derivation works with
 * @x402/avm v2.x toClientAvmSigner before wiring into the full stack.
 *
 * Key derivation path (verified against x402/avm source):
 *   algosdk.mnemonicToSecretKey(mnemonic)
 *     → { sk: Uint8Array(64), addr }   ← sk is 32-byte seed + 32-byte pubkey
 *   Buffer.from(sk).toString('base64')
 *     → base64-encoded 64-byte key
 *   toClientAvmSigner(base64Key)
 *     → { address, ... }
 *
 * Usage:
 *   npx tsx 01-check-signer.ts          (from repo root)
 *   pnpm --filter @sentinel/scripts run 01-check-signer
 *
 * Expected output:
 *   ✅ Signer address: WHUNA... (58-char Algorand address)
 */

import "dotenv/config";
import algosdk from "algosdk";
import { toClientAvmSigner } from "@x402/avm";

// ── Env check ────────────────────────────────────────────────────────────────
const mnemonic = process.env.ALGO_MNEMONIC;
const receiverAddress = process.env.ALGO_RECEIVER_ADDRESS;

if (!mnemonic) {
  console.error("❌ ALGO_MNEMONIC is not set in .env");
  process.exit(1);
}

console.log("\n=== 01-check-signer ===\n");

// ── Key derivation ─────────────────────────────────────────────────────────
// algosdk.mnemonicToSecretKey returns { sk: Uint8Array(64), addr: Address }
// sk is already the 32-byte Ed25519 seed concatenated with the 32-byte pubkey —
// exactly the 64-byte format that toClientAvmSigner expects as base64.
const account = algosdk.mnemonicToSecretKey(mnemonic);
const secretKeyB64 = Buffer.from(account.sk).toString("base64");

const avmSigner = toClientAvmSigner(secretKeyB64);

console.log("✅ Signer address derived:", avmSigner.address);
console.log("   algosdk addr:          ", account.addr.toString());
console.log(
  "   Addresses match:       ",
  avmSigner.address === account.addr.toString(),
);

if (receiverAddress) {
  console.log("\n📬 ALGO_RECEIVER_ADDRESS (from env):", receiverAddress);
  if (avmSigner.address === receiverAddress) {
    console.log(
      "   ℹ️  Payer and receiver are the same account — fine for testing",
    );
  }
} else {
  console.log("\n⚠️  ALGO_RECEIVER_ADDRESS not set — skipping match check");
}

console.log("\n✅ Script 1 passed — signer derivation works\n");

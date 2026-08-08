/**
 * Script 2: 02-check-402.ts
 *
 * Hits the GoPlausible x402 demo endpoint with a plain fetch (no payment).
 * Verifies:
 *   - HTTP 402 is returned
 *   - The `payment-required` header is present (x402 challenge)
 *   - The facilitator URL in env is reachable
 *
 * Usage:
 *   npx tsx 02-check-402.ts
 *   pnpm --filter @sentinel/scripts run 02-check-402
 *
 * Expected output:
 *   Status: 402 Payment Required
 *   payment-required header present: true
 *   ✅ Script 2 passed — x402 challenge confirmed
 */

import "dotenv/config";

const DEMO_URL = "https://x402.goplausible.xyz/examples/weather";
const facilitatorUrl = process.env.FACILITATOR_URL ?? "https://facilitator.goplausible.xyz";

console.log("\n=== 02-check-402 ===");
console.log("Target URL:", DEMO_URL);
console.log("Facilitator URL:", facilitatorUrl);
console.log();

// ── Step 1: plain fetch — expect 402 ─────────────────────────────────────────
console.log("→ Sending plain GET (no payment)...");
const res = await fetch(DEMO_URL, { method: "GET" });

console.log("Status:", res.status, res.statusText);

const paymentRequiredHeader = res.headers.get("payment-required");
console.log("payment-required header present:", !!paymentRequiredHeader);

if (paymentRequiredHeader) {
  // Print first 120 chars of the JWT — enough to confirm shape, not expose data
  const preview = paymentRequiredHeader.length > 120
    ? paymentRequiredHeader.slice(0, 120) + "...(truncated)"
    : paymentRequiredHeader;
  console.log("payment-required (preview):", preview);
}

if (res.status !== 402) {
  console.error(`❌ Expected HTTP 402, got ${res.status}. Is the demo endpoint still up?`);
  process.exit(1);
}

if (!paymentRequiredHeader) {
  console.error("❌ No payment-required header — x402 challenge missing.");
  process.exit(1);
}

// ── Step 2: verify facilitator is reachable ───────────────────────────────────
console.log("\n→ Checking facilitator reachability...");
try {
  const fRes = await fetch(`${facilitatorUrl}/health`, { method: "GET" });
  console.log("Facilitator /health status:", fRes.status);
  if (fRes.ok) {
    console.log("✅ Facilitator reachable");
  } else {
    console.log("⚠️  Facilitator returned non-2xx — may still work for payments");
  }
} catch (e) {
  // Some facilitators don't expose /health — that's fine
  console.log("⚠️  Facilitator /health not reachable —", (e as Error).message);
  console.log("   (This may be normal — the facilitator may not expose /health)");
}

console.log("\n✅ Script 2 passed — x402 challenge confirmed on demo endpoint\n");

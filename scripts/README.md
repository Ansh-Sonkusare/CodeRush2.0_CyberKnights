# x402 Algorand TestNet Smoke Scripts

Run these scripts in order. Each one validates one layer of the stack before
you move to full integration. **All scripts use real TestNet funds — never mainnet.**

## Prerequisites

1. **Two TestNet accounts** (payer + receiver). Create via [Lora](https://lora.algokit.io/testnet).
2. **Fund both with TestNet ALGO** via the [Lora faucet](https://lora.algokit.io/testnet/fund).
3. **Opt both into USDC TestNet ASA** via Lora (Asset ID: 10458941).
4. **Get TestNet USDC** from the [Circle faucet](https://faucet.circle.com/) — select "Algorand Testnet".
5. Set env vars in the root `.env`:
   ```
   ALGO_MNEMONIC="your 25-word payer mnemonic"
   ALGO_RECEIVER_ADDRESS="receiver Algorand address"
   FACILITATOR_URL=https://facilitator.goplausible.xyz
   ```

## Install

From repo root:
```bash
pnpm install
```

## Run scripts (from repo root)

```bash
# Script 1 — derive address, check mnemonic is valid
npx tsx scripts/01-check-signer.ts

# Script 2 — plain fetch → expect HTTP 402 from demo endpoint
npx tsx scripts/02-check-402.ts

# Script 3 — full payment against GoPlausible demo endpoint (uses real USDC)
npx tsx scripts/03-pay-demo.ts

# Script 4 — local Hono server with paymentMiddleware + paying client (uses real USDC)
npx tsx scripts/04-local-server-test.ts
```

Or with pnpm filter:
```bash
pnpm --filter @sentinel/scripts run 01-check-signer
pnpm --filter @sentinel/scripts run 02-check-402
pnpm --filter @sentinel/scripts run 03-pay-demo
pnpm --filter @sentinel/scripts run 04-local-server-test
```

## What each script proves

| Script | Validates |
|--------|-----------|
| `01-check-signer` | Mnemonic is valid; `toClientAvmSigner` produces a proper Algorand address |
| `02-check-402` | Demo endpoint returns HTTP 402 with `payment-required` header; facilitator is reachable |
| `03-pay-demo` | Full x402 flow works: signer → ExactAvmScheme → wrapFetchWithPayment → real USDC payment → real txId |
| `04-local-server-test` | Server-side `paymentMiddleware` works locally; full round-trip client+server on TestNet |

## Expected outputs

**Script 1:**
```
✅ Signer address derived: ABC123...XYZ
📬 Receiver address (from env): DEF456...
✅ Script 1 passed — signer derivation works
```

**Script 2:**
```
Status: 402 Payment Required
payment-required header present: true
✅ Script 2 passed — x402 challenge confirmed on demo endpoint
```

**Script 3:**
```
✅ Payment settled!
{ "success": true, "transaction": "ABCDEFG...", "network": "algorand:..." }
🔗 https://lora.algokit.io/testnet/transaction/ABCDEFG...
📦 Response body: { "report": { "weather": "sunny", ... } }
✅ Script 3 passed
```

**Script 4:**
```
🚀 Local x402 server started on http://localhost:4099
✅ Payment settled! 
🔗 https://lora.algokit.io/testnet/transaction/HIJKLMN...
📦 Response body: { "pong": true, "timestamp": "..." }
✅ Script 4 passed
```

## After scripts pass

Once all 4 scripts pass, the full stack integration is straightforward:
- `packages/x402-client` gets a real `AlgorandX402Client` (same code as scripts 3/4)
- `apps/service-providers` gets `@x402/hono` `paymentMiddleware` on provider routes (same as script 4)
- The ledger's `tx_ref` fields become real Algorand transaction IDs

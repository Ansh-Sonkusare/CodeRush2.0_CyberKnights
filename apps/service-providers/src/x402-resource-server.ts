import type { MiddlewareHandler } from "hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { paymentMiddlewareFromConfig } from "@x402/hono";
import type { AppConfig } from "@sentinel/config";

/**
 * In-process real x402 resource server (service-providers).
 *
 * Serves one protected resource per demo capability — GET /x402/wallet-data,
 * /x402/summary, /x402/credit-score — each behind a genuine x402 paywall backed
 * by the GoPlausible facilitator. Paying for one performs a REAL TestNet USDC
 * transaction (the orchestrator's AlgorandX402Client), unlike the mock
 * providers which only simulate settlement.
 *
 * This is a resource server, NOT a facilitator: the facilitator (GoPlausible)
 * does all verification and settlement. The facilitator advertises the full
 * genesis-hash network form for Algorand TestNet and a fee-payer address that
 * makes the payment gasless for the client.
 *
 * The response body is wallet-data-shaped (see walletDataPayload) so it passes
 * the WalletDataResponseSchema guard after payment — the whole point of the
 * demo is that a REAL paid response flows through the same guard as mocks.
 */

// Network exactly as the facilitator advertises it (full genesis-hash form —
// NOT the truncated ALGORAND_TESTNET_CAIP2 constant).
export const ALGORAND_TESTNET_NETWORK: `${string}:${string}` =
  "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";

// The facilitator's fee-payer address — also the USDC recipient (gasless).
const FACILITATOR_PAYEE =
  "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA";

export const X402_WALLET_DATA_PATH = "/x402/wallet-data";
export const X402_SUMMARY_PATH = "/x402/summary";
export const X402_CREDIT_SCORE_PATH = "/x402/credit-score";

/** Price in USDC for each protected resource (0.1 cent). */
export const X402_WALLET_DATA_PRICE = 0.001;
export const X402_SUMMARY_PRICE = 0.001;
export const X402_CREDIT_SCORE_PRICE = 0.001;

/** Wallet-data payload — must satisfy WalletDataResponseSchema (.strict()). */
export function walletDataPayload(walletAddress = "ALGO-TEST-000"): Record<string, string> {
  return {
    wallet_address: walletAddress,
    portfolio_value_usd: "1543.21",
    fetched_at: new Date().toISOString(),
  };
}

/** Summary payload — must satisfy SummaryResponseSchema (.strict()). */
export function summaryPayload(walletAddress = "ALGO-TEST-000"): Record<string, string> {
  return {
    summary: `Wallet ${walletAddress} holds a diversified portfolio with moderate on-chain activity over the last 30 days.`,
  };
}

/** Credit-score payload — must satisfy CreditScoreResponseSchema (.strict()). */
export function creditScorePayload(): Record<string, unknown> {
  return {
    score: 74,
    reasons: ["consistent on-chain activity", "healthy balance ratio"],
  };
}

/**
 * Build the x402 payment middleware for the protected wallet-data resource, or
 * return undefined if it cannot be constructed (log the reason — a missing
 * facilitator should not take down the providers service; x402 providers are a
 * demo feature on top of the mock set, not a boot requirement).
 */
export function createX402ResourceMiddleware(
  config: AppConfig,
): MiddlewareHandler | undefined {
  try {
    const facilitator = new HTTPFacilitatorClient({ url: config.facilitatorUrl });
    const routes = {
      [X402_WALLET_DATA_PATH]: {
        accepts: {
          scheme: "exact",
          payTo: FACILITATOR_PAYEE,
          price: X402_WALLET_DATA_PRICE,
          network: ALGORAND_TESTNET_NETWORK,
          maxTimeoutSeconds: 300,
        },
        description: "Algorand wallet portfolio data (paid)",
        mimeType: "application/json",
        outputSchema: {
          type: "object",
          properties: {
            wallet_address: { type: "string" },
            portfolio_value_usd: { type: "string" },
            fetched_at: { type: "string" },
          },
          required: ["wallet_address", "portfolio_value_usd", "fetched_at"],
        },
        serviceName: "sentinel-wallet-data",
      },
      [X402_SUMMARY_PATH]: {
        accepts: {
          scheme: "exact",
          payTo: FACILITATOR_PAYEE,
          price: X402_SUMMARY_PRICE,
          network: ALGORAND_TESTNET_NETWORK,
          maxTimeoutSeconds: 300,
        },
        description: "Algorand wallet summary (paid)",
        mimeType: "application/json",
        outputSchema: {
          type: "object",
          properties: {
            summary: { type: "string" },
          },
          required: ["summary"],
        },
        serviceName: "sentinel-summary",
      },
      [X402_CREDIT_SCORE_PATH]: {
        accepts: {
          scheme: "exact",
          payTo: FACILITATOR_PAYEE,
          price: X402_CREDIT_SCORE_PRICE,
          network: ALGORAND_TESTNET_NETWORK,
          maxTimeoutSeconds: 300,
        },
        description: "Algorand wallet credit score (paid)",
        mimeType: "application/json",
        outputSchema: {
          type: "object",
          properties: {
            score: { type: "integer" },
            reasons: { type: "array", items: { type: "string" } },
          },
          required: ["score", "reasons"],
        },
        serviceName: "sentinel-credit-score",
      },
    };
    return paymentMiddlewareFromConfig(
      routes,
      facilitator,
      [{ network: ALGORAND_TESTNET_NETWORK, server: new ExactAvmScheme() }],
      undefined,
      undefined,
    );
  } catch (cause) {
    console.warn(
      `[providers] x402 resource server unavailable: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    return undefined;
  }
}

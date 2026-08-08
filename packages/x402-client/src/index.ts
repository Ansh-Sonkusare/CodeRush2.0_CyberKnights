import algosdk from "algosdk";
import { toClientAvmSigner } from "@x402/avm";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import {
  x402Client,
  wrapFetchWithPayment,
  decodePaymentResponseHeader,
} from "@x402/fetch";
import {
  type Invoice,
  type PaymentError,
  type PaymentReceipt,
  type ScopedCapability,
  type ScopedCapabilityToken,
  err,
  idempotencyKey,
  ok,
  type Result,
} from "@sentinel/schemas";

export interface X402Client {
  issueCapability(capability: ScopedCapability): void;
  pay(
    capability: ScopedCapability,
    invoice: Invoice,
    providerUrl: string,
  ): Promise<Result<PaymentReceipt, PaymentError>>;
  payForResource(
    capability: ScopedCapability,
    providerUrl: string,
    invoice?: Invoice,
  ): Promise<Result<PaymentReceipt, PaymentError>>;
  /**
   * Return the resource content captured during the paid fetch for an invoice.
   * For a real x402 resource server the body of the paid response IS the
   * deliverable — this lets the provider adapter's deliver() hand back the
   * content without paying twice. Returns undefined when no paid fetch happened
   * for this invoice (e.g. simulated client, or the fetch body was unreadable).
   */
  getResourceContent(invoiceId: string): unknown | undefined;
}

// Re-export the 402-challenge header parser so provider adapters can build a
// quote from a real resource server without importing the x402 SDK directly.
export { decodePaymentRequiredHeader } from "@x402/core/http";
export type { PaymentRequired, PaymentRequirements } from "@x402/fetch";

/**
 * Simulated x402 client — never touches real funds.
 *
 * Guarantees (hackathon MVP):
 *  - Idempotent: paying the same capability+invoice twice returns the
 *    ORIGINAL receipt and never settles a second payment.
 *  - Scoped: only capabilities issued by the treasury are honoured, and
 *    the invoice amount can never exceed the capability's maxAmount.
 *  - `providerUrl` is recorded but not used — no network call is made.
 */
export class SimulatedX402Client implements X402Client {
  private settlements = new Map<string, PaymentReceipt>();
  private capabilities = new Map<ScopedCapabilityToken, ScopedCapability>();
  private txCounter = 0;

  issueCapability(capability: ScopedCapability): void {
    this.capabilities.set(capability.token, capability);
  }

  async pay(
    capability: ScopedCapability,
    invoice: Invoice,
    _providerUrl: string,
  ): Promise<Result<PaymentReceipt, PaymentError>> {
    const registered = this.capabilities.get(capability.token);
    if (!registered) {
      return err({
        kind: "scope_missing",
        message: `no capability "${capability.token}" has been issued — refusing to pay`,
      });
    }

    const key = idempotencyKey(registered.taskId, registered.nodeId, invoice.provider_id);
    const existing = this.settlements.get(key);
    if (existing) {
      return ok({ ...existing, firstPayment: false });
    }

    if (registered.providerId !== invoice.provider_id) {
      return err({
        kind: "provider_mismatch",
        message: `capability "${capability.token}" is scoped to ${registered.providerId}, cannot pay ${invoice.provider_id}`,
        idempotencyKey: key,
      });
    }
    if (invoice.amount > registered.maxAmount) {
      return err({
        kind: "scope_exceeded",
        message: `invoice amount ${invoice.amount} exceeds capability max ${registered.maxAmount}`,
        idempotencyKey: key,
      });
    }

    this.txCounter += 1;
    const receipt: PaymentReceipt = {
      idempotencyKey: key,
      txRef: `sim-${String(this.txCounter).padStart(4, "0")}`,
      simulated: true,
      amount: invoice.amount,
      providerId: invoice.provider_id,
      taskId: registered.taskId,
      nodeId: registered.nodeId,
      settledAt: new Date().toISOString(),
      firstPayment: true,
    };
    this.settlements.set(key, receipt);
    return ok(receipt);
  }

  async payForResource(
    capability: ScopedCapability,
    providerUrl: string,
    invoice?: Invoice,
  ): Promise<Result<PaymentReceipt, PaymentError>> {
    if (!invoice) {
      return err({
        kind: "unknown",
        message: `SimulatedX402Client.payForResource requires an invoice (capability "${capability.token}")`,
      });
    }
    return this.pay(capability, invoice, providerUrl);
  }

  getResourceContent(_invoiceId: string): unknown | undefined {
    // No network content is ever fetched in simulated mode — an x402 provider
    // routed through the simulated client simply has nothing to deliver.
    return undefined;
  }
}

// ─── Real Algorand x402 client ─────────────────────────────────────────────────
// The ONLY module that imports algosdk signing primitives. Everything else in
// the repo calls this package's typed, capability-scoped interface — a raw
// signer is never exported.
//
// The GoPlausible facilitator advertises networks in the full genesis-hash
// form ("algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI="), NOT the
// truncated ALGORAND_TESTNET_CAIP2 constant. The scheme is therefore
// registered under the wildcard "algorand:*" pattern; the SDK's
// normalizeAlgorandNetwork() maps the full-hash form onto the scheme.

export interface AlgorandX402ClientConfig {
  /** 25-word TestNet mnemonic. Never logged, never passed to any LLM. */
  mnemonic: string;
  /** Network pattern to register the AVM scheme under. Default "algorand:*". */
  networkPattern?: `${string}:${string}`;
  /** HTTP request init for the resource call (method/body/headers). Default GET. */
  requestInit?: RequestInit;
}

export class AlgorandX402Client implements X402Client {
  private settlements = new Map<string, PaymentReceipt>();
  private capabilities = new Map<ScopedCapabilityToken, ScopedCapability>();
  /** Paid response bodies keyed by invoice_id — consumed by provider deliver(). */
  private resources = new Map<string, unknown>();
  private payingFetch: ReturnType<typeof wrapFetchWithPayment>;
  private requestInit?: RequestInit;

  constructor(config: AlgorandX402ClientConfig) {
    const account = algosdk.mnemonicToSecretKey(config.mnemonic);
    const secretKeyB64 = Buffer.from(account.sk).toString("base64");
    const avmSigner = toClientAvmSigner(secretKeyB64);

    const client = new x402Client();
    client.register(config.networkPattern ?? "algorand:*", new ExactAvmScheme(avmSigner));
    this.payingFetch = wrapFetchWithPayment(fetch, client);
    if (config.requestInit) this.requestInit = config.requestInit;
  }

  issueCapability(capability: ScopedCapability): void {
    this.capabilities.set(capability.token, capability);
  }

  async pay(
    capability: ScopedCapability,
    invoice: Invoice,
    providerUrl: string,
  ): Promise<Result<PaymentReceipt, PaymentError>> {
    return this.payForResource(capability, providerUrl, invoice);
  }

  async payForResource(
    capability: ScopedCapability,
    providerUrl: string,
    invoice?: Invoice,
  ): Promise<Result<PaymentReceipt, PaymentError>> {
    const registered = this.capabilities.get(capability.token);
    if (!registered) {
      return err({
        kind: "scope_missing",
        message: `no capability "${capability.token}" has been issued — refusing to pay`,
      });
    }

    const key = idempotencyKey(registered.taskId, registered.nodeId, registered.providerId);
    const existing = this.settlements.get(key);
    if (existing) {
      return ok({ ...existing, firstPayment: false });
    }

    const providerId = invoice?.provider_id ?? registered.providerId;
    if (registered.providerId !== providerId) {
      return err({
        kind: "provider_mismatch",
        message: `capability "${capability.token}" is scoped to ${registered.providerId}, cannot pay ${providerId}`,
        idempotencyKey: key,
      });
    }
    const amount = invoice?.amount ?? registered.maxAmount;
    if (amount > registered.maxAmount) {
      return err({
        kind: "scope_exceeded",
        message: `invoice amount ${amount} exceeds capability max ${registered.maxAmount}`,
        idempotencyKey: key,
      });
    }

    let response: Response;
    try {
      response = await this.payingFetch(providerUrl, this.requestInit);
    } catch (cause) {
      return err({
        kind: "chain_error",
        message: `payment request failed for "${providerUrl}": ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        idempotencyKey: key,
      });
    }

    const paymentResponseHeader =
      response.headers.get("PAYMENT-RESPONSE") ??
      response.headers.get("payment-response") ??
      response.headers.get("X-PAYMENT-RESPONSE") ??
      response.headers.get("x-payment-response");

    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable body)");
      return err({
        kind: "chain_error",
        message: `provider "${providerUrl}" returned HTTP ${response.status}: ${body}`,
        idempotencyKey: key,
      });
    }
    if (!paymentResponseHeader) {
      return err({
        kind: "chain_error",
        message: `provider "${providerUrl}" settled without a PAYMENT-RESPONSE header — cannot verify the transaction`,
        idempotencyKey: key,
      });
    }

    let txRef: string;
    try {
      txRef = decodePaymentResponseHeader(paymentResponseHeader).transaction;
    } catch {
      return err({
        kind: "chain_error",
        message: `provider "${providerUrl}" returned an unparseable PAYMENT-RESPONSE header`,
        idempotencyKey: key,
      });
    }

    // Capture the paid response body: for a real x402 resource server this IS
    // the deliverable. Cache it by invoice id so the provider adapter's
    // deliver() can return it without a second (double-paying) request.
    if (invoice?.invoice_id) {
      const content: unknown = await response
        .json()
        .catch(() => response.text().catch(() => undefined));
      this.resources.set(invoice.invoice_id, content);
    }

    const receipt: PaymentReceipt = {
      idempotencyKey: key,
      txRef,
      simulated: false,
      amount,
      providerId,
      taskId: registered.taskId,
      nodeId: registered.nodeId,
      settledAt: new Date().toISOString(),
      firstPayment: true,
    };
    this.settlements.set(key, receipt);
    return ok(receipt);
  }

  getResourceContent(invoiceId: string): unknown | undefined {
    return this.resources.get(invoiceId);
  }
}

// ─── Factory ───────────────────────────────────────────────────────────────────

export interface CreateX402ClientOptions {
  /** "algorand" = real TestNet payments; "simulated" = in-memory, no funds. */
  mode: "algorand" | "simulated";
  /** Required for mode "algorand". */
  mnemonic?: string;
  /** Optional request init forwarded to the real client (method/body/headers). */
  requestInit?: RequestInit;
}

/**
 * Build the x402 client for the current deployment mode.
 * The simulated client is the safe default (no env vars, no funds);
 * pass `mode: "algorand"` plus a TestNet mnemonic to make real payments.
 */
export function createX402Client(options: CreateX402ClientOptions): X402Client {
  if (options.mode === "simulated") {
    return new SimulatedX402Client();
  }
  if (!options.mnemonic) {
    throw new Error('createX402Client: mode "algorand" requires a TestNet mnemonic');
  }
  return new AlgorandX402Client({
    mnemonic: options.mnemonic,
    ...(options.requestInit ? { requestInit: options.requestInit } : {}),
  });
}

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
  ): Result<PaymentReceipt, PaymentError>;
}

/**
 * Simulated x402 client — never touches real funds.
 *
 * Guarantees (hackathon MVP):
 *  - Idempotent: paying the same capability+invoice twice returns the
 *    ORIGINAL receipt and never settles a second payment.
 *  - Scoped: only capabilities issued by the treasury are honoured, and
 *    the invoice amount can never exceed the capability's maxAmount.
 *
 * This is the ONLY module allowed to import algosdk signing primitives —
 * it exposes a capability-scoped API, never a raw signer.
 */
export class SimulatedX402Client implements X402Client {
  private settlements = new Map<string, PaymentReceipt>();
  private capabilities = new Map<ScopedCapabilityToken, ScopedCapability>();
  private txCounter = 0;

  issueCapability(capability: ScopedCapability): void {
    this.capabilities.set(capability.token, capability);
  }

  pay(
    capability: ScopedCapability,
    invoice: Invoice,
  ): Result<PaymentReceipt, PaymentError> {
    const registered = this.capabilities.get(capability.token);
    if (!registered) {
      return err({
        kind: "scope_missing",
        message: `no capability "${capability.token}" has been issued — refusing to pay`,
      });
    }

    const key = idempotencyKey(registered.taskId, registered.nodeId, invoice.invoice_id);
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
}

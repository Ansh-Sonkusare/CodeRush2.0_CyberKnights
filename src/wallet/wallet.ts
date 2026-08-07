import {
  PaymentRequest,
  ScopeToken,
  SettlementRecord,
} from "../types.js";

let txCounter = 0;

function nextTxRef(): string {
  txCounter += 1;
  return `sim-${String(txCounter).padStart(4, "0")}`;
}

/**
 * Simulated wallet. Never touches real funds.
 *
 * Guarantees (hackathon MVP):
 *  - Idempotent: re-sending the same idempotency_key returns the ORIGINAL
 *    settlement and never settles a second payment.
 *  - Scoped: every payment carries a scope token ("pay up to X for provider Y")
 *    and the wallet refuses to pay beyond that scope.
 */
export class SimulatedWallet {
  private settlements = new Map<string, SettlementRecord>();
  private scopes = new Map<string, ScopeToken>();

  ensureScope(scopeToken: string, providerId: string, maxAmount: number): ScopeToken {
    const existing = this.scopes.get(scopeToken);
    if (existing) return existing;
    const scope: ScopeToken = {
      provider_id: providerId,
      max_amount: maxAmount,
      spent: 0,
    };
    this.scopes.set(scopeToken, scope);
    return scope;
  }

  getScope(scopeToken: string): ScopeToken | undefined {
    return this.scopes.get(scopeToken);
  }

  hasSettlement(idempotencyKey: string): boolean {
    return this.settlements.has(idempotencyKey);
  }

  getSettlement(idempotencyKey: string): SettlementRecord | undefined {
    return this.settlements.get(idempotencyKey);
  }

  /**
   * Attempts a payment. Idempotent per idempotency_key.
   * Returns either the newly-created settlement or the existing one.
   */
  pay(req: PaymentRequest): SettlementRecord {
    const existing = this.settlements.get(req.idempotency_key);
    if (existing) {
      return { ...existing, first_payment: false };
    }

    const scope = this.scopes.get(req.scope_token);
    if (!scope) {
      throw new Error(
        `wallet: no scope token "${req.scope_token}" registered — refusing to pay`,
      );
    }
    if (scope.provider_id !== req.provider_id) {
      throw new Error(
        `wallet: scope "${req.scope_token}" is for ${scope.provider_id}, ` +
          `cannot pay ${req.provider_id}`,
      );
    }
    if (scope.spent + req.amount > scope.max_amount) {
      throw new Error(
        `wallet: scope exceeded (${scope.spent} + ${req.amount} > ${scope.max_amount}) — refusing to pay`,
      );
    }

    scope.spent += req.amount;

    const record: SettlementRecord = {
      idempotency_key: req.idempotency_key,
      tx_ref: nextTxRef(),
      amount: req.amount,
      provider_id: req.provider_id,
      task_id: req.task_id,
      node_id: req.node_id,
      scope_token: req.scope_token,
      settled_at: new Date().toISOString(),
      first_payment: true,
    };
    this.settlements.set(req.idempotency_key, record);
    return record;
  }
}

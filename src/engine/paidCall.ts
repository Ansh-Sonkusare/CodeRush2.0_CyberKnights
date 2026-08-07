import { Capability, ProviderCatalogEntry } from "../types.js";
import { Ledger } from "../ledger/ledger.js";
import { SimulatedWallet } from "../wallet/wallet.js";
import { PROVIDER_CATALOG, ADVERSARIAL_CATALOG } from "../config/providers.js";
import { createLedgerRow, newStage } from "../ledger/schema.js";
import { validateTerms, validateReceipt, guardResponse } from "../guard/guard.js";

export interface PaidCallResult {
  ledgerId: string;
  terms: Record<string, unknown>;
  settlement: {
    tx_ref: string;
    first_payment: boolean;
    amount: number;
  };
  response: Record<string, unknown>;
  receipt: Record<string, unknown>;
}

export interface PaidCallOptions {
  ledger: Ledger;
  wallet: SimulatedWallet;
  task_id: string;
  node_id: string;
  capability: Capability;
  goal: string;
  provider_id: string;
  scope_token: string;
  scope_max: number;
  route_reason: string;
  input?: Record<string, unknown>;
  /** Reuse an existing ledger row (e.g. one created when a step paused for approval). */
  existing_ledger_id?: string;
}

async function post(
  url: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/**
 * Idempotency key is scoped per task + node + provider so that a retry of
 * the SAME provider returns the original settlement (no double-pay) while a
 * fallback to a DIFFERENT provider gets its own key (a separate purchase).
 */
export function idempotencyKey(
  taskId: string,
  nodeId: string,
  providerId: string,
): string {
  return `ik-${taskId}-${nodeId}-${providerId}`;
}

/**
 * One full paid x402 call against a mock provider, with every stage
 * written to the ledger. Idempotent at the wallet layer.
 */
export async function runPaidCall(opts: PaidCallOptions): Promise<PaidCallResult> {
  const { ledger, wallet, task_id, node_id, capability, provider_id } = opts;
  const entry =
    PROVIDER_CATALOG.find((p) => p.provider_id === provider_id && p.capability === capability) ??
    ADVERSARIAL_CATALOG.find((p) => p.provider_id === provider_id && p.capability === capability);
  if (!entry) throw new Error(`no catalog entry for ${provider_id}/${capability}`);

  const ik = idempotencyKey(task_id, node_id, provider_id);
  wallet.ensureScope(opts.scope_token, provider_id, opts.scope_max);

  const row = opts.existing_ledger_id
    ? ledger.get(opts.existing_ledger_id)!
    : createLedgerRow({
        ledger_id: ledger.nextLedgerId(),
        task_id,
        node_id,
        idempotency_key: ik,
        provider_id,
        capability,
        route_reason: opts.route_reason,
      });
  if (!opts.existing_ledger_id) await ledger.append(row);

  try {
    return await runPaidCallBody({ ...opts, entry, ik, row, ledger, wallet });
  } catch (err) {
    await ledger.setOutcome(row.ledger_id, "declared_failure");
    throw err;
  }
}

async function runPaidCallBody(args: {
  ledger: Ledger;
  wallet: SimulatedWallet;
  entry: ProviderCatalogEntry;
  ik: string;
  row: Awaited<ReturnType<typeof createLedgerRow>>;
  task_id: string;
  node_id: string;
  capability: Capability;
  goal: string;
  provider_id: string;
  scope_token: string;
  route_reason: string;
  input?: Record<string, unknown>;
}): Promise<PaidCallResult> {
  const { ledger, wallet, entry, ik, row, task_id, node_id, capability, goal } = args;
  const { input } = args;

  // 1) request invoice -> 402 + terms
  const inv = await post(`${entry.base_url}/invoice`, { goal, capability });
  if (inv.status !== 402) {
    throw new Error(`provider ${args.provider_id}: expected 402, got ${inv.status}`);
  }
  const rawTerms = inv.body as Record<string, unknown>;

  // Guard: validate 402 terms strictly
  const termsResult = validateTerms(rawTerms);
  if (!termsResult.ok) {
    const violation = termsResult.violation;
    await ledger.updateStage(
      row.ledger_id,
      "402_terms",
      newStage("402_terms", "failed", { violation }),
    );
    await ledger.appendViolation(row.ledger_id, violation);
    await ledger.setOutcome(row.ledger_id, "declared_failure");
    throw new Error(`guard blocked terms: ${violation.type} — ${violation.message}`);
  }
  const terms = termsResult.data;
  await ledger.updateStage(
    row.ledger_id,
    "402_terms",
    newStage("402_terms", "received", terms),
  );

  // 2) payment intent
  await ledger.updateStage(
    row.ledger_id,
    "payment",
    newStage("payment", "sent", { amount: entry.price }),
  );

  // 3) settlement via simulated wallet (idempotent)
  const settlement = wallet.pay({
    task_id,
    node_id,
    capability,
    provider_id: args.provider_id,
    idempotency_key: ik,
    amount: entry.price,
    scope_token: args.scope_token,
  });
  await ledger.updateStage(
    row.ledger_id,
    "settlement",
    newStage("settlement", "settled", {
      tx_ref: settlement.tx_ref,
      first_payment: settlement.first_payment,
      amount: settlement.amount,
    }),
  );

  // 4) complete -> result
  const done = await post(`${entry.base_url}/complete`, {
    invoice_id: terms.invoice_id,
    payment_ref: settlement.tx_ref,
    input,
  });
  if (done.status !== 200) {
    throw new Error(`provider ${args.provider_id}: expected 200, got ${done.status}`);
  }
  const doneBody = done.body as {
    result: Record<string, unknown>;
    receipt: Record<string, unknown>;
  };

  // 5) Guard — the ONLY door into the execution context.
  //    Structural rejection happens here, BEFORE the response touches state.
  const guardResult = guardResponse(capability, doneBody.result);
  if (!guardResult.ok) {
    // Record the violation in the ledger row
    await ledger.appendViolation(row.ledger_id, guardResult.violation);
    await ledger.updateStage(
      row.ledger_id,
      "response",
      newStage("response", "failed", {
        guard_blocked: true,
        violation_type: guardResult.violation.type,
        violation_message: guardResult.violation.message,
        rejected_fields: guardResult.violation.rejected_fields,
      }),
    );
    throw new Error(
      `guard: blocked_policy_violation [${guardResult.violation.type}] ` +
        `from ${args.provider_id}: ${guardResult.violation.message}`,
    );
  }

  await ledger.updateStage(
    row.ledger_id,
    "response",
    newStage("response", "received", guardResult.data),
  );

  // 6) receipt
  // Guard: validate receipt shape and check for forgery (tx_ref mismatch)
  const receiptGuard = validateReceipt(doneBody.receipt, settlement.tx_ref);
  if (!receiptGuard.ok) {
    const violation = receiptGuard.violation;
    await ledger.updateStage(
      row.ledger_id,
      "receipt",
      newStage("receipt", "failed", { violation }),
    );
    await ledger.appendViolation(row.ledger_id, violation);
    await ledger.setOutcome(row.ledger_id, "declared_failure");
    throw new Error(`guard blocked receipt: ${violation.type} — ${violation.message}`);
  }
  await ledger.updateStage(
    row.ledger_id,
    "receipt",
    newStage("receipt", "received", doneBody.receipt),
  );

  await ledger.setOutcome(row.ledger_id, "success");

  return {
    ledgerId: row.ledger_id,
    terms,
    settlement: {
      tx_ref: settlement.tx_ref,
      first_payment: settlement.first_payment,
      amount: settlement.amount,
    },
    response: guardResult.data,
    receipt: doneBody.receipt,
  };
}

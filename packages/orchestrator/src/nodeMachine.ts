import { assign, createActor, fromPromise, setup, toPromise } from "xstate";
import {
  CAPABILITY_RESPONSE_SCHEMAS,
  idempotencyKey,
  microAlgo,
  microAlgoFromNumber,
  newStage,
  taskNodeId,
  type Capability,
  type Invoice,
  type MicroAlgo,
  type NodeState,
  type PauseInfo,
  type PaymentReceipt,
  type PolicyViolation,
  type QuoteResponse,
  type RouteDecision,
  type TaskId,
  type TaskStep,
} from "@sentinel/schemas";
import { guardResponse, validateReceipt } from "@sentinel/policy-guard";
import type { OrchestratorDeps } from "./types.js";

/**
 * NodeMachine — one XState actor per task node.
 *
 * ```
 * pending → routing ⇄ routing(on fallback) → quoted → paying → paid → validating
 *    ↘ waiting_approval (budget — task pauses for approval)
 *    ↘ failed (no provider / transport)
 *                                          validating ↘ settled | blocked(guard) | (fallback)
 * ```
 *
 * The observable NodeState (NodeStateSchema discriminated union) is emitted via
 * the `broadcast` callback at every transition — the same type the TaskMachine,
 * the status endpoints, and the gateway WS hub consume. `routing`/`quoted`/
 * `paid` are internal machine states; the pending/quoted/paying/paid/validating
 * NodeState kinds are the contract.
 *
 * Trust boundary: no provider response ever touches treasury/ledger state
 * without passing guardResponse (strict schema) + validateReceipt (receipt
 * forgery) first. Idempotency keys are provider-scoped and generated once per
 * (task, node, provider) — a retry of the same provider can never double-pay.
 */

// ─── Signal contract with the TaskMachine ─────────────────────────────────────
// NodeState is for the observable graph; needs_approval carries the budget
// pause info upward (the NodeState union has no "paused" member — pausing is a
// task-level state).

export type NodeSignal =
  | { kind: "node_state"; state: NodeState }
  | { kind: "needs_approval"; pauseInfo: PauseInfo };

export interface NodeInput {
  taskId: TaskId;
  node: TaskStep;
  goal: string;
  /** Upstream node outputs (assembled by the TaskRunner from deps). */
  input: Record<string, unknown>;
  deps: OrchestratorDeps;
  initialDecision: RouteDecision;
  broadcast: (signal: NodeSignal) => void;
}

export interface NodeOutput {
  nodeState?: NodeState;
  result?: Record<string, unknown>;
  error?: string;
  ledgerId?: string;
  pauseInfo?: PauseInfo;
}

interface NodeContext {
  taskId: TaskId;
  nodeId: string;
  capability: Capability;
  goal: string;
  upstreamInput: Record<string, unknown>;
  deps: OrchestratorDeps;
  broadcast: (signal: NodeSignal) => void;
  decision: RouteDecision;
  excluded: string[];
  nodeState: NodeState;
  quote: QuoteResponse | undefined;
  amount: MicroAlgo;
  ledgerId: string | undefined;
  idempotencyKeyValue: string | undefined;
  txRef: string | undefined;
  simulated: boolean | undefined;
  violation: PolicyViolation | undefined;
  result: Record<string, unknown> | undefined;
  error: string | undefined;
  attempts: string[];
  pauseInfo: PauseInfo | undefined;
}

// ─── Phase 1: select + quote + reserve ────────────────────────────────────────
// Route (initial decision, falling back with exclusions) → quote → reserve →
// create the ledger row (once per provider). Returns ok, retry-with-provider-
// excluded (quote/transport error), needs_approval (budget — no silent
// overspend), or failed (no candidate left).

export interface SelectAndQuoteInput {
  taskId: TaskId;
  nodeId: string;
  capability: Capability;
  goal: string;
  deps: OrchestratorDeps;
  excluded: string[];
  initialDecision: RouteDecision;
}

export type SelectAndQuoteOutput =
  | {
      kind: "ok";
      decision: RouteDecision;
      quote: QuoteResponse;
      amount: MicroAlgo;
      ledgerId: string;
      idempotencyKeyValue: string;
    }
  | { kind: "retry"; providerId: string; reason: string }
  | { kind: "needs_approval"; pauseInfo: PauseInfo }
  | { kind: "failed"; error: string };

async function selectAndQuote({
  input,
}: {
  input: SelectAndQuoteInput;
}): Promise<SelectAndQuoteOutput> {
  const { taskId, nodeId, capability, goal, deps, excluded, initialDecision } = input;

  let decision = initialDecision;
  if (excluded.includes(decision.adapter.providerId)) {
    const picked = deps.router.select(capability, excluded);
    if (!picked.ok) {
      return {
        kind: "failed",
        error: `no provider for "${capability}": ${picked.error.message}`,
      };
    }
    decision = picked.value;
  }

  const quoteRes = await decision.adapter.quote(goal);
  if (!quoteRes.ok) {
    return { kind: "retry", providerId: decision.adapter.providerId, reason: quoteRes.error.message };
  }

  const amount = microAlgoFromNumber(quoteRes.value.price);
  const reserve = deps.treasury.reserve(taskNodeId(nodeId), amount);
  if (reserve.kind === "needs_approval") {
    return {
      kind: "needs_approval",
      pauseInfo: {
        nodeIds: [nodeId],
        amounts: [amount],
        overspend: reserve.overspend,
        projected: reserve.projected,
        cap: reserve.cap,
      },
    };
  }

  const idempotencyKeyValue = idempotencyKey(taskId, nodeId, decision.adapter.providerId);
  const row = await deps.ledger.insert({
    task_id: taskId,
    node_id: nodeId,
    idempotency_key: idempotencyKeyValue,
    provider_id: decision.adapter.providerId,
    capability,
    route_reason: decision.reason,
  });
  await deps.ledger.updateStage(
    row.ledger_id,
    newStage("402_terms", "received", { ...quoteRes.value }),
  );

  return {
    kind: "ok",
    decision,
    quote: quoteRes.value,
    amount,
    ledgerId: row.ledger_id,
    idempotencyKeyValue,
  };
}

// ─── Phase 2: pay ─────────────────────────────────────────────────────────────
// Issue a scoped capability (treasury owns the scope), then settle via the
// x402 client. Payment errors release the reservation + mark the row
// declared_failure, and the provider is excluded for a fallback.

export interface PayInput {
  nodeId: string;
  capability: Capability;
  ledgerId: string;
  idempotencyKeyValue: string;
  quote: QuoteResponse;
  amount: MicroAlgo;
  /** Where to actually perform the payment against (the x402 resource server). */
  providerUrl: string;
  deps: OrchestratorDeps;
  /** The routed adapter — its scheme/uptoActual/failMode metadata shape the payment. */
  adapter: RouteDecision["adapter"];
}

export type PayOutput =
  | { kind: "ok"; receipt: PaymentReceipt }
  | { kind: "retry"; providerId: string; reason: string };

/** A quote whose terms have already expired is never paid — exclude + re-route. */
function isStaleQuote(quote: QuoteResponse, now: number = Date.now()): boolean {
  const expires = new Date(quote.terms_expires_at).getTime();
  return Number.isFinite(expires) && expires <= now;
}

/** True when the quoted price exceeds the advertised hint by more than 25%. */
function isPriceDrift(amount: MicroAlgo, hint: MicroAlgo): boolean {
  return hint > 0n && amount > (hint * 125n) / 100n;
}

async function payInvoice({ input }: { input: PayInput }): Promise<PayOutput> {
  const { nodeId, capability, ledgerId, idempotencyKeyValue, quote, amount, providerUrl, deps, adapter } = input;

  // Stale-quote guard: a provider whose terms have expired cannot be paid. The
  // quote is refused (not paid), the reservation released, the row declared a
  // failure, and the provider excluded for a fallback — exactly the pay-failure
  // path, but without ever sending a transaction.
  if (isStaleQuote(quote)) {
    deps.treasury.release(taskNodeId(nodeId));
    await deps.ledger.updateStage(
      ledgerId,
      newStage("payment", "failed", {
        reason: "stale_quote",
        terms_expires_at: quote.terms_expires_at,
      }),
    );
    await deps.ledger.setOutcome(ledgerId, "declared_failure");
    return {
      kind: "retry",
      providerId: quote.provider_id,
      reason: `${quote.provider_id}: quote expired (terms_expires_at ${quote.terms_expires_at})`,
    };
  }

  // Price-drift guard: a quote >25% above the advertised hint is refused the
  // same way — no payment, reservation released, provider excluded for a
  // fallback. priceHint is indicative, so small deltas are tolerated; a 25%
  // overshoot is treated as the provider misquoting.
  if (isPriceDrift(amount, adapter.priceHint)) {
    deps.treasury.release(taskNodeId(nodeId));
    await deps.ledger.updateStage(
      ledgerId,
      newStage("payment", "failed", {
        reason: "price_drift",
        quoted: amount.toString(),
        hinted: adapter.priceHint.toString(),
      }),
    );
    await deps.ledger.setOutcome(ledgerId, "declared_failure");
    return {
      kind: "retry",
      providerId: quote.provider_id,
      reason: `${quote.provider_id}: quote ${amount}uAlgo exceeds price hint ${adapter.priceHint}uAlgo by >25%`,
    };
  }

  const invoice: Invoice = {
    invoice_id: quote.invoice_id,
    provider_id: quote.provider_id,
    capability,
    amount,
    currency: quote.currency,
    schema: quote.schema,
    terms_expires_at: quote.terms_expires_at,
    payment_required: quote.payment_required,
  };
  // Payment-scheme metadata from the routed adapter: "upto" invoices settle at
  // the actual spend (uptoActual ≤ quoted) rather than the quoted amount.
  if (adapter.scheme !== undefined) invoice.scheme = adapter.scheme;
  if (adapter.uptoActual !== undefined) invoice.uptoActual = adapter.uptoActual;

  const cap = deps.treasury.issueCapability(taskNodeId(nodeId), quote.provider_id, amount);
  deps.x402.issueCapability(cap);

  await deps.ledger.updateStage(
    ledgerId,
    newStage("payment", "sent", {
      amount: amount.toString(),
      idempotency_key: idempotencyKeyValue,
    }),
  );

  // MVD "fail after 402" demo knob: the provider's 402 challenge succeeds, but
  // the payment itself fails (facilitator outage after the challenge). The
  // one-shot knob is armed only for this provider's next payment; the pay
  // failure path below releases + declares + re-routes.
  if (adapter.failMode === "after_402") {
    deps.x402.failNextPayment(quote.provider_id);
  }

  const payRes = await deps.x402.pay(cap, invoice, providerUrl);
  if (!payRes.ok) {
    deps.treasury.release(taskNodeId(nodeId));
    await deps.ledger.setOutcome(ledgerId, "declared_failure");
    return { kind: "retry", providerId: quote.provider_id, reason: payRes.error.message };
  }

  await deps.ledger.updateStage(
    ledgerId,
    newStage("settlement", "settled", {
      tx_ref: payRes.value.txRef,
      first_payment: payRes.value.firstPayment,
      amount: amount.toString(),
      ...(payRes.value.scheme !== undefined ? { scheme: payRes.value.scheme } : {}),
      ...(payRes.value.actualAmount !== undefined
        ? { actual_amount: payRes.value.actualAmount.toString() }
        : {}),
    }),
  );

  return { kind: "ok", receipt: payRes.value };
}

// ─── Phase 3: deliver + validate ──────────────────────────────────────────────
// The ONLY door through which a provider response reaches treasury/ledger:
// strict schema parse (guardResponse) then receipt-forgery check
// (validateReceipt). Guard/receipt failures block the node; transport errors
// release + exclude the provider for a fallback.

export interface DeliverInput {
  nodeId: string;
  ledgerId: string;
  capability: Capability;
  invoiceId: string;
  providerId: string;
  txRef: string;
  input: Record<string, unknown>;
  deps: OrchestratorDeps;
  adapter: RouteDecision["adapter"];
}

export type DeliverOutput =
  | { kind: "ok"; result: Record<string, unknown> }
  | { kind: "blocked"; violation: PolicyViolation }
  | { kind: "retry"; providerId: string; reason: string };

async function deliverAndValidate({
  input,
}: {
  input: DeliverInput;
}): Promise<DeliverOutput> {
  const {
    nodeId,
    ledgerId,
    capability,
    invoiceId,
    providerId,
    txRef,
    input: upstream,
    deps,
    adapter,
  } = input;

  const deliverRes = await adapter.deliver(invoiceId, txRef, upstream);
  if (!deliverRes.ok) {
    deps.treasury.release(taskNodeId(nodeId));
    await deps.ledger.setOutcome(ledgerId, "declared_failure");
    return { kind: "retry", providerId, reason: deliverRes.error.message };
  }

  const { result, receipt } = deliverRes.value;

  const guard = guardResponse(CAPABILITY_RESPONSE_SCHEMAS[capability], result);
  if (!guard.ok) {
    await deps.ledger.appendViolation(ledgerId, guard.violation);
    await deps.ledger.updateStage(
      ledgerId,
      newStage("response", "failed", {
        guard_blocked: true,
        violation_type: guard.violation.type,
        rejected_fields: guard.violation.rejected_fields,
      }),
    );
    await deps.ledger.setOutcome(ledgerId, "declared_failure");
    return { kind: "blocked", violation: guard.violation };
  }

  await deps.ledger.updateStage(ledgerId, newStage("response", "received", guard.data));

  const receiptGuard = validateReceipt(receipt, txRef);
  if (!receiptGuard.ok) {
    await deps.ledger.appendViolation(ledgerId, receiptGuard.violation);
    await deps.ledger.updateStage(
      ledgerId,
      newStage("receipt", "failed", {
        violation_type: receiptGuard.violation.type,
        rejected_fields: receiptGuard.violation.rejected_fields,
      }),
    );
    await deps.ledger.setOutcome(ledgerId, "declared_failure");
    return { kind: "blocked", violation: receiptGuard.violation };
  }

  await deps.ledger.updateStage(ledgerId, newStage("receipt", "received", receiptGuard.data));

  deps.treasury.settle(taskNodeId(nodeId));
  await deps.ledger.setOutcome(ledgerId, "success");

  return { kind: "ok", result: guard.data };
}

// ─── Machine ──────────────────────────────────────────────────────────────────

export const nodeMachine = setup({
  types: {
    context: {} as NodeContext,
    input: {} as NodeInput,
    output: {} as NodeOutput,
  },
  actors: {
    selectAndQuote: fromPromise(selectAndQuote),
    payInvoice: fromPromise(payInvoice),
    deliverAndValidate: fromPromise(deliverAndValidate),
  },
}).createMachine({
  id: "nodeMachine",
  context: ({ input }) => ({
    taskId: input.taskId,
    nodeId: input.node.id,
    capability: input.node.capability,
    goal: input.goal,
    upstreamInput: input.input,
    deps: input.deps,
    broadcast: input.broadcast,
    decision: input.initialDecision,
    excluded: [] as string[],
    nodeState: { kind: "pending" } as NodeState,
    quote: undefined,
    amount: microAlgo(0n),
    ledgerId: undefined,
    idempotencyKeyValue: undefined,
    txRef: undefined,
    simulated: undefined,
    violation: undefined,
    result: undefined,
    error: undefined,
    attempts: [] as string[],
    pauseInfo: undefined,
  }),
  output: ({ context }): NodeOutput => {
    if (context.pauseInfo) return { pauseInfo: context.pauseInfo };
    const out: NodeOutput = { nodeState: context.nodeState };
    if (context.result) out.result = context.result;
    if (context.ledgerId) out.ledgerId = context.ledgerId;
    if (context.error) out.error = context.error;
    return out;
  },
  initial: "pending",
  states: {
    pending: {
      entry: ({ context }) => context.broadcast({ kind: "node_state", state: { kind: "pending" } }),
      always: { target: "routing" },
    },

    routing: {
      invoke: {
        id: "selectAndQuote",
        src: "selectAndQuote",
        input: ({ context }) => ({
          taskId: context.taskId,
          nodeId: context.nodeId,
          capability: context.capability,
          goal: context.goal,
          deps: context.deps,
          excluded: context.excluded,
          initialDecision: context.decision,
        }),
        onDone: [
          {
            guard: ({ event }) => event.output.kind === "ok",
            target: "quoted",
            actions: [
              assign(({ event }) => {
                if (event.output.kind !== "ok") return {};
                return {
                  decision: event.output.decision,
                  quote: event.output.quote,
                  amount: event.output.amount,
                  ledgerId: event.output.ledgerId,
                  idempotencyKeyValue: event.output.idempotencyKeyValue,
                };
              }),
              ({ context, event }) => {
                if (event.output.kind !== "ok") return;
                context.broadcast({
                  kind: "node_state",
                  state: {
                    kind: "quoted",
                    invoiceId: event.output.quote.invoice_id,
                    providerId: event.output.decision.adapter.providerId,
                    priceHint: event.output.amount,
                  },
                });
              },
            ],
          },
          {
            guard: ({ event }) => event.output.kind === "retry",
            target: "routing",
            reenter: true,
            actions: [
              assign(({ context, event }) => {
                if (event.output.kind !== "retry") return {};
                return {
                  excluded: [...context.excluded, event.output.providerId],
                  attempts: [...context.attempts, event.output.reason],
                  error: event.output.reason,
                };
              }),
            ],
          },
          {
            guard: ({ event }) => event.output.kind === "needs_approval",
            target: "waiting_approval",
            actions: [
              assign(({ event }) => {
                if (event.output.kind !== "needs_approval") return {};
                return { pauseInfo: event.output.pauseInfo };
              }),
              ({ context, event }) => {
                if (event.output.kind !== "needs_approval") return;
                context.broadcast({ kind: "needs_approval", pauseInfo: event.output.pauseInfo });
              },
            ],
          },
          {
            guard: ({ event }) => event.output.kind === "failed",
            target: "failed",
            actions: [
              assign(({ event }) => {
                if (event.output.kind !== "failed") return {};
                return { error: event.output.error };
              }),
              ({ context, event }) => {
                if (event.output.kind !== "failed") return;
                context.broadcast({
                  kind: "node_state",
                  state: { kind: "failed", error: event.output.error, providerId: context.decision.adapter.providerId },
                });
              },
            ],
          },
        ],
        onError: {
          target: "failed",
          actions: [
            assign(({ event }) => {
              const message = event.error instanceof Error ? event.error.message : String(event.error);
              return { error: message };
            }),
            ({ context, event }) => {
              const message = event.error instanceof Error ? event.error.message : String(event.error);
              context.broadcast({
                kind: "node_state",
                state: { kind: "failed", error: message, providerId: context.decision.adapter.providerId },
              });
            },
          ],
        },
      },
    },

    quoted: {
      always: { target: "paying" },
    },

    paying: {
      entry: ({ context }) =>
        context.broadcast({
          kind: "node_state",
          state: {
            kind: "paying",
            idempotencyKey: context.idempotencyKeyValue ?? "",
            providerId: context.decision.adapter.providerId,
          },
        }),
      invoke: {
        id: "payInvoice",
        src: "payInvoice",
        input: ({ context }) => ({
          nodeId: context.nodeId,
          capability: context.capability,
          ledgerId: context.ledgerId as string,
          idempotencyKeyValue: context.idempotencyKeyValue as string,
          quote: context.quote as QuoteResponse,
          amount: context.amount,
          providerUrl: context.decision.adapter.baseUrl,
          deps: context.deps,
          adapter: context.decision.adapter,
        }),
        onDone: [
          {
            guard: ({ event }) => event.output.kind === "ok",
            target: "paid",
            actions: [
              assign(({ event }) => {
                if (event.output.kind !== "ok") return {};
                return { txRef: event.output.receipt.txRef, simulated: event.output.receipt.simulated };
              }),
              ({ context, event }) => {
                if (event.output.kind !== "ok") return;
                context.broadcast({
                  kind: "node_state",
                  state: {
                    kind: "paid",
                    txRef: event.output.receipt.txRef,
                    simulated: event.output.receipt.simulated,
                    providerId: event.output.receipt.providerId,
                  },
                });
              },
            ],
          },
          {
            guard: ({ event }) => event.output.kind === "retry",
            target: "routing",
            reenter: true,
            actions: [
              assign(({ context, event }) => {
                if (event.output.kind !== "retry") return {};
                return {
                  excluded: [...context.excluded, event.output.providerId],
                  attempts: [...context.attempts, event.output.reason],
                  error: event.output.reason,
                };
              }),
            ],
          },
        ],
        onError: {
          target: "failed",
          actions: [
            assign(({ event }) => {
              const message = event.error instanceof Error ? event.error.message : String(event.error);
              return { error: message };
            }),
            ({ context, event }) => {
              const message = event.error instanceof Error ? event.error.message : String(event.error);
              context.broadcast({
                kind: "node_state",
                state: { kind: "failed", error: message, providerId: context.decision.adapter.providerId },
              });
            },
          ],
        },
      },
    },

    paid: {
      always: { target: "validating" },
    },

    validating: {
      entry: ({ context }) =>
        context.broadcast({
          kind: "node_state",
          state: { kind: "validating", txRef: context.txRef as string },
        }),
      invoke: {
        id: "deliverAndValidate",
        src: "deliverAndValidate",
        input: ({ context }) => ({
          nodeId: context.nodeId,
          ledgerId: context.ledgerId as string,
          capability: context.capability,
          invoiceId: (context.quote as QuoteResponse).invoice_id,
          providerId: context.decision.adapter.providerId,
          txRef: context.txRef as string,
          input: context.upstreamInput,
          deps: context.deps,
          adapter: context.decision.adapter,
        }),
        onDone: [
          {
            guard: ({ event }) => event.output.kind === "ok",
            target: "settled",
            actions: [
              assign(({ event }) => {
                if (event.output.kind !== "ok") return {};
                return { result: event.output.result };
              }),
              ({ context }) =>
                context.broadcast({
                  kind: "node_state",
                  state: {
                    kind: "settled",
                    txRef: context.txRef as string,
                    simulated: context.simulated as boolean,
                    ledgerId: context.ledgerId as string,
                    providerId: context.decision.adapter.providerId,
                  },
                }),
            ],
          },
          {
            guard: ({ event }) => event.output.kind === "blocked",
            target: "blocked",
            actions: [
              assign(({ event }) => {
                if (event.output.kind !== "blocked") return {};
                return { violation: event.output.violation };
              }),
              ({ context, event }) => {
                if (event.output.kind !== "blocked") return;
                context.broadcast({
                  kind: "node_state",
                  state: {
                    kind: "blocked",
                    violation: event.output.violation,
                    providerId: context.decision.adapter.providerId,
                  },
                });
              },
            ],
          },
          {
            guard: ({ event }) => event.output.kind === "retry",
            target: "routing",
            reenter: true,
            actions: [
              assign(({ context, event }) => {
                if (event.output.kind !== "retry") return {};
                return {
                  excluded: [...context.excluded, event.output.providerId],
                  attempts: [...context.attempts, event.output.reason],
                  error: event.output.reason,
                };
              }),
            ],
          },
        ],
        onError: {
          target: "failed",
          actions: [
            assign(({ event }) => {
              const message = event.error instanceof Error ? event.error.message : String(event.error);
              return { error: message };
            }),
            ({ context, event }) => {
              const message = event.error instanceof Error ? event.error.message : String(event.error);
              context.broadcast({
                kind: "node_state",
                state: { kind: "failed", error: message, providerId: context.decision.adapter.providerId },
              });
            },
          ],
        },
      },
    },

    waiting_approval: { type: "final" },
    settled: { type: "final" },
    blocked: { type: "final" },
    failed: { type: "final" },
  },
});

// Re-exported so the TaskRunner can spawn node actors with createActor.
export { createActor, toPromise };

# PRD: The Policy-Driven Router — Orchestrator of Agentic x402 Transactions (INF-01)

**Status:** Full build plan — no fixed time box, built with LLM-assisted development
**Source spec:** INF-01 — Multi-Provider Agent Payment Router & Treasury

> **Problem statement (verbatim):** Build a **policy-driven router** that **decomposes an agent task** across multiple x402 providers, **selects routes** by price/quality/latency, **enforces budgets**, **handles fallbacks**, and **reconciles every payment and result** without exposing an unrestricted wallet.

**Companion doc:** `PRD.md` (the earlier "Sentinel" router framing). This doc restates the project as the **orchestrator of agentic x402 transactions** — it keeps the router's identity exactly as the problem statement defines it and makes explicit that the router's decomposition, routing, and reconciliation *are* the orchestration. The "agent" is the source of the task; **our project is the policy-driven router that plans, pays for, executes, and reconciles that task.**
**Team size assumption:** 4 people

---

## 1. One-line pitch

A policy-driven router that takes an agent's task, decomposes it into paid capability calls, and orchestrates every one of them as an **agentic x402 transaction** — planning the calls, selecting providers by price/quality/latency, enforcing budgets, failing over safely, and reconciling every payment and result to a ledger — with no unrestricted wallet ever exposed to the agent.

## 2. Why "router" and "orchestrator" are the same component here

The problem statement names it a *router*, but it assigns the router orchestrator work:

> "decomposes an agent task ... selects routes by price/quality/latency, enforces budgets, handles fallbacks, and reconciles every payment and result"

You cannot "decompose an agent task" and "reconcile every payment and result" with a passive lookup-and-forward router. The spec's core objective says it outright: *"Create the payment control plane for a multi-step agent. The router should plan the calls, choose providers, authorize bounded payments, merge results, retry safely, and reconcile."*

So: the router **is** the control plane. It is not a library an agent happens to call — it is the component that:
1. **Decomposes** the incoming agent task into a dependency-aware call graph.
2. **Routes** each call to an x402 provider by price/quality/latency with an explainable "why."
3. **Authorizes and pays** each call under treasury policy as an agentic x402 transaction.
4. **Merges** guarded results back into the execution context so the next decision is made on verified data.
5. **Retries safely** with idempotency, fallbacks, and re-planning.
6. **Reconciles** quotes, payments, settlements, receipts, and outcomes to an append-only ledger.

The word "agentic" describes the *transactions*, not the product: each transaction is driven by (and feeds back into) an agent's multi-step task — a decomposition the router itself produces. Our project is the router; the agent is what hands it a goal.

## 3. The atomic unit: the agentic x402 transaction

Every capability the decomposed task needs is bought as one five-phase transaction. This is the contract every component in §4 implements:

```
AGENT TASK ─▶ ASK      router sends a capability request to a provider
                        provider responds 402 + terms (scheme exact|upto, amount,
                        resource id, facilitator)
                        │
               AUTHORIZE  treasury checks budgets/allowlist/risk, RESERVES spend,
                        mints a scoped single-use token ("pay ≤ X to Y for R, valid ≤ T")
                        │        no signer, no raw key, no free-form wallet access
                        ▼
               PAY      scoped wallet adapter signs + settles with idempotency key,
                        nonce control, gas simulation; provider fulfills resource
                        ▼
               VERIFY   settlement confirmed (chain + optional external cross-check),
                        response parsed through strict schema, result hash recorded
                        ▼
               RECONCILE row closed: quote → auth → payment → settlement → response
                        → result hash → outcome; verified result feeds the next
                        routing/merge decision
```

Invariants (non-negotiable):
- **Nothing enters the execution context un-guarded.** The router's next decision (and anything surfaced to the agent) is made only from ledger-stamped results.
- **Nothing spends un-authorized.** The router proposes the call; the treasury disposes of the budget.
- **Nothing settles twice.** The idempotency key is minted at `ASK`, enforced at `PAY`, checked at `RECONCILE`.
- **Any phase can fail** and the fallback semantics in §7 kick in — the router re-plans rather than blindly retrying.

## 4. System blueprint

### 4.1 Orchestration runtime (the router's loop) — LangGraph

The router is one `StateGraph`. LangGraph supplies the orchestration primitives the problem statement demands nearly for free:

| Router requirement | LangGraph primitive |
|---|---|
| Decompose agent task → call graph | LLM planner node emitting a Zod-constrained graph |
| Parallel fan-out | `Send` API to spawn independent capability nodes |
| Dependency-aware joins / result merging | graph edges + reducer-merging of sub-results before the next decision |
| Re-plan on failure (fallback) | `Command` re-entry after a guarded failure |
| Budget pause-for-approval | `interrupt()` — the exact budget-breach demo mechanism |
| Replay / audit | checkpointing (`MemorySaver`/Postgres) — replay is a checkpoint walk |
| Approval UI resume | `Command(resume=...)` surfaced through the trace UI |

Nodes (all part of the router):
1. **planner** — decomposes the incoming agent task into a call graph (Zod-constrained), with a hardcoded fallback if the LLM call fails or emits an invalid shape.
2. **route** — for each capability node, pick a provider via the optimizer (§4.3) and record the "why".
3. **authorize** — treasury reserve + scoped token (may `interrupt()` for approval).
4. **pay** — x402 settle via the scoped wallet adapter.
5. **guard** — verify + schema-parse + hash (§4.5); verdict appended to state.
6. **reflect** — merge guarded results and decide: continue, parallelize, re-route, or stop with partial results marked.
7. **report** — end-of-task cost/quality report + reconciliation export.

### 4.2 Tool registry — capabilities as x402-payable tools

A tool is `{ capability, description, schema, provider candidates }`. The planner only ever sees capabilities; providers are resolved at `route` time. This is what lets the optimizer swap providers without the decomposition changing, and what makes a newly-listed Bazaar provider routable instantly.

- Catalog per `PRD.md` §3.2: 6–10 entries, mixed `exact`/`upto`, stale/conflicting price metadata, plus adversarial variants.
- Bazaar discovery (per `PRD.md` §3.9) feeds unvetted providers into the catalog at a **capped per-provider budget / lowest risk tier**.

### 4.3 Route optimizer

- **Baseline:** weighted score over price/latency/quality/reliability/settlement-risk with a human-readable "why".
- **Learning mode:** multi-armed bandit (Thompson/UCB1) adapting online as quality drifts; held-out evaluation harness reports cumulative cost/regret against baseline.
- Stale-quote handling: quote re-validated before `PAY`; mismatch re-routes.

### 4.4 Treasury / policy layer

- Per-task, per-provider, per-network, time-window budgets; spend reservation (reserve → release on failure → settle on success).
- Risk thresholds + allowlists; a provider drops tiers after repeated violations.
- Approval gate via `interrupt()` with a live, clickable approve/deny in the UI.
- **The planner cannot propose budgets or wallet scopes** — treasury owns those exclusively.

### 4.5 Policy guard — the only door into the execution context

Every provider response is parsed through a strict Zod schema *before* it can enter the execution context or touch treasury/wallet state. `.safeParse()` failure or a disallowed field = structural rejection. Attack catalog carried over from `PRD.md` §3.5 (budget mutation, scope expansion, prompt injection, receipt forgery), each logged as `blocked_policy_violation` and re-planned by `reflect`.

### 4.6 Scoped wallet / signer adapter

- x402 client (`@x402/fetch`) with a `viem` wallet that never enters the execution context.
- Per-transaction scoped tokens: single provider, single resource, capped amount, expiry. No raw key, no free-form signing.
- Idempotency key + nonce control at the adapter; transaction simulation before settle.
- **Zerion cross-check** (per `PRD.md` §3.10): after `PAY`, confirm a matching on-chain tx on the treasury address before marking `settled`, plus a live "ledger vs chain" treasury view.

### 4.7 Reconciliation ledger + replay

Append-only table, one row per agentic x402 transaction: `request → 402 terms → authorization → payment → settlement → response → guard verdict → result hash → outcome`. Full task export as JSON; replay via LangGraph checkpoint walk; replay-with-changed-offer diffing shows which routing decisions change and which policy stays fixed.

## 5. Separation of powers

| Role | Owns | Can never do |
|---|---|---|
| **planner (router node)** | decomposes agent task into a call graph | set budgets, expand scopes, sign |
| **route optimizer** | picks provider + records why | raise the reserved cap |
| **treasury** | budgets, reserves, allowlists, approval | spend without an authorized token |
| **wallet adapter** | scoped signing, idempotency, simulation | act outside the scoped token |
| **guard** | structural validation of responses | be bypassed by any downstream `if` |
| **ledger** | ground truth of every transaction | be mutated by providers or the router |

This is the security model the problem statement's "without exposing an unrestricted wallet" demands, and it is *structural*: each role is a separate LangGraph node boundary, not a discipline.

## 6. Mapping the problem statement to the build

| Problem-statement verb | Where it lives |
|---|---|
| Decomposes an agent task | `planner` node (§4.1) + tool registry (§4.2) |
| Across multiple x402 providers | real multi-scheme catalog on Base Sepolia (§4.2) |
| Selects routes by price/quality/latency | route optimizer (§4.3), explainable "why" |
| Enforces budgets | treasury/policy layer (§4.4), approval via `interrupt()` |
| Handles fallbacks | §7 recovery semantics + `reflect` re-planning |
| Reconciles every payment and result | ledger (§4.7) + replay |
| Without exposing an unrestricted wallet | scoped wallet adapter (§4.6) + separation of powers (§5) |

## 7. Fallback and recovery semantics (inside the loop)

- Provider outage / settlement failure → `pay` fails → `reflect` re-routes to next-best catalog provider, ledger marks `declared_failure` on the original row.
- Stale quote between `ASK` and `PAY` → re-validate → re-route, never pay blind.
- Payment rejected / facilitator down → same idempotency key reused across retries; no double settlement.
- Partial completion → task terminates with partial results clearly marked and the report explains what was and wasn't bought.
- Duplicate retry → idempotency check at `RECONCILE` rejects the row, no double spend.
- Approval denied → that capability node is skipped or re-planned under a lower-cost alternative, never silently overspent.

## 8. Non-negotiable safety boundary (from source spec)

- Simulated/testnet funds only — Base Sepolia test USDC, faucet wallets, real protocol but never real money.
- No raw key/seed in agent context — scoped "pay ≤ X to Y for R" tokens only; the planner and optimizer never see the signer.
- No provider response can rewrite budget policy or expand wallet scope — enforced structurally by the guard between provider response and execution context.
- The planner is bounded: it can propose task graphs, never budgets or wallet scopes.
- A provider or result must never gain access to unrelated wallet scopes.

## 9. Suggested tech stack

| Layer | Choice | Why |
|---|---|---|
| Orchestration runtime | **LangGraph** (`langgraph`) + `langgraph-sdk` | The router IS the graph; checkpoints = replay, `interrupt()` = approvals, `Send` = parallel fan-out, `Command` = re-planning |
| Payment protocol | `@x402/core`, `@x402/evm`, `@x402/express`, `@x402/fetch`, `@x402/extensions/bazaar` on Base Sepolia + `viem` | Real signed payments, testnet-safe, open discovery |
| LLM (planner) | Gemini API (`@google/genai`) or local via Ollama, Zod-constrained | Swappable behind one interface; local fallback for offline demo |
| Schema / policy guard | Zod + `zod-to-json-schema` | One library for planner output and provider-response validation |
| Ledger + checkpoint store | Postgres (or libSQL/Turso zero-ops) | Append-only ledger doubles as replay source; LangGraph checkpointer |
| Live trace UI | React + React Flow + WebSocket | Node/edge graph of the running router; interactive approval; replay scrubber |
| Route optimizer | Plain TypeScript bandit math | Inspectable, no framework overhead |

## 10. Team split (4 people)

- **Dev A — providers & scoped wallet:** real x402 catalog on Base Sepolia, `exact`/`upto` + adversarial variants, `viem` adapter with idempotency + simulation, Bazaar discovery wiring.
- **Dev B — treasury & guard:** budgets/reserve/allowlist/approval, Zod guard, ledger + checkpoint schema, Zerion cross-check.
- **Dev C — frontend & replay:** React Flow live trace of the running router, WebSocket, interactive approve/deny, replay + offer-change diffing.
- **Dev D — router core:** LangGraph state graph, planner node with hardcoded fallback, tool registry, baseline + bandit optimizer, held-out evaluation harness.

## 11. Suggested build order (sequence matters more than hours)

1. Ledger + checkpoint schema and the Zod guard contract — lock the trust boundary before anything else.
2. Hardcoded call graph + baseline router + happy path end-to-end against real x402 testnet providers — the safety-net demo.
3. Live trace UI wired to the happy path — visual proof of life early.
4. Idempotency + forced failure + budget breach + pause/approval.
5. Guard live: first adversarial provider blocked structurally, visible red in the UI.
6. Remaining adversarial providers (scope expansion, injection, receipt forgery if time allows).
7. Swap the hardcoded graph for the LLM planner (fallback intact) and verify graceful degradation.
8. `reflect` node with real re-planning on guarded failure — this is where the router stops being a forwarder and becomes the orchestrator.
9. Bandit optimizer + held-out evaluation harness, A/B against baseline.
10. Multi-scheme + stale-quote handling.
11. Replay mode, then replay-with-changed-offer.
12. Rehearse the full demo including a deliberate planner failure.

## 12. Demo script

1. **An agent task in, a decomposed route plan out:** "Produce a verified research brief on X with sources ranked and cross-checked." Watch the router decompose it into a call graph, the optimizer explain each provider pick, the graph light up node-by-node with the parallel branch — real testnet x402 settlements underneath, ledger rows appearing live.
2. **The router makes a decision:** after a guarded result comes back, watch the `reflect` node merge it and choose a cheaper/alternative path for the remaining steps (dynamic evidence pruning).
3. **Forced failure:** kill a provider after `402`, before settlement — ledger marks `declared_failure`, no duplicate payment, `reflect` swaps in the fallback automatically.
4. **Budget breach:** tight cap re-run — the router hits `interrupt()`, UI shows a live, clickable approval prompt; deny → router re-plans cheaper, approve → bounded spend.
5. **The attacks:** 2–3 adversarial providers back-to-back — each caught structurally, each shown red on the live graph with the violation type and rejected field, router re-routes.
6. **Stale quote:** provider's price changes between `ASK` and `PAY` — router catches the mismatch and re-validates instead of paying blind.
7. **Reconciliation + replay:** export the ledger, reload it via checkpoints, then replay the same task with a changed provider offer and show which routing decisions change and which policy stays fixed.
8. **(If planner degrades):** deliberately break the LLM planner call and show the hardcoded-graph fallback keeps the task running.

## 13. Success criteria for judging

- Zero unauthorized budget overspends across every scenario including adversarial ones.
- Zero duplicate settlements under forced failure or retries, verified against real testnet tx hashes.
- Zero successful policy/scope violations — every attack caught structurally.
- Bandit optimizer measurably beats baseline on held-out provider combinations.
- Every decomposed call, every route decision, every dollar, and every blocked attack maps to a ledger row — visible live and replayable afterward, including under a changed provider offer.
- The router provably *orchestrates*: it demonstrably changes what it buys based on the guarded results that came back — not just which provider it pays — while staying inside the treasury budget the whole time.

## 14. Stretch goals (only after §11 items 1–6 are solid)

1. Receipt forgery detection (4th attack type).
2. Simulated multi-network settlement mismatch handling.
3. Composite workflow with conditional/skippable branches (INF-03 borrowing).
4. Role-based access on the approval UI (analyst vs. approver).
5. Self-hosted deployment on the k3s/Traefik homelab as a backup environment.

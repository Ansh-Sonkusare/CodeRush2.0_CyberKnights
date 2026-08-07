# Build Plan

Phases mapped to the PRD build order (`PRD.md` §7 / `PRD-ORCH.md` §11).
Sequence matters more than hours. **Done** means the phase's definition-of-done
holds and its demo script runs clean.

Legend: ✅ done · 🔄 in progress · ⏳ not started

## Phase 0 — MVP baseline (already shipped)

Executor loop, treasury (reserve/settle/release + approval), simulated scoped
wallet with idempotency, baseline weighted route optimizer, JSON-file ledger,
3 mock providers, failure injection + fallback, static dashboard.

- Demos: `npm run preview`, `npm run demo2`, `npm run demo3`, `npm run dashboard`
- **Gap it left:** provider responses were never structurally validated (no Zod),
  so a provider could in theory inject policy/scope fields straight into state.

## Phase 1 — Schemas & flow (the trust boundary) 🔄

Lock the contract before anything else (PRD build item #1).

- Definition of done:
  - [x] `docs/guard-contract.md` written (the allowed-fields contract)
  - [x] Zod guard contract: strict schemas for 402 terms, per-capability
        results, and receipts
  - [x] Zod ledger schema; rows validated on append
  - [x] Guard module: `.safeParse()` + attack classification +
        `blocked_policy_violation` logging
  - [x] Guard wired into the paid-call flow between provider response and
        ledger/treasury/wallet — no response touches state un-parsed
  - [x] Demo proves happy path passes the guard AND a budget-mutation attack is
        blocked structurally, end to end (`npm run guard`)
- Out of scope (next phase): the full adversarial provider catalog.

## Phase 2 — Adversarial providers live

PRD §3.5 / build items #5–6. Turn the attack catalog into real provider modes
and prove each is caught structurally and visible in the trace:

1. Budget mutation (raise cap / self-approve overpayment)
2. Scope expansion (request wallet capability / access)
3. Prompt injection (instruction embedded for the orchestrating agent)
4. Receipt forgery (claimed settlement with no matching tx)

- Definition of done: each attack, armed on a provider, yields a
  `blocked_policy_violation` ledger row with the correct type; the executor
  re-routes and the task continues on declared failure.

## Phase 3 — Live trace UI

React + React Flow + WebSocket. Live task-graph node states (quote/pay/settle),
blocked-attack nodes flash red with the guard's reason inline, interactive
approve/deny. Replaces the static dashboard.

## Phase 4 — LLM planner (Gemini/Ollama) with hardcoded fallback

Zod-constrained task-graph output, swappable backend, graceful degradation on
schema failure/timeout. Planner can propose graphs only — never budgets/scopes.

## Phase 5 — Bandit route optimizer + held-out eval harness

Thompson sampling / UCB1 vs baseline on held-out provider combinations;
cumulative cost/regret report.

## Phase 6 — Multi-scheme + stale-quote handling

`exact` and `upto` payment schemes; quote re-validated between `ASK` and `PAY`,
re-routed on mismatch rather than paying blind.

## Phase 7 — Replay + replay-with-changed-offer

Reload a past task and step through node-by-node; re-run with one provider's
price changed and diff which routing decisions change and which policy stays fixed.

## Phase 8 — Bazaar marketplace + Zerion verification

Local facilitator with `@x402/extensions/bazaar`; hybrid catalog (guaranteed
providers + live discovery) at capped/lowest-trust tier. After each payment,
cross-check the treasury wallet on-chain via Zerion before marking `settled`;
live "ledger vs chain" treasury view.

## Phase 9 — Real x402 on Base Sepolia

Swap simulated providers/wallet for `@x402/core`, `@x402/evm`, `@x402/express`,
`@x402/fetch` + `viem` on Base Sepolia testnet (test USDC, faucet wallets).
This is the PRD's stated differentiator over a hand-rolled fake 402.

## Phase 10 — Demo rehearsal

Full demo script end-to-end including a deliberate planner failure and a
deliberate attack that gets caught live.

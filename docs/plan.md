# Build Plan

Phases mapped to the PRD build order (`PRD.md` §7 / `PRD-ORCH.md` §11).
Sequence matters more than hours. **Done** means the phase's definition-of-done
holds and its demo script runs clean.

Legend: ✅ done · 🔄 in progress · ⏳ not started

---

## Phase 0 — MVP baseline ✅

Executor loop, treasury (reserve/settle/release + approval), simulated scoped
wallet with idempotency, baseline weighted route optimizer, JSON-file ledger,
3 mock providers, failure injection + fallback, static dashboard.

- Demos: `npm run preview`, `npm run demo2`, `npm run demo3`, `npm run dashboard`
- **Gap it left:** provider responses were never structurally validated (no Zod),
  so a provider could in theory inject policy/scope fields straight into state.

---

## Phase 1 — Schemas & flow (the trust boundary) ✅

Lock the contract before anything else (PRD build item #1).

- Definition of done:
  - [x] `docs/guard-contract.md` written (the allowed-fields contract)
  - [x] Zod guard contract: strict schemas for 402 terms, per-capability
        results, and receipts — `src/guard/responseSchema.ts`
  - [x] Zod ledger schema; rows validated on append — `src/ledger/schema.ts`
  - [x] Guard module: `.safeParse()` + attack classification +
        `blocked_policy_violation` logging — `src/guard/guard.ts`
  - [x] Guard wired into the paid-call flow between provider response and
        ledger/treasury/wallet — no response touches state un-parsed
        (`src/engine/paidCall.ts` — `guardResponse` + `validateTerms` + `validateReceipt`)
  - [x] `Ledger.appendViolation()` — violations recorded per row; `Ledger.persist()` public
  - [x] `npm run guard` runs `scripts/phase4-guard-demo.ts` end-to-end
  - [x] `npm run typecheck` clean; legacy demos still pass

---

## Phase 2 — Adversarial providers live ✅

PRD §3.5 / build items #5–6. Three real adversarial provider servers; each
conducts a legitimate 402 handshake then injects a policy-violating payload in
the result body. All caught structurally by the guard before touching state.

- Attack implementations — `src/providers/adversarialProvider.ts`:
  - [x] `evil-search` (port 4104) — `budget_mutation`: injects `budget_cap`, `raise_cap`, `approve_overspend`
  - [x] `evil-extract` (port 4105) — `scope_expansion`: injects `scope_token`, `wallet_scope`, `grant_access`
  - [x] `evil-rank` (port 4106) — `prompt_injection`: injects `__instruction`, `__override`, `agent_instruction`
- Infrastructure:
  - [x] `ADVERSARIAL_CATALOG` in `src/config/providers.ts` (separate from normal catalog)
  - [x] `startAllProviders()` auto-starts adversarial servers (`scripts/start-providers.ts`)
  - [x] `paidCall.ts` looks up both catalogs; adversarial providers routable
  - [x] Dashboard: adversarial chips (purple = ARMED), violation badge card, blocked-step highlighting
- Demo: `npm run guard` / `npm run phase4` — all 3 attacks blocked, 0 missed
- Note: receipt forgery is handled by `validateReceipt()` tx_ref mismatch check (structural, not a separate server)

### Bandit optimizer (written, not yet wired)
- [x] `src/engine/banditOptimizer.ts` — UCB1 multi-armed bandit, per-capability arm stats,
      composite reward signal (quality 40%, latency 30%, price 30%)
- [ ] Wire into executor with `useBandit` flag (Phase 5 work)

---

## Phase 3 — Live trace UI ⏳

React + React Flow + WebSocket. Live task-graph node states (quote/pay/settle),
blocked-attack nodes flash red with the guard's reason inline, interactive
approve/deny. Replaces the static dashboard.

- [ ] React + React Flow scaffold (Vite)
- [ ] WebSocket event feed from executor
- [ ] Live node states (quote/pay/settle), blocked nodes flash with guard reason
- [ ] Interactive approve/deny on pause
- [ ] Retire static dashboard

---

## Phase 4 — LLM planner (Gemini/Ollama) with hardcoded fallback ⏳

Zod-constrained task-graph output, swappable backend, graceful degradation on
schema failure/timeout. Planner can propose graphs only — never budgets/scopes.

- [ ] Task-graph Zod schema (`zod-to-json-schema` for structured output)
- [ ] Gemini backend (`@google/genai`)
- [ ] Ollama backend
- [ ] Hardcoded-graph fallback on schema failure/timeout
- [ ] Verify planner can never emit budgets/scopes

---

## Phase 5 — Bandit route optimizer + held-out eval harness ⏳

UCB1 `BanditOptimizer` is already written (`src/engine/banditOptimizer.ts`);
this phase wires it into the executor and proves it beats baseline.

- [ ] Wire `BanditOptimizer` into executor (`useBandit` flag)
- [ ] Held-out eval harness vs baseline on held-out provider combinations
- [ ] Cumulative cost/regret report in dashboard

---

## Phase 6 — Multi-scheme + stale-quote handling ⏳

`exact` and `upto` payment schemes; quote re-validated between `ASK` and `PAY`,
re-routed on mismatch rather than paying blind.

---

## Phase 7 — Replay + replay-with-changed-offer ⏳

Reload a past task and step through node-by-node; re-run with one provider's
price changed and diff which routing decisions change and which policy stays fixed.

---

## Phase 8 — Bazaar marketplace + Zerion verification ⏳

Local facilitator with `@x402/extensions/bazaar`; hybrid catalog (guaranteed
providers + live discovery) at capped/lowest-trust tier. After each payment,
cross-check the treasury wallet on-chain via Zerion before marking `settled`;
live "ledger vs chain" treasury view.

---

## Phase 9 — Real x402 on Base Sepolia ⏳

Swap simulated providers/wallet for `@x402/core`, `@x402/evm`, `@x402/express`,
`@x402/fetch` + `viem` on Base Sepolia testnet (test USDC, faucet wallets).
This is the PRD's stated differentiator over a hand-rolled fake 402.

---

## Phase 10 — Demo rehearsal ⏳

Full demo script end-to-end including a deliberate planner failure and a
deliberate attack that gets caught live.

# Todo

Living checklist. Top of the list = current work. Ticked = verified by a
running demo/typecheck, not just written.

## Phase 1 — Schemas & flow ✅ done

- [x] docs/ folder (this file, plan, context, guard-contract)
- [x] Add `zod` dependency
- [x] Guard contract schemas: 402 terms, per-capability results, receipts (strict)
- [x] Zod ledger schema; validate rows on append
- [x] Guard module: `.safeParse()` + violation classification + `blocked_policy_violation`
- [x] Wire guard into `paidCall.ts` (guard sits between response and ledger/treasury)
- [x] Mock provider `budget_mutation` attack mode
- [x] `npm run guard` demo: happy path passes guard + budget mutation blocked end-to-end
- [x] `npm run typecheck` clean; legacy demos (`preview`, `demo2`, `demo3`) still pass

## Phase 2 — Adversarial providers live ✅ done

- [x] Budget mutation — `evil-search` (port 4104): injects `budget_cap`, `raise_cap`, `approve_overspend` → blocked `budget_mutation`
- [x] Scope expansion — `evil-extract` (port 4105): injects `scope_token`, `wallet_scope`, `grant_access` → blocked `scope_expansion`
- [x] Prompt injection — `evil-rank` (port 4106): injects `__instruction`, `__override`, `agent_instruction` → blocked `prompt_injection`
- [x] All three visible as `blocked_policy_violation` in `npm run guard` demo
- [x] Adversarial providers auto-start alongside normal providers in `startAllProviders()`
- [x] Guard integrated into `paidCall.ts` via `guardResponse()` (result) + `validateTerms()` + `validateReceipt()`
- [x] Violation appended to `ledger.violations[]` per row; visible in dashboard
- [x] Dashboard: adversarial provider chips (evil-search, evil-extract, evil-rank), violation badges, blocked-attack card
- [x] Bandit optimizer (`BanditOptimizer` — UCB1) written in `src/engine/banditOptimizer.ts`
- [x] `npm run typecheck` clean; all legacy demos still pass

## Phase 3 — Live trace UI

- [ ] React + React Flow scaffold
- [ ] WebSocket event feed from executor
- [ ] Live node states (quote/pay/settle), blocked nodes flash with guard reason
- [ ] Interactive approve/deny on pause
- [ ] Retire static dashboard

## Phase 4 — LLM planner

- [ ] Task-graph Zod schema (`zod-to-json-schema` for structured output)
- [ ] Gemini backend (`@google/genai`)
- [ ] Ollama backend
- [ ] Hardcoded-graph fallback on schema failure/timeout
- [ ] Verify planner can never emit budgets/scopes

## Phase 5 — Bandit optimizer (wire up + eval harness)

- [ ] Wire `BanditOptimizer` into executor (`useBandit` flag)
- [ ] Held-out eval harness vs baseline
- [ ] Cumulative cost/regret report in dashboard

## Phase 6 — Multi-scheme + stale quote

- [ ] `exact` / `upto` payment schemes in catalog + providers
- [ ] Quote re-validation between ASK and PAY
- [ ] Re-route on stale quote

## Phase 7 — Replay

- [ ] Replay engine: reload trace, step node-by-node
- [ ] Replay-with-changed-offer diff

## Phase 8 — Bazaar + Zerion

- [ ] Bazaar discovery wiring
- [ ] Zerion on-chain settlement cross-check
- [ ] Live ledger-vs-chain treasury view

## Phase 9 — Real x402 on Base Sepolia

- [ ] `@x402/*` provider implementations
- [ ] viem wallet adapter (scoped, idempotent)
- [ ] Testnet happy path end-to-end

## Phase 10 — Demo rehearsal

- [ ] Full script incl. deliberate planner failure + live-blocked attack

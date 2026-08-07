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

- Demos: `npm run preview`, `npm run demo2`, `npm run demo3`
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

## Phase 3 — Live trace UI ✅

React + React Flow + WebSocket. Live task-graph node states (quote/pay/settle),
blocked-attack nodes flash red with the guard's reason inline, interactive
approve/deny. Replaces the static dashboard (retired; its bandit eval card was
ported into the live UI as a panel).

- [x] React + React Flow scaffold (Vite)
- [x] WebSocket event feed from executor (`trace-server` broadcasts every
      `ExecutorBus` event; `ui` consumes it via `useWs`)
- [x] Live node states (quote/pay/settle), blocked nodes flash with guard reason
      (blocked node turns red + `flash` animation, violation reason inline)
- [x] Interactive approve/deny on pause (tight-cap scenario pauses; approve
      raises the cap, deny marks the wave `declared_failure`)
- [x] Retire static dashboard — `scripts/dashboard.ts` deleted; bandit eval card
      ported to the live UI as a "Bandit eval report" panel (served by
      `trace-server` at `/api/bandit-report`)
- [x] Verified end-to-end: `ui` production build clean; WS smoke asserts the
      event sequence for happy / attack-search / attack-extract / attack-rank /
      tight-cap approve / tight-cap deny across `trace-server`.

---

## Phase 4 — LLM planner (Gemini/Ollama) with hardcoded fallback ✅

Zod-constrained task-graph output, swappable backend, graceful degradation on
schema failure/timeout. Planner can propose graphs only — never budgets/scopes.

- [x] Task-graph Zod contract (`src/planner/plannerSchema.ts`, `.strict()` on
      root + steps). The JSON schema handed to the model for structured output
      is hand-authored to mirror the Zod contract — `zod-to-json-schema` is
      incompatible with the repo's zod v4 (it silently emits empty schemas), so
      the dependency was dropped rather than downgrading zod.
- [x] Gemini backend (`@google/genai`) — `GeminiPlanner`, used when
      `GEMINI_API_KEY` is set (`responseMimeType: "application/json"` +
      `responseSchema`).
- [x] Ollama backend — `OllamaPlanner`, plain `fetch` to `/api/chat` with
      `format: <json-schema>`, stream off.
- [x] OpenAI-compatible backend — `OpenAICompatiblePlanner`, plain `fetch` to
      `${LLM_BASE_URL}/chat/completions` with `Authorization: Bearer` and
      `response_format: { type: "json_object" }`, so any key speaking OpenAI
      routes works (Groq, OpenRouter, Together, OpenAI, vLLM, …). Backend is
      chosen by `LLM_PROVIDER` (gemini | openai-compatible | ollama) with
      unified `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`/`LLM_TEMPERATURE`/
      `LLM_MAX_TOKENS`; legacy `GEMINI_API_KEY`/`GROQ_API_KEY`/`OPENAI_API_KEY`/
      `OLLAMA_BASE_URL`/`OLLAMA_MODEL` act as fallbacks when `LLM_PROVIDER` is
      unset (inferred by which key is present).
- [x] Hardcoded-graph fallback on schema failure/timeout/outage —
      `planWithFallback()` (45s cap) returns `src/config/taskGraph.ts`.
- [x] Verify planner can never emit budgets/scopes — deep forbidden-key scan +
      `.strict()` structural rejection (any `budget_cap`/`scope_token`/
      `agent_instruction`/… is a structural rejection, not a downstream `if`);
      `plannerGraphToTaskGraph()` stamps the treasury-owned `budget_cap`;
      `validateGraph()` rejects duplicate/unknown deps and cycles.
- [x] `npm run demo4` — live plan (`LLM_PROVIDER` backend, verified live against
      both Groq (`llama-3.3-70b-versatile`, `response_format: json_object`) and
      Gemini (`gemini-3.5-flash`)), adversarial plan rejections, forced-fallback,
      and the planned graph run end-to-end through the executor (all 5
      capabilities covered by the provider catalog). `temperature`/`max_tokens`
      flow from `LLM_TEMPERATURE`/`LLM_MAX_TOKENS`. The Ollama path is verified
      against a mock `/api/chat` (the user's Ollama host is not reachable from
      the dev sandbox). A transient 429/503 fell back cleanly, so graceful
      degradation was observed live. typecheck + all prior demos + `ui` build
      stay green.

---

## Phase 5 — Bandit route optimizer + held-out eval harness ✅

UCB1 `BanditOptimizer` was already written (`src/engine/banditOptimizer.ts`);
this phase wires it into the executor and proves it beats baseline.

- [x] Wire `BanditOptimizer` into executor via `useBandit` option
      (`src/engine/executor.ts`): bandit picks in `decisionFor` + fallbacks,
      and `observeOutcome()` feeds the bandit the realized latency/price on
      every success and failure so it learns across runs. A `BanditOptimizer`
      instance can be shared across executors to keep learning.
- [x] Held-out eval harness vs baseline on held-out provider combinations —
      `scripts/bandit-eval.ts` (seeded, common random numbers). Headline metric
      is cumulative delivered reward; regret vs the per-capability oracle is
      reported too. Two scenarios: `adversarial-holdout` (the catalog favorites
      secretly under-deliver; the bandit discovers the true ranking and wins
      5/5 capabilities) and `control-truthful` (catalog claims are accurate; the
      bandit loses by ~3.7%, i.e. it does not win when there is nothing to learn).
- [x] Cumulative cost/regret report in dashboard — `npm run bandit-eval` writes
      `data/bandit-report.json`, served at `/api/bandit-report` and rendered in
      a "Bandit eval report" card on the dashboard (later ported to the live
      trace UI panel in Phase 3).
- [x] `npm run demo5` runs the wired executor over real HTTP: a baseline run vs
      6 bandit runs sharing one `BanditOptimizer`, showing explore → exploit and
      the learned arm stats.
- [x] `npm run typecheck` clean; all prior demos still pass.

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

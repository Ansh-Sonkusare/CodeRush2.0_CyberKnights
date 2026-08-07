# AGENTS.md — x402 Payment Router (INF-01)

> Written for AI agents working in this repo. Human readability is a side effect.
> If you implement something new or change existing behavior, **update the docs in
> the same change** (see "Development Workflow" below) and keep the code organized
> (see "Code Organization"). Keep this file accurate — it is the agent's first read.

---

## 1. The Idea

This project is a **policy-driven agent payment router & treasury** (spec INF-01).
An agent wants to complete a multi-step task ("research x402 specs, translate the
top result, rank the sources, verify the answer"). Every step costs money and is
bought from a paid API ("provider"). This project is the **payment control plane**
that sits between the agent and those providers:

- it **decomposes** a goal into a dependency-aware task graph,
- **routes** each step to a provider chosen by price / latency / quality,
- **authorizes** and **pays** each call under strict treasury policy,
- **guards** every provider response structurally before it touches state,
- **fails over** safely (idempotency keys, fallbacks, re-planning),
- **reconciles** every quote, payment, settlement, and result to an append-only
  ledger that can be exported and replayed.

The differentiator is the **policy guard**: every provider response is parsed
through a strict Zod schema *before* it can touch budget or wallet state. A
response containing `budget_cap`, `grant_access`, or an injected instruction is a
structural rejection, never a downstream `if`. That is what makes an **open,
permissionless marketplace** safe to route real budget through — the central demo
claim. The full design is in `PRD.md` (Sentinel framing) and `PRD-ORCH.md`
(orchestrator framing); working plan lives in `docs/`.

**Safety boundary (non-negotiable):** simulated/testnet funds only, never real
money. No raw key or seed ever enters agent context — only scoped
"pay ≤ X to Y for R" tokens. The planner can propose task graphs, never budgets or
wallet scopes.

## 2. Architecture

The security model is **separation of powers**: every role is a separate module
boundary, and no role can overstep into another's authority.

| Role | Owns | Can never do |
|---|---|---|
| planner | decomposes a task into a call graph | set budgets, expand scopes, sign |
| route optimizer | picks a provider + records the "why" | raise the reserved cap |
| treasury | budgets, reserves, allowlists, approval | spend without an authorized token |
| wallet adapter | scoped signing, idempotency | act outside the scope token |
| guard | structural validation of provider responses | be bypassed by any downstream `if` |
| ledger | ground truth of every transaction | be mutated by providers or the router |

Every capability is bought as one **agentic x402 transaction** — the contract every
component implements:

```
ASK        ask provider → 402 + terms (price, scheme, resource)
AUTHORIZE  treasury checks budget → reserves spend → mints scoped single-use token
PAY        scoped wallet settles with idempotency key (never pays twice)
VERIFY     settlement confirmed; response parsed through the guard (strict schema)
RECONCILE  ledger row closed: quote → auth → payment → settlement → response → receipt → outcome
```

### Module map (pointers, not duplicates)

- `src/types.ts` — shared domain types (capability, ledger, guard violation, etc.)
- `src/engine/executor.ts` — the orchestration loop: ready-steps waves, routing,
  pause-for-approval, fallback retry. Emits typed events via
  `src/engine/executorEvents.ts`.
- `src/engine/paidCall.ts` — one full paid x402 call; wires ledger + wallet +
  provider + guard in the exact transaction order. **The guard sits here.**
- `src/engine/routeOptimizer.ts` — baseline weighted scoring (price/latency/quality)
  with human-readable reasons; `src/engine/banditOptimizer.ts` — UCB1 bandit,
  wired into the executor via the `useBandit` option (learns from realized
  latency/price on every success and failure).
- `src/guard/responseSchema.ts` + `src/guard/guard.ts` — strict Zod contract and the
  `.safeParse()` gate that classifies and logs `blocked_policy_violation`.
- `src/treasury/treasury.ts` — reserve → settle on success → release on failure;
  `approveOverspend()` raises the cap only via explicit human approval.
- `src/wallet/wallet.ts` — simulated scoped, idempotent wallet (Phase 9 replaces
  this with real `@x402/*` + viem).
- `src/ledger/` — append-only JSON ledger with per-stage rows + violation tracking.
- `src/providers/mockProvider.ts` / `adversarialProvider.ts` — local HTTP servers
  that do a real 402 handshake then serve results (the adversarial ones inject
  attack payloads).
- `src/config/providers.ts` + `src/config/taskGraph.ts` — provider catalog and the
  default 5-step task graph.
- `scripts/` — runnable demos (`preview`, `demo2`, `demo3`, `guard`), the static
  dashboard (`dashboard`), the live-trace server (`trace-server`).
- `ui/` — React + React Flow live-trace UI (Phase 3; **in progress**, see docs).

## 3. Workflow (how a task runs end-to-end)

1. **Plan** — a task graph is produced: today it is the hardcoded
   `src/config/taskGraph.ts`; Phase 4 swaps in an LLM planner (Gemini/Ollama,
   Zod-constrained) with the hardcoded graph as fallback.
2. **Route** — for each ready step the executor calls `pickProvider()` (baseline),
   or — with the `useBandit` option — the UCB1 `BanditOptimizer` (fallbacks stay
   bandit-aware), recording an explainable "why". Every success/failure feeds the
   bandit a reward (wall-clock latency + price) so it learns across runs.
3. **Authorize** — treasury checks the whole parallel wave fits the cap; if not,
   the executor **pauses** and a human approves/denies (`approve()` / `reject()`).
4. **Pay** — `runPaidCall()` runs the transaction: `/invoice` → 402 + terms,
   `wallet.pay()` (idempotent per task+node+provider key, capped by the scope
   token), `/complete` → result + receipt.
5. **Guard** — terms, result, and receipt are each parsed structurally; a
   rejection appends a `blocked_policy_violation`, marks the row
   `declared_failure`, and the executor falls back to the next-best provider.
6. **Reconcile** — one ledger row per paid call records every stage; the task
   summary, trace export, and live UI events all derive from it.

Parallel dependencies fan out in the same wave (`n-extract` + `n-translate` run
concurrently), and dependent steps only start once their inputs are
guard-passed, ledger-stamped results.

## 4. Development Workflow — update the docs with every change

- **Every change that implements something new or changes existing behavior must
  update the docs in the same commit:**
  - `docs/README.md` — status table + how-to-run
  - `docs/plan.md` — phase definition-of-done
  - `docs/todo.md` — living checklist
  - `docs/context.md` / `docs/guard-contract.md` — if the design or the trust
    boundary changed
- **Follow the phase order in `docs/plan.md`** — sequence matters. Do not jump
  ahead of a phase's prerequisites.
- **A phase is "done" only when** its demo runs clean and `npm run typecheck`
  passes — not when the code looks finished.
- Keep demos runnable at every step: the provider servers auto-start/stop inside
  each demo script, so a demo is a single `npm run <name>`.

## 5. Code Organization — keep it organized

- **Respect module boundaries.** Never import across the security layers in ways
  that break separation of powers (e.g. the guard must never read the wallet,
  providers must never touch the treasury). Each layer owns its imports.
- **Never bypass the guard** with a downstream `if` after a parse — structural
  rejection is the only path into the execution context.
- **Follow existing patterns:** shared types in `src/types.ts`, provider catalog
  in `src/config/providers.ts`, task graph in `src/config/taskGraph.ts`, demos in
  `scripts/`, NodeNext style with `.js` import suffixes, strict TS.
- **Keep `npm run typecheck` clean.** `noUnusedLocals`/`noUnusedParameters` are
  on — remove dead code rather than silencing it.
- **No comments unless they earn their place.** The codebase uses small, deliberate
  doc-comments to explain *why* (e.g. idempotency semantics, guard philosophy).
  Match that tone; don't narrate the obvious.
- **Don't add dependencies without asking.** The repo is intentionally minimal
  (`zod`, `ws`, `tsx` today).

## 6. Commands (verified from `package.json`)

| Task | Command | Notes |
|---|---|---|
| Typecheck | `npm run typecheck` | must stay clean before done |
| Happy-path walkthrough | `npm run preview` | Phase 0 legacy |
| Executor/treasury/approval | `npm run demo2` | Phase 2 legacy |
| Failure injection / fallback | `npm run demo3` | Phase 3 legacy |
| Adversarial guard demo | `npm run guard` (alias `npm run phase4`) | Phase 2 |
| Bandit routing demo | `npm run demo5` | Phase 5 |
| Bandit eval harness | `npm run bandit-eval` | Phase 5; writes `data/bandit-report.json` |
| Static dashboard | `npm run dashboard` | http://127.0.0.1:4200 |
| Live trace server | `npm run trace-server` | http://localhost:4300 (+ `/ws`) |
| UI dev server | `cd ui && npm run dev` | http://localhost:5173 (Phase 3, in progress) |

First run: `npm install` at the root (and in `ui/`). The `ui/` live-trace UI is
**not yet runnable** — it is the half-built Phase 3 (React Flow components and
`useWs` hook exist, but `react`/`react-dom` are not yet in `ui/package.json` and
`main.ts` is still the default Vite template).

## 7. Boundaries

### Always
- Update the docs (section 4) and keep typecheck clean with every change.
- Show command output as evidence before claiming a phase is done.
- Follow the existing module/pattern conventions (section 5).

### Ask first
- Adding a dependency.
- Restructuring a module boundary or the guard contract.
- Anything touching wallet/treasury security semantics.

### Never
- Commit secrets, keys, or real-fund addresses.
- Use anything but simulated/testnet funds.
- Let a provider response reach state without passing the guard.
- Mark a phase done without a clean demo + typecheck.

---

_Keep this file and the `docs/` in sync with reality. When in doubt about current
status, read `docs/README.md` and `docs/todo.md` first._

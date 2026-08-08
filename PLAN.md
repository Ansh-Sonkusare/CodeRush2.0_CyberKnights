# PLAN — Data-driven catalog, prompt-aware routing & MVD/eval (integrated)

One integrated plan covering the "Plan Everything" workstream (provider catalog JSON, prompt-aware
router, prompt-driven fallback graphs) plus the MVD demo criteria, evaluation harness, and hard-mode
extensions. UI showcase changes are mapped one-to-one to every criterion so a judge can see each demo
point live.

## Context / decisions (already made)

- Execution order: **MVD path first, then eval**.
- Reconcile view lives in the **right inspector as a new tab**.
- **Demo presets picker** wired into the sidebar (renders the existing, currently-unrendered
  `DEMO_FLOWS` array).
- The 5-step MVD parallel graph **replaces the wallet-assessment fallback graph**; Zerion/LLM providers
  stay registered and reachable via a wallet-assessment preset.
- `catalog.json` seeds **all 7 capabilities** (search/extract/translate/rank/verify + the 3 core caps)
  with **≥2 mock providers each** (primary + fallback), so MVD 1's "fallback provider per node" and the
  prompt-aware router's price/quality tradeoffs both work.
- **Adversarial mock providers live in `catalog.json`** (`kind: "adversarial"` + `mode`), built by the
  same loader.

## Re-evaluation — what's not built (verified against source)

| Plan item | Status today |
|---|---|
| `catalog.json` + loader | **Not built** — registration hardcoded in `apps/service-providers/src/index.ts:83-117` (simulated) / `:42-82` (x402). `ProviderCatalogEntrySchema` (`packages/schemas/src/provider.ts:19`) has no `kind` field; no file schema; real Zerion/LLM adapters hardcode metadata. |
| Prompt-aware router | **Not built** — `WeightedRouter` accepts weights (`packages/router/src/index.ts:114-118`), `createRouter(adapters,{mode,weights})` exists (`:315`); no `RouteProfile`/`weightsForGoal`/`weightsForProfile`/`resolveWeights` anywhere. |
| Route profile from planner | **Not built** — `PlannerGraphSchema` (`packages/schemas/src/planner.ts:46`), `PLANNER_GRAPH_JSON_SCHEMA` (`:58`), `PlanOutcomeSchema` (`:178`) carry no `route_profile`; `SYSTEM_PROMPT` (`apps/service-planner/src/planner.ts:13-26`) doesn't ask for it; `fallback.ts` has only the static 3-node `FALLBACK_GRAPH`. |
| Wire into orchestrator/taskMachine | **Partially there** — `TaskRunnerOptions.router` is already a thunk `() => Router` (`packages/orchestrator/src/taskRunner.ts:51`), invoked at `:145` **without goal**; service-orchestrator passes `() => currentRouter` (`apps/service-orchestrator/src/index.ts:111`); `taskMachine.ts` planning onDone does not rebuild `deps.router`. `flow.test.ts`'s `() => router` stays assignable to `(goal) => Router`. |
| UI polish | **Not built** — `ExecutionStatusSchema` (`packages/schemas/src/node-state.ts:108`) has no `route_profile`; ledger **stores** `route_reason` (`packages/schemas/src/ledger.ts:60,104,136`, set at `packages/orchestrator/src/nodeMachine.ts:173`) but the UI doesn't surface it; `DEMO_FLOWS` unrendered. |
| Tests (`router/catalog/planner`) | **Not built** — no `tests/router.test.ts`, `catalog.test.ts`, `planner.test.ts`. |

Also confirmed: `CAPABILITIES` already includes `search/extract/translate/rank/verify` with strict
response schemas (`packages/schemas/src/capability.ts:5-63`) — the catalog can seed them today.

## Parallelizable plan — waves of independent workstreams

Each **workstream (WS)** is a self-contained unit a subagent can own end-to-end. Workstreams in the
same **wave** run in parallel because their file ownership is **disjoint** — no two agents touch the
same file. Dependencies only flow forward between waves, and every wave ends with a **verification
gate** (`pnpm -r typecheck` + that wave's tests).

Rules for every subagent:

1. **Own only the files listed** in its WS — never edit a file another WS owns, even for a trivial fix.
   If a change is needed in another WS's files, note it in the handoff instead.
2. Consume the **interface contracts** below (published by Wave 0) via `@sentinel/schemas` — never
   redefine a shape locally.
3. End by running `pnpm -r typecheck` and the WS's own new test file(s); a WS is done only when both pass.
4. All new wire shapes land in `packages/schemas` (Wave 0 owns that package) — each WS adds nothing to it.

```
Wave 0  [1 agent]  Foundation: schemas ─────────────────────────────────────────────
Wave 1  [4 agents in parallel]  WS-A catalog · WS-B router · WS-C planner · WS-D ledger
Wave 2  [2 agents in parallel]  WS-E orchestration+x402 · WS-F UI showcase
Wave 3  [2 agents in parallel]  WS-G hard modes · WS-H tests consolidation
Wave 4  [1 agent]               WS-I eval harness
Wave 5  [1 agent]               WS-J docs/demo
```

### Wave 0 — Foundation: schemas (single agent, `packages/schemas/**`)

Everything downstream consumes these shapes, so this package is single-writer and lands first.
All `.strict()`.

- `RouteProfileSchema` (`price | quality | latency | balanced`).
- Optional `route_profile` on `PlannerGraphSchema`, `PLANNER_GRAPH_JSON_SCHEMA`, both `PlanOutcomeSchema`
  variants, and `ExecutionStatusSchema`. `ExecutionStatusSchema.route_profile` carries
  `{ profile, source }` where `source: "llm" | "heuristic"`.
- New `ProviderCatalogFileEntrySchema` (`.strict()`): `ProviderCatalogEntry` fields + `kind`
  (`mock | adversarial | zerion | llm-summary | llm-credit`), optional `mode`
  (`budget_mutation | scope_expansion | prompt_injection | receipt_forgery`), plus MVD knobs:
  `failMode` (`after_402 | deliver | rate_limit | price_drift | network_mismatch`), `scheme`
  (`exact | upto`), `uptoActual`, `priceDriftPct`, `network`.
- `rate_limited` provider error kind; `network` on Quote/Capability; `PaymentReceipt` +=
  `scheme, actualAmount`.
- `ReconciliationReportSchema` + row shape.
- **Gate 0**: `pnpm -r typecheck` + existing suite green. Publish the contracts below for Wave 1.

### Wave 1 — four agents in parallel

#### WS-A — Catalog (`apps/service-providers/**`)
Depends on: `ProviderCatalogFileEntrySchema` (Wave 0). Owns: `apps/service-providers/**`.
- `data/catalog.json` as the single source of truth + `src/catalog.ts` loader
  (`new URL("../data/catalog.json", import.meta.url)` — identical under src/ dev and dist/ build),
  zod-validated, fail-fast at boot.
- Seed: zerion + llm-summary + llm-credit real kinds; **all 7 capabilities with ≥2 mock providers
  each** (primary + fallback); adversarial providers via `kind: "adversarial"` + `mode`.
- Real adapters (`providers/zerion.ts`, `providers/llm.ts`) gain optional
  `priceHint / latencyHintMs / qualityScore` constructor overrides (defaults preserved so existing
  tests pass).
- `index.ts` simulated branch → `loadCatalog(config)`; the `X402_MODE=algorand` branch stays untouched.
- New `POST /api/providers/:id/fail-mode` endpoint (or folded into the fail/recover route) for the
  "fail after payment" demo knob — this is the contract WS-F consumes.
- New test file: `tests/catalog.test.ts` (`catalog.json` parses; adapter metadata matches JSON).
- **Gate**: typecheck + catalog tests.

#### WS-B — Prompt-aware router (`packages/router/**`)
Depends on: `RouteProfileSchema` (Wave 0). Owns: `packages/router/**`.
- `weightsForGoal(goal)` — keyword heuristic (cheap/budget/cost → price; quality/best/reliable →
  quality; fast/low-latency → latency; tie/none → balanced).
- `weightsForProfile(profile)` — e.g. price → `{0.8, 0.1, 0.1}`, quality → `{0.1, 0.1, 0.8}` +
  raised qualityThreshold, latency → `{0.2, 0.7, 0.1}`, balanced → defaults.
- `resolveWeights(goal, llmProfile?)` — LLM profile wins, heuristic is the fallback.
- `WeightedRouter` / `createRouter` unchanged — they just receive different weights per run.
- `select()` gains a `network` filter parameter (multi-network prep) — keep it optional so Wave 1
  callers compile unchanged.
- New test file: `tests/router.test.ts` (`weightsForGoal`/`weightsForProfile`/`resolveWeights`;
  WeightedRouter picks the cheap provider under price weights and the premium one under quality).
- **Gate**: typecheck + router tests.

#### WS-C — Planner emits profile + fallback graphs (`apps/service-planner/**`)
Depends on: `route_profile` on `PlannerGraphSchema`/`PlanOutcomeSchema`/`PLANNER_GRAPH_JSON_SCHEMA`
(Wave 0). Owns: `apps/service-planner/**`.
- `SYSTEM_PROMPT` instructs the LLM to emit an optional `route_profile`.
- `planner.ts`: on LLM success use the emitted profile (fallback to `weightsForGoal` if absent/invalid);
  on the fallback path compute it heuristically.
- `fallbackGraphForGoal(goal)`: keyword-driven graphs — research/news prompts add
  search/extract/verify steps (+ a parallel rank variant for "top"/"rank" goals); wallet default keeps
  the 3-step graph. The MVD 5-step parallel demo graph
  (`search → extract ‖ translate → rank → verify`) is one of these.
- Keep a static default export for the `/planner/fallback` preview endpoint and the UI.
- New test file: `tests/planner.test.ts` (`fallbackGraphForGoal` returns schema-valid graphs for
  research vs wallet prompts, includes `route_profile`).
- **Gate**: typecheck + planner tests.

#### WS-D — Shared ledger + reconcile (`packages/config/**`, `packages/ledger/**`, `apps/gateway/**`)
Depends on: `ReconciliationReportSchema` (Wave 0). Owns: `packages/config/**`, `packages/ledger/**`,
`apps/gateway/**`.
- `resolveLedgerPath(config)` in `packages/config` — walk up to the workspace root so gateway **and**
  orchestrator read the **same SQLite file** (today `apps/gateway/src/index.ts:10` and
  `apps/service-orchestrator/src/index.ts:30` resolve each from their own cwd → two stores). The
  orchestrator's call site is updated in WS-E (it owns `apps/service-orchestrator`).
- `exportTaskReconciliation(taskId)` in `packages/ledger`.
- `GET /api/ledger/task/:taskId/reconcile` on the gateway — this is the contract WS-F consumes.
- Fix `apps/gateway/src/index.ts` to use `resolveLedgerPath`.
- **Gate**: typecheck + ledger/gateway tests; manual curl of the reconcile route against a seeded store.

### Wave 2 — two agents in parallel

#### WS-E — Orchestration hardening + fail-after-402 + exact/upto (`packages/orchestrator/**`, `packages/x402-client/**`, `apps/service-orchestrator/**`, `packages/treasury/**`)
Depends on: WS-B (router), WS-C (`route_profile` on PlanOutcome), WS-D (`resolveLedgerPath`).
Owns: `packages/orchestrator/**`, `packages/x402-client/**`, `apps/service-orchestrator/**`,
`packages/treasury/**`.
- `TaskRunnerOptions.router` → `(goal: string) => Router`, called with `request.goal`
  (`taskRunner.ts:145`); service-orchestrator passes
  `(goal) => createRouter(adapters, { weights: weightsForGoal(goal) })`.
- `taskMachine` planning onDone: if `outcome.route_profile` is set, rebuild
  `context.deps.router = createRouter(adapters, { weights: weightsForProfile(profile) })`
  (run-local deps, documented mutation). Retries/fallback then re-route through the profile-aware router.
- `SimulatedX402Client.failNextPayment()` / `setFailure(phase)` — facilitator outage post-402 →
  `chain_error`; **record failed idempotency keys** so a retry returns the same error without re-signing.
- Mock `after_402` failMode wiring (consumes WS-A's mock `failMode` field).
- `nodeMachine.ts` retry audit: `treasury.release` before re-route; settlement stage kept on
  paid-then-failed; `excluded` accumulates so dead providers aren't re-picked; stale-quote guard at
  pay time.
- Sub-budget pause/approve + price guards + exact/upto: 5-step pause/approve test asserting
  spent+reserved ≤ cap at every poll; quote-expiry + >25% price drift → exclude + re-route;
  pay-time amount mismatch → re-quote; `upto` settles `min(amount, actual)`, over-amount →
  `scope_exceeded`.
- Update `apps/service-orchestrator/src/index.ts` to use `config.resolveLedgerPath` (WS-D's export).
- New test file: `tests/mvd.test.ts` (5-step parallel run with parallel timestamps; fail-after-402 →
  reroute → completed with declared_failure + success rows and unique idempotency keys;
  sub-budget pause/approve; reconcile shape + dup-check). Existing `tests/flow.test.ts`
  (`router: () => router` thunk) remains type-assignable.
- **Gate**: typecheck + mvd/flow tests; manual full-stack run.

#### WS-F — UI showcase (`apps/web/**`)
Depends on: Wave 0 schemas (`route_profile` on ExecutionStatus, scheme/network), WS-A fail-mode
endpoint, WS-D reconcile endpoint. Owns: `apps/web/**`.
Every feature derives wire shapes via `.pick()/.extend()` from `packages/schemas`; WS frames remain
the same discriminated unions.

**MVD 1 (5-step, ≥3 providers, parallel + fallback)**
- TaskGraph renders the 5-step DAG (`search → extract ‖ translate → rank → verify`); add
  `CAPABILITY_COLORS` for the 5 new capabilities (`apps/web/src/components/StepNode.tsx:13-22`).
- Node cards gain selected provider + scheme + network chips and a **fallback indicator**
  ("fell back to {provider}") when `excluded`/reroute happened.
- Sidebar callout: live step count / provider count (≥3).

**MVD 2 (fail-after-402, no double-spend, reroute)**
- Provider catalog cards gain a **"fail after payment" knob** (`setFailMode(id, "after_402")` via
  WS-A's endpoint).
- Events tab highlights **re-routed** transitions (new style tag on `node_state` retry frames) +
  route_reason.
- Ledger rows expose the **idempotency key** column (stored today, unrendered).

**MVD 3 (sub-budget pause/approve)**
- Existing pause panel extended to show which **nodes/branches** triggered it
  (`PauseInfoWire.nodeIds/amounts` already in the frame — render them) + a spent-vs-projected budget bar.

**MVD 4 (reconciliation)**
- Reconcile tab (fed by WS-D's route): task summary cards (total paid, success/declared_failure/
  pending, **dup-payment check = 1.0**, **budget adherence = 0 overspend**, timeline) + per-request
  table (node, capability, provider, scheme, quoted/actual, idempotency key, tx_ref, outcome,
  violations) with **stages drill-down** (already fetched, unrendered) — proves "every paid request
  tied to a result or declared failure".

**Prompt-aware routing**
- Header **route_profile chip** showing `price | quality | latency | balanced` **and** resolution
  source (`LLM` vs `heuristic`) from `ExecutionStatusSchema.route_profile`.
- **route_reason tooltip** on the ledger provider cell (`route_reason` stored at
  `packages/schemas/src/ledger.ts:60`).
- Demo presets **"cheapest run" / "quality run"** set goal text so `weightsForGoal` flips the pick;
  catalog cards show price/latency/quality bars so the *why* is visible.

**Data-driven catalog**
- Sidebar catalog panel becomes the `catalog.json` readout: kind badges (real/mock/adversarial),
  scheme/network chips, failMode control, price/latency/quality bars.

**Demo presets picker (all criteria)**
- Sidebar buttons rendered from the existing unrendered `DEMO_FLOWS`: **5-step parallel**,
  **fail-after-402 reroute**, **sub-budget pause → approve**, **reconcile**, **cheapest run**,
  **quality run** — each sets knobs (cap, attackNode, failMode) + goal text + run request.
- **Gate**: typecheck + web build; manual smoke against the running stack (Wave 1 + WS-E up).

### Wave 3 — two agents in parallel

#### WS-G — Hard modes + multi-network (`apps/service-providers/src/providers/mock.ts`, `packages/policy-guard/**`, `packages/router/**` (network filter), `tests/hardmode.test.ts`)
Depends on: WS-A (failMode knobs), WS-B (network filter), WS-E (nodeMachine retry).
Owns: `packages/policy-guard/**`, `apps/service-providers/src/providers/mock.ts` (only the rate_limit /
prompt_injection / receipt_forgery / network_mismatch behaviors), `tests/hardmode.test.ts`. Do **not**
touch `packages/router/**` beyond calling the network filter WS-B already added.
- `rate_limit` → retryable + ledger note.
- `prompt_injection` / `receipt_forgery` → guard blocks with those violation types.
- Parallel-failure cascade test (branch A blocked, branch B settles).
- Register 1–2 `algorand:beta` providers in `catalog.json` via WS-A's file format + wire the router
  network filter + client refusal on cross-network.
- **Gate**: typecheck + hardmode tests.

#### WS-H — Tests consolidation (`tests/**`)
Depends on: WS-A/B/C/E (their test files). Owns: `tests/**` — fills gaps, keeps the suite green,
does **not** create `tests/hardmode.test.ts` (WS-G owns it) or `tests/mvd.test.ts` (WS-E owns it).
- Sweep: run `pnpm test`, fix flaky/ordering issues, add any missing coverage for the Wave 0–2 shapes.
- **Gate**: full `pnpm test` + `pnpm -r typecheck` + `pnpm -r lint` green.

### Wave 4 — Eval harness (single agent, `packages/eval/**`, root `package.json` "eval" script)

- CLI: `pnpm eval --trials N --seed S --profile price|quality|balanced`.
- Seeded held-out subsets (1–3 of N providers per capability), random phase failures, budgets forcing
  pause/approve, exact/upto + price-drift + multi-network variants.
- Metrics: task success, route optimality vs zero-failure optimal, budget adherence (overspend = 0),
  dup-payment rate (unique txRefs/payments = 1.0), settlement correctness, fallback recovery, latency, cost.
- JSON + summary report. Does **not** edit `.env.example` (WS-J owns it) — only the root `eval` script.
- **Gate**: `pnpm eval --trials 50` runs clean.

### Wave 5 — Docs/demo (single agent, docs files only)

- PRD §3 + MVD/eval section.
- Demo script (walks the presets in order: 5-step parallel → fail-after-402 → pause/approve →
  reconcile → cheapest/quality runs).
- `.env.example` (shared `LEDGER_PATH`, eval/profile knobs).
- **Gate**: demo script executed against the running stack.

## Interface contracts (published at Gate 0)

| Contract | Shape (Wave 0) | Consumed by |
|---|---|---|
| `route_profile` on PlanOutcome/PlannerGraph | `{ profile: RouteProfile, source: "llm" \| "heuristic" }` (optional) | WS-C, WS-E, WS-F |
| `route_profile` on ExecutionStatus | `{ profile, source }` (optional) | WS-F chip |
| `ProviderCatalogFileEntrySchema` | entry + `kind`/`mode`/`failMode`/`scheme`/`uptoActual`/`priceDriftPct`/`network` | WS-A, WS-E, WS-F, WS-G |
| Reconcile route | `GET /api/ledger/task/:taskId/reconcile` → `ReconciliationReportSchema` | WS-F |
| Fail-mode endpoint | `POST /api/providers/:id/fail-mode` (body: `{ mode }`) | WS-F, WS-G |
| Router API | `select(cap, exclude?, network?)` + `weightsForGoal/weightsForProfile/resolveWeights` | WS-B exports → WS-E, WS-G |
| Ledger path | `resolveLedgerPath(config): string` | WS-D exports → WS-E |

## File-ownership matrix (no two agents touch the same file)

| Path | Wave/WS |
|---|---|
| `packages/schemas/**` | Wave 0 (sole writer) |
| `apps/service-providers/**` | WS-A (Wave 1); WS-G touches only `src/providers/mock.ts` + `data/catalog.json` (Wave 3, after WS-A) |
| `packages/router/**` | WS-B (Wave 1); WS-G reads, does not edit |
| `apps/service-planner/**` | WS-C (Wave 1) |
| `packages/config/**`, `packages/ledger/**`, `apps/gateway/**` | WS-D (Wave 1) |
| `packages/orchestrator/**`, `packages/x402-client/**`, `apps/service-orchestrator/**`, `packages/treasury/**` | WS-E (Wave 2) |
| `apps/web/**` | WS-F (Wave 2) |
| `packages/policy-guard/**` | WS-G (Wave 3) |
| `tests/*` | WS-A→`catalog.test.ts`, WS-B→`router.test.ts`, WS-C→`planner.test.ts`, WS-E→`mvd.test.ts`, WS-G→`hardmode.test.ts`, WS-H→everything else (Wave 3) |
| `packages/eval/**`, root `eval` script | WS-I (Wave 4) |
| `PRD.md`, `*.md` docs, `.env.example`, demo script | WS-J (Wave 5) |

## Verification gates

- **Gate 0** (after Wave 0): `pnpm -r typecheck` + existing suite green; contracts published.
- **Gate 1** (after Wave 1): `pnpm -r typecheck` across all 4 WS + `router/catalog/planner` tests;
  curl the reconcile route against a seeded store.
- **Gate 2** (after Wave 2): full typecheck; `flow.test.ts` + `mvd.test.ts`; manual full-stack smoke
  (all six demo presets clickable, Reconcile tab renders).
- **Gate 3** (after Wave 3): `hardmode.test.ts` + full `pnpm test` + `pnpm -r lint`.
- **Gate 4** (after Wave 4): `pnpm eval --trials 50` clean (overspend = 0, dup-payment rate = 1.0).
- **Gate 5** (after Wave 5): demo script runs end-to-end against the stack.

## Definition of done (per task-node feature / phase)

- [ ] New shapes added to `packages/schemas`, `.strict()` where they guard a trust boundary
- [ ] No new `any`, no new bare `as` casts on external input
- [ ] Money values are branded MicroAlgo, not raw `number`
- [ ] Providers implement the shared `ProviderAdapter` interface, no special-casing upstream
- [ ] Payment path goes through treasury reserve → settle, not a direct pay call
- [ ] Guard validates the response before treasury/ledger touch it
- [ ] Ledger row written with idempotency key
- [ ] `pnpm -r typecheck`, `pnpm test`, and `pnpm -r lint` pass
- [ ] UI reflects new state via the same discriminated union, not a parallel shape

## Out of scope

- Real Zerion/LLM API wiring (exists; stays behind keys — without keys they fail at `quote()` and the
  router falls back to mock tiers, which always work).
- Real Algorand payments in the automated eval (simulated client only).
- Bandit optimizer as default (weighted is the target; bandit stays stretch/optional).

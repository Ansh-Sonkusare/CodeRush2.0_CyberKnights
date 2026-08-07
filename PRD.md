# PRD: x402 Sentinel — Adversarial-Resilient, Self-Optimizing Agent Payment Router (INF-01)

**Status:** Full build plan — no fixed time box, built with LLM-assisted development
**Source spec:** INF-01 — Multi-Provider Agent Payment Router & Treasury
**Team size assumption:** 4 people

---

## 1. One-line pitch

An agent payment control plane that dynamically plans a paid multi-step task, learns which providers to trust and route to over time, defends itself against providers that try to rewrite policy or forge results, and gives a judge a live, replayable, end-to-end reconciliation of every dollar spent — built on the real x402 protocol against a public testnet, not a simulated stand-in.

## 2. Why this angle, not the textbook build

The spec's minimum viable demonstration (happy path, forced failure, budget breach, reconciliation export) is what most teams will build as a CLI/JSON table over a hand-rolled fake 402. Two lines in the spec are usually treated as footnotes but are explicitly part of the judged bar:

> "A provider or result must never be allowed to rewrite the payment policy, raise a budget, or gain access to unrelated wallet scopes."
> "...design for replay: a judge should be able to run the same scenario again and inspect the trace."

We make both the centerpiece, and go one step further than most teams will bother with: run the **actual x402 reference protocol** on a public testnet (Base Sepolia) instead of a mocked handshake — still fully "simulated/testnet funds only" per the safety boundary, but real signed payment payloads and real settlement, not an invented stand-in.

---

## 3. What we are building

### 3.1 Dynamic task planner
An LLM produces the task graph itself from a high-level goal — steps, dependencies, parallel branches — rather than a hardcoded graph. Output is constrained to a Zod schema (task graph shape: nodes, edges, capability required per node) so the response is always structurally valid or it fails cleanly.
- Backend is swappable: **Gemini API** (`@google/genai`, Zod-typed structured output) or a **local model via Ollama** (same Zod schema, converted to JSON schema for Ollama's `format` param) behind one interface — useful if API access is flaky during the demo, and a good talking point ("runs fully offline too").
- Falls back to a hardcoded graph if planning output fails schema validation or times out — the demo never depends on a live model call succeeding.
- Avoids purchasing redundant evidence (dedupe near-identical sub-requests before they cost money).

### 3.2 Provider catalog with real heterogeneity
6–10 provider entries with genuine variety, built against the **real x402 TS SDK** (`@x402/core`, `@x402/evm`, `@x402/express` server-side, `@x402/fetch` client-side) on Base Sepolia testnet with `viem` test wallets:
- Multiple payment schemes (`exact` fixed price, `upto` price ceiling)
- Price/latency/quality metadata, some deliberately stale or conflicting
- 3–4 adversarial providers (see §3.5) whose *response body*, not the payment layer itself, carries the attack

### 3.3 Adaptive route optimizer
- **Baseline:** weighted score over price/latency/quality, human-readable "why" output
- **Learning mode:** multi-armed bandit (Thompson sampling or UCB1) adapting provider choice online as quality/latency drift mid-run, evaluated against held-out provider combinations
- Small evaluation harness running both modes over the same task stream, reporting cumulative cost/regret as evidence

### 3.4 Treasury / policy layer
- Per-task, per-provider, per-network, and time-window budgets
- Spend reservation on route selection (reserve → release on failure → settle on success)
- Risk thresholds and allowlists (a provider can be excluded after repeated violations)
- Pause-for-approval path with a real, clickable approval action in the UI

### 3.5 Policy guard — core differentiator
Every provider response is parsed through a strict Zod schema **before** it can touch treasury or wallet state — a `.safeParse()` failure or a disallowed field is a structural rejection, not a downstream `if` check. At least three attack patterns, each its own adversarial mock provider:
1. **Budget mutation attempt** — response tries to raise the spend cap or self-approve overpayment
2. **Scope expansion attempt** — response tries to request wallet capability or provider access it wasn't authorized for
3. **Result/prompt injection** — response embeds an instruction meant for the orchestrating agent rather than data
4. *(stretch)* **Receipt forgery** — response claims settlement succeeded with no matching on-chain transaction

Each is caught, logged as `blocked_policy_violation` with the violation type, task continues on declared failure.

### 3.6 Fallback and recovery
- Provider outage mid-flow → automatic fallback to next-best catalog provider
- Stale quote (price changed between 402 and payment) → re-validate before paying
- Partial completion → task terminates with partial results clearly marked
- Idempotency keys on every payment attempt → no double-settlement under any of the above, enforced at the `@x402/evm` client wrapper level

### 3.7 Reconciliation ledger + replay
- One append-only row per paid call: request → 402 terms → payment → settlement → response → receipt → outcome
- Full task export as JSON
- Replay mode: reload a past task, step through it node by node
- Replay with a changed provider offer: re-run with one provider's price changed, show which routing decisions change and which policy stays fixed

### 3.8 Live trace UI
- Real-time task graph diagram (React Flow) over WebSocket — nodes light up as they quote/pay/settle
- Blocked-attack nodes flash distinctly with the guard's reason shown inline
- Approval-pause state is interactive — click approve/deny live
- Replay view reuses the same graph component, scrubbing through a saved trace

### 3.9 Open marketplace via x402 Bazaar
Instead of a fixed provider catalog, run a local facilitator with the x402 **Bazaar discovery extension** (`@x402/extensions/bazaar`) enabled. Any x402 service — yours, a teammate's, a real external one — becomes a listed, routable provider just by wrapping its endpoint in `paymentMiddleware({ discoverable: true })` and pointing it at your facilitator. No listing database or submission UI to build; discovery comes from `client.extensions.discovery.listResources()`.
- **Hybrid catalog:** a small, guaranteed-reliable set of your own providers (including the adversarial ones — see §3.5) plus a live query against Bazaar for anything else currently listed, including real services like Zerion's own x402-payable API.
- **This is the strongest argument for the guard, not a separate feature.** Once listing is open, every provider is unvetted by default — the policy guard isn't hardening a curated demo catalog anymore, it's the only thing that makes an open, permissionless marketplace safe to route real budget through. Say this explicitly in the demo.
- New providers start at a capped per-provider budget / lowest risk tier (ties into the existing treasury allowlist in §3.4) until they've settled a few clean transactions — a newly-listed provider doesn't get full trust on day one.

### 3.10 Zerion — independent settlement verification + treasury view
- **Reconciliation cross-check:** after each payment, query Zerion's transaction API for the treasury wallet and confirm a matching on-chain transaction actually exists before marking a ledger row `settled`. This makes receipt forgery (§3.5, attack #4) catchable independent of your own wallet adapter's self-reported status — a stronger claim than internal consistency alone.
- **Live treasury view:** pull real wallet balance/PnL from Zerion's portfolio endpoint and surface it in the trace UI next to your internal budget tracker — "what our ledger says" vs. "what the chain says," side by side, updating live.
- Zerion itself is x402-payable on Base, so it can also just be one of your marketplace listings — a real, recognizable name in the catalog alongside your mocks.

---

## 4. Non-negotiable safety boundary (from source spec)

- Simulated/testnet funds only — Base Sepolia test USDC, faucet-funded wallets, never real money, even though the protocol itself is real
- No raw key/seed in agent context — only a scoped "pay up to X for provider Y" token; the planner and route optimizer never see the signer
- **No provider response can rewrite budget policy or expand wallet scope — enforced structurally by the guard sitting between provider response and treasury/wallet, never as a downstream check**
- The dynamic planner is bounded: it can propose task graphs, never budgets or wallet scopes — those stay under the treasury layer's exclusive control regardless of what the planner or any provider suggests

---

## 5. Suggested tech stack

| Layer | Choice | Why |
|---|---|---|
| Payment protocol | `@x402/core`, `@x402/evm`, `@x402/express`, `@x402/fetch` on Base Sepolia + `viem` | Real protocol, real signed payments, still testnet-safe |
| Task orchestration | XState v5 | Parallel states + guarded transitions map directly onto the task graph and policy guard; Stately inspector doubles as a debugging/visualization aid |
| Planner LLM | Gemini API (`@google/genai`) or local via Ollama, both Zod-schema-constrained | Swappable backend behind one interface; local fallback if API access is unreliable during demo |
| Schema / policy guard | Zod | One schema library for both planner output validation and provider-response validation; `.safeParse()` gives a clean accept/reject path; feeds `zod-to-json-schema` for both Gemini and Ollama structured output |
| Ledger | Postgres + `LISTEN/NOTIFY` (or libSQL/Turso for zero-ops) | Append-only table doubles as the event log; replay is just re-querying ordered by timestamp |
| Live trace UI | React + React Flow + WebSocket (`ws` or Socket.io) | Purpose-built node/edge graph, live status updates on nodes |
| Route optimizer | Plain TypeScript (bandit math, no framework needed) | Keep it simple and inspectable |

---

## 6. Team split (4 people)

- **Dev A — providers & wallet:** real x402 provider catalog on Base Sepolia, multi-scheme mock providers, all adversarial variants, `viem` wallet adapter with idempotency
- **Dev B — treasury & guard:** budget/risk/allowlist layer, Zod-based policy guard, ledger schema
- **Dev C — frontend & replay:** React Flow live trace UI, WebSocket wiring, interactive approval UI, replay engine including offer-change diffing
- **Dev D — planning & routing:** Gemini/Ollama-backed planner with hardcoded fallback, baseline + bandit route optimizer, held-out evaluation harness

---

## 7. Suggested build order (sequence matters more than hours)

1. Ledger schema + Zod guard contract (what fields a provider response is *allowed* to touch) — lock this before anything else
2. Hardcoded task graph + baseline route optimizer + happy path end-to-end against real x402 testnet providers — this is your safety-net demo, get it solid first
3. Live trace UI wired to the happy path — visual proof of life early
4. Idempotency + forced failure + budget breach + pause/approval
5. Policy guard live: wire in the first adversarial provider (budget mutation), confirm it's blocked structurally, visible in UI
6. Add remaining adversarial providers (scope expansion, injection, receipt forgery if time allows)
7. Swap in the LLM-driven planner (Gemini or Ollama) behind the hardcoded graph as fallback; verify graceful degradation on schema failure
8. Add bandit route optimizer + held-out evaluation harness, A/B against baseline
9. Multi-scheme (`exact`/`upto`) and stale-quote handling
10. Replay mode, then replay-with-changed-offer
11. Rehearse the full demo script end-to-end, including a deliberate planner failure to show the fallback works

---

## 8. Demo script

1. **Happy path (dynamic):** give the planner a goal, watch it produce the task graph live, route optimizer explains each pick, live UI lights up node by node including the parallel branch — real testnet payments happening underneath.
2. **Forced failure:** kill a provider after 402, before settlement — ledger marks `declared_failure`, no duplicate payment, fallback provider swapped in automatically.
3. **Budget breach:** tight cap re-run — task pauses, UI shows a live, clickable approval prompt.
4. **The attacks:** run through 2–3 adversarial providers back to back — each caught structurally, each shown red on the live graph with the specific violation type and rejected field.
5. **Stale quote:** re-run with a provider's price changed between quote and payment — router catches the mismatch and re-validates rather than paying blind.
6. **Reconciliation + replay:** export the ledger, reload it in replay mode, then replay the same task with a changed provider offer and show which decisions change and which stay fixed.
7. **(If planner degrades):** deliberately break the LLM planner call and show the hardcoded-graph fallback keeps the task running — safe by construction, not just on the happy path.

---

## 9. Success criteria for judging

- Zero unauthorized budget overspends, across every scenario including adversarial ones
- Zero duplicate settlements under forced failure or retries, verified against real testnet transaction hashes
- Zero successful policy/scope violations — every attack caught structurally, not post-hoc
- Bandit route optimizer shows measurable improvement over baseline on held-out providers
- Every route decision, every dollar spent, and every blocked attack maps to a ledger row — visible live and replayable afterward, including under a changed provider offer

---

## 10. Stretch goals (only after §7 items 1–6 are solid)

1. Receipt forgery detection (4th attack type)
2. Simulated multi-network settlement mismatch handling
3. A second orchestration mode: composite workflow with conditional/skippable branches (borrowing from INF-03's workflow-compiler idea)
4. Role-based access on the approval UI (analyst vs. approver)
5. Self-hosted deployment on your existing k3s/Traefik homelab as a backup environment

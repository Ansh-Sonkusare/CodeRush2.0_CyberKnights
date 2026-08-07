# x402 Payment Router — Project Docs

Working docs for the Multi-Provider Agent Payment Router & Treasury (INF-01).
The two source PRDs live at the repo root (`PRD.md` = "Sentinel" framing,
`PRD-ORCH.md` = "orchestrator" framing). These docs are the working plan we
actually execute, updated with every change.

| File | Purpose |
|---|---|
| `context.md` | Distilled problem statement, the atomic transaction, security model |
| `plan.md` | Phased build plan with status and definition-of-done per phase |
| `todo.md` | Living, ordered checklist of current + upcoming work |
| `guard-contract.md` | The trust boundary — exactly what a provider response is allowed to touch |

## Current status

| Phase | Status | Demo |
|---|---|---|
| 0 — MVP baseline | ✅ done | `npm run preview`, `npm run demo2`, `npm run demo3` |
| 1 — Schemas & guard | ✅ done | `npm run guard` |
| 2 — Adversarial providers | ✅ done | `npm run guard` / `npm run phase4` |
| 3 — Live trace UI | ✅ done | `npm run trace-server` + `cd ui && npm run dev` |
| 4 — LLM planner + fallback | ✅ done | `npm run demo4` |
| 5 — Bandit routing + eval harness | ✅ done | `npm run demo5`, `npm run bandit-eval` |

## How to run

```bash
npm install
npm run typecheck      # TS sanity check (must be clean)
npm run preview        # happy-path walkthrough (legacy)
npm run demo2          # executor / treasury / approval (legacy)
npm run demo3          # failure injection / fallback (legacy)
npm run guard          # Phase 2 — adversarial attack demo (all 3 attacks blocked)
npm run phase4         # alias for npm run guard
npm run demo4          # Phase 4 — LLM planner (gemini | openai-compatible | ollama),
                       #   with hardcoded-graph fallback; reads LLM_PROVIDER /
                       #   LLM_BASE_URL / LLM_API_KEY / LLM_MODEL / LLM_TEMPERATURE /
                       #   LLM_MAX_TOKENS from .env.local or the shell
npm run demo5          # Phase 5 — UCB1 bandit wired into the executor (real HTTP, live learning)
npm run bandit-eval    # Phase 5 — held-out eval: bandit vs baseline, writes data/bandit-report.json

# Phase 3 — live trace UI (two terminals):
npm run trace-server   # http://localhost:4300 (+ /ws; serves /api/bandit-report)
cd ui && npm run dev   # open http://localhost:5173
```

The provider mock servers (ports 4101–4103) and adversarial servers
(ports 4104–4106) start and stop automatically inside each demo script and
inside `trace-server`. The static `dashboard` was retired in Phase 3.

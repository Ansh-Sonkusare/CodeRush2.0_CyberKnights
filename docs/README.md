# x402 Payment Router — Project Docs

Working docs for the Multi-Provider Agent Payment Router & Treasury (INF-01).
The two source PRDs live at the repo root (`PRD.md` = "Sentinel" framing,
`PRD-ORCH.md` = "orchestrator" framing). These docs are the working plan we
actually execute.

| File | Purpose |
|---|---|
| `context.md` | Distilled problem statement, the atomic transaction, security model |
| `plan.md` | Phased build plan with status and definition-of-done per phase |
| `todo.md` | Living, ordered checklist of current + upcoming work |
| `guard-contract.md` | The trust boundary — exactly what a provider response is allowed to touch |

## How to run

```bash
npm install
npm run typecheck      # TS sanity
npm run preview        # happy-path walkthrough (legacy)
npm run demo2          # executor / treasury / approval (legacy)
npm run demo3          # failure injection / fallback (legacy)
npm run guard          # Phase 1 — schemas & flow guard demo
npm run dashboard      # local dashboard on :4200
```

The provider mock servers start/stop automatically inside each demo script.

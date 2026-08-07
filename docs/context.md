# Context

Single-sentence pitch (from the PRDs):

> A policy-driven router that takes an agent's task, decomposes it into paid
> capability calls, and orchestrates every one of them as an **agentic x402
> transaction** — planning the calls, selecting providers by price/quality/latency,
> enforcing budgets, failing over safely, and reconciling every payment and
> result to a ledger — with no unrestricted wallet ever exposed to the agent.

## The atomic unit: the agentic x402 transaction

Every capability is bought as one five-phase transaction. This is the contract
every component implements.

```
AGENT TASK ─▶ ASK      router sends a capability request to a provider
                        provider responds 402 + terms (scheme, amount, resource)
                        │
               AUTHORIZE treasury checks budgets/allowlist/risk, RESERVES spend,
                        mints a scoped single-use token ("pay ≤ X to Y for R, valid ≤ T")
                        │        no signer, no raw key, no free-form wallet access
                        ▼
               PAY      scoped wallet adapter signs + settles with idempotency key
                        │
               VERIFY   settlement confirmed, response parsed through a STRICT
                        schema (the guard), result hash recorded
                        ▼
               RECONCILE row closed: quote → auth → payment → settlement → response
                        → result hash → outcome; verified result feeds next decision
```

## Non-negotiable invariants

- **Nothing enters the execution context un-guarded.** The router's next
  decision is made only from ledger-stamped, guard-passed results.
- **Nothing spends un-authorized.** The router proposes the call; the treasury
  disposes of the budget.
- **Nothing settles twice.** The idempotency key is minted at `ASK`, enforced
  at `PAY`, checked at `RECONCILE`.
- **Any phase can fail** and fallback semantics kick in — the router re-plans,
  never blindly retries.
- **A provider or result must never rewrite policy, raise a budget, or expand
  wallet scope.** This is enforced *structurally* (strict schema rejection), not
  by downstream `if` checks.

## Safety boundary (from source spec)

- Simulated/testnet funds only — never real money, even though the protocol is real.
- No raw key/seed in agent context — scoped "pay ≤ X to Y" tokens only.
- The planner can propose task graphs, never budgets or wallet scopes.

## Security model — separation of powers

| Role | Owns | Can never do |
|---|---|---|
| planner | decomposes task into a call graph | set budgets, expand scopes, sign |
| route optimizer | picks provider + records why | raise the reserved cap |
| treasury | budgets, reserves, allowlists, approval | spend without an authorized token |
| wallet adapter | scoped signing, idempotency | act outside the scoped token |
| **guard** | **structural validation of provider responses** | **be bypassed by any downstream `if`** |
| ledger | ground truth of every transaction | be mutated by providers or the router |

## Differentiator (what makes this worth judging)

1. Real x402 protocol behavior is the goal — the current MVP uses simulated
   providers/wallet; replacing with `@x402/*` on Base Sepolia is an explicit plan.
2. The policy guard is the only thing that makes an open, permissionless
   marketplace safe to route budget through. That is the demo's central claim.

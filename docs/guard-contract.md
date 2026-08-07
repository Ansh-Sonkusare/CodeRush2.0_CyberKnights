# Guard Contract — what a provider response is allowed to touch

> A provider or result must never be allowed to rewrite the payment policy,
> raise a budget, or gain access to unrelated wallet scopes.

This is enforced **structurally**: every provider response is parsed through a
strict Zod schema *before* it can touch treasury or wallet state or enter the
execution context. A `.safeParse()` failure or a disallowed field is a
structural rejection, not a downstream `if` check.

## Enforcement point

Guard sits at the **VERIFY** phase of the agentic transaction, between the
provider response and (a) the ledger, (b) the treasury, (c) the execution
context that feeds the next routing decision.

```
provider response ──▶ guard (strict .safeParse) ──▶ ledger / context / next decision
                          │
                          └─ failure ─▶ blocked_policy_violation logged (type + fields)
                                       row outcome = declared_failure
                                       executor re-routes to next-best provider
```

Nothing else reads a provider response. `paidCall.ts` only records guarded,
verified values into the ledger.

## The contract (strict = reject unknown fields)

### 1. 402 terms (`ASK`)

Allowed fields — **nothing else**:

| field | type |
|---|---|
| `invoice_id` | string |
| `provider_id` | string |
| `capability` | string |
| `price` | number |
| `currency` | string |
| `schema` | string |
| `terms_expires_at` | string |
| `payment_required` | boolean |

### 2. Result (`VERIFY`) — per capability

Allowed fields, strict per capability:

| capability | allowed fields |
|---|---|
| `search` | `urls: string[]`, `snippets: string[]` |
| `extract` | `title`, `body`, `word_count` |
| `translate` | `original`, `translated`, `language` |
| `rank` | `ranked: {url, score}[]`, `sources_considered: string[]` |
| `verify` | `verified: boolean`, `confidence: number`, `checks: string[]` |

### 3. Receipt (`RECONCILE`)

| field | type |
|---|---|
| `receipt_id` | string |
| `tx_ref` | string — must match the settlement `tx_ref` (else `receipt_forgery`) |
| `provider_id` | string |
| `settled_at` | string |
| `already_settled` | boolean |

## Violation types

Every rejection is logged as `blocked_policy_violation` with one of:

| type | trigger |
|---|---|
| `budget_mutation` | response tries to raise a cap / self-approve overpayment (e.g. `budget_cap`, `approve_overpayment`, `cap_override`) |
| `scope_expansion` | response requests wallet capability / access it wasn't authorized for (e.g. `private_key`, `signer`, `grant_access`, `scope`) |
| `prompt_injection` | response embeds an instruction meant for the orchestrating agent (e.g. `instruction`, `ignore_previous`, `system_prompt`) |
| `receipt_forgery` | receipt claims settlement with no matching tx (shape failure or `tx_ref` mismatch) |
| `schema_violation` | any other unknown/disallowed field |

Classification is a lookup over the **rejected (unknown) fields** against the
known attack key-sets; the guard is strict about rejecting regardless of which
bucket it lands in. Attack detection never loosens the contract — it only
improves the log.

## Ledger integration

- Violation appended to the ledger row's `violations[]` (id, type, stage,
  message, rejected_fields, timestamp).
- The affected stage (terms/response/receipt) is marked `failed` with the
  violation detail.
- Row outcome → `declared_failure`. The task continues via fallback routing.

## Non-negotiable rules

- The guard is never bypassed by a downstream `if`. If a response doesn't pass
  the strict schema, it doesn't enter state. Period.
- Strictness is the default: unknown fields are always rejected; attack
  classification only labels *why*.
- The guard can reject more than this contract lists; it can never accept less.

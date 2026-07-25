# Escrow Payment Logic — Build Report (run: 2026-07-25)

Pipeline: Architect → Coder → Tester → Manager, per `agent_workflow_charter.md`. Full Architect plan in `escrow_build_plan.md`. Code delivered as `escrow-service.zip`.

## What got built
Node.js/Express + SQLite escrow service implementing PRD §6/§7: order state machine (CREATED→HELD→SHIPPED→DELIVERED→RELEASED, with DISPUTED branching to RELEASED/REFUNDED), 3% platform fee in integer cents, Stripe Connect integration (stub mode by default, real test-mode via `STRIPE_SECRET_KEY`), background auto-release job (48h window, node-cron) sharing logic with a manual admin endpoint, dispute reason auto-tagging against PRD §7's valid/invalid list (informational only, never blocks filing), full audit trail, and a minimal static HTML/JS demo UI (checkout, order timeline, admin resolve page).

## Manager's verdict — launch-blocking issues (real money bugs)
1. **Auto-release doesn't re-check status before paying out.** If a buyer disputes an order right as the background sweep is processing it, the sweep can still pay the seller — confirmed in code (`orderService.js`, the release path has no `WHERE status='DELIVERED'` guard on its final update).
2. **No protection against double payment from concurrent actions.** Two near-simultaneous release/refund triggers (real Stripe network latency makes this a normal-width window, not a rare fluke) can each independently pass their check and each pay/refund once — confirmed as a genuine code gap (no transaction, no atomic conditional update).

## Fix before wider testing (not blocking a demo)
3. Malformed dispute input (non-string reason) crashes the server with a 500 instead of a clean error.
4. Malformed order-creation input (e.g. booleans for IDs) crashes with a raw DB error instead of a 400.
5. No check that the buyer isn't also the seller — someone could buy their own listing.

## Low priority
6. Negative/zero sale amounts aren't rejected (low risk until a listing-creation endpoint exists).
7. Dispute-reason auto-tagging uses loose substring regex (e.g. "crackers" tags as a valid crack/damage claim) — cosmetic, doesn't block filing, admin still decides.

## Scope check
Coder's implementation matches the Architect's plan with no concerning deviations. Self-disclosed additions (SQLite instead of Postgres for this pass, a couple of read-only helper endpoints for the demo UI, env-configurable fee/window) are reasonable and documented in the code's README.

## Recommendation (original)
The two launch-blocking items are both about the same root cause: state transitions aren't atomic. Worth fixing before this touches any real money, even in a pilot. Everything else can follow.

---

## Update — Fix round (same day)

Sal asked to prioritize logic soundness. Ran a second Architect→Coder→Tester→Manager pass (spec: `escrow_fix_plan.md`) to close all 7 items above.

**Fix applied:** every state transition that moves money (capture, release, refund) now follows an atomic *reserve → call Stripe → finalize-or-revert* pattern — a conditional `UPDATE ... WHERE status = <expected>` (checked via row-count) happens *before* the Stripe call, so two concurrent requests can never both pass the check. The loser gets a clean 409 instead of silently corrupting state or double-paying. On a Stripe failure, the order reverts to its prior state and the failure is logged, so it's safely retryable.

**What an independent Tester pass (not just the Coder's own tests) found and confirmed:**
- All 5 validation bugs (dispute-crash, amount validation, malformed id types, buyer==seller, loose regex): fixed and independently re-verified with fresh inputs.
- Both severe races (dispute-vs-release, double-payment): fixed under up to 10-way concurrency, Stripe-failure-mid-transaction (correct revert + retry), rapid repeated calls, and both possible race orderings engineered deliberately.
- **A 6th gap the fix plan hadn't scoped:** `captureOrder()` (the very first payment charge) had the identical unguarded race. Caught by the Tester, confirmed by the Manager, fixed in a follow-up round using the same pattern, then independently re-verified by a fresh reviewer pass.

**Final status: GO.** A final independent check read every Stripe call site in the file and confirmed none of them can still double-fire under concurrency, then generated its own fresh concurrency and end-to-end tests (not reusing prior scripts) — all passed, no new gaps found.

Updated code is in this delivery's `escrow-service.zip`.

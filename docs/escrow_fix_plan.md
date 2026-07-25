# Architect Fix Plan — Close the Race Conditions (round 2)

Context: prior Tester/Manager pass confirmed two launch-blocking bugs in `/home/claude/escrow-service/src/orderService.js` — both are check-then-act races across an `await` on the Stripe call, with no atomic guard on the DB write. Five lesser validation bugs also confirmed. This plan specifies the fix; Coder should implement exactly this, not redesign it.

## Root cause
`releaseOrder()` and the refund branch of `resolveDispute()` do: read status → (await Stripe call, event loop can interleave here) → unconditional `UPDATE orders SET status=... WHERE id=?`. Two concurrent callers (confirm/sweep/admin-resolve/dispute, any combination) can both pass the read-check before either writes.

## Fix: reserve the transition atomically *before* calling Stripe
Add two transient states: `RELEASING` (in-flight payout) and `REFUNDING` (in-flight refund). Every path that moves money follows this exact sequence:

1. **Reserve** — a single synchronous conditional update: `UPDATE orders SET status='RELEASING' WHERE id=? AND status IN (<allowed source states>)`. better-sqlite3 is synchronous (no `await` inside this call), so this statement cannot be interleaved by another request — whichever caller's UPDATE executes first wins, full stop.
2. **Check the result** — if `changes === 0`, the reservation failed (someone else already reserved it, or it's in a state that can't transition). Abort with a clear response (e.g. 409 "order already being released" or "order no longer disputable") — never proceed to call Stripe.
3. **Call Stripe** (transfer or refund) only after winning the reservation.
4. **Finalize** — on Stripe success: `UPDATE ... SET status='RELEASED'|'REFUNDED', stripe_transfer_id/stripe_refund_id=... WHERE id=? AND status='RELEASING'|'REFUNDING'`. On Stripe failure: revert — `UPDATE ... SET status=<original state> WHERE id=? AND status='RELEASING'|'REFUNDING'` — and surface the error (log an order_event, return 502 to caller) so it's retryable, not silently lost.

Apply this to all four money-moving entry points, all funneling through the same two guarded functions (no duplicated logic):
- `confirm` (DELIVERED → RELEASING → RELEASED)
- `runReleaseCheck` / background sweep (DELIVERED → RELEASING → RELEASED, same function as confirm)
- `resolveDispute({action:'release'})` (DISPUTED → RELEASING → RELEASED)
- `resolveDispute({action:'refund'})` (DISPUTED → REFUNDING → REFUNDED)

## Fix the dispute side of the race too
`disputeOrder()` must also reserve atomically: `UPDATE orders SET status='DISPUTED' WHERE id=? AND status='DELIVERED'`. If `changes === 0` (order is already RELEASING/RELEASED because a release won the race first), return a clear 409 "order is already being released, dispute not possible" rather than silently no-op-ing. This is the correct, deterministic outcome for the edge case — exactly one side wins, and the loser gets an honest error instead of either double-paying or silently vanishing.

## Validation fixes (the 5 lesser bugs)
1. `disputeOrder`: reject with 400 if `reason` is not a non-empty string, before calling `.trim()`.
2. `createOrder`: reject with 400 if `amount_cents` is not a positive integer (`Number.isInteger(x) && x > 0`).
3. `createOrder`: validate `listing_id`/`buyer_id` are the expected type (integer/string per schema) with an explicit check before touching the DB — return 400 with a clear message instead of letting a raw SQLite bind error surface as a 500.
4. `createOrder`: look up the listing, and reject with 400 if `listing.seller_id === buyer_id` ("cannot buy your own listing").
5. (Low priority, include if time allows) tighten the dispute-reason regexes with word boundaries so substrings like "crackers" don't false-positive as a damage claim.

## Non-goals for this pass
- No new features, no UI changes — this is purely closing the concurrency/validation gaps in the existing implementation.
- Don't change the public API shape (endpoint paths/methods stay the same); only internal state-machine and validation behavior changes, plus new 409/400/502 responses for the newly-caught cases.

## What the Tester must re-verify
- Re-run the exact race reproductions from the last pass (dispute-vs-sweep race, concurrent confirm x2, concurrent sweep x2, concurrent admin-refund x2) **including the simulated-Stripe-latency harness** used last time, since the stub client's fast resolution hid the race under plain concurrency. Confirm exactly one side wins each race and the loser gets a clean error, with no double Stripe call and no silent state corruption.
- Re-verify the 5 validation fixes with the same bad-input cases as before.
- Re-run the full happy path and dispute path once more to confirm nothing regressed.

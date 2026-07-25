# Architect Build Plan — Escrow Payment Logic (PRD §6)

Source requirements: PRD §4 (3% platform fee), §5 (Platform Journey), §6 (Escrow & Payment Process), §7 (Dispute Policy), §11 (tech stack).

Decisions locked in with Sal:
- Stripe Connect, test mode (separate-charges-and-transfers pattern: charge buyer to platform, hold, Transfer to seller's connected account on release).
- Backend/API + a minimal demo UI (not a full Next.js app — plain HTML/JS pages calling the API, to keep this pass tight).
- Auto-release via a real background scheduled job (not just a manual endpoint), though a manual admin trigger is also exposed for testability.
- Dispute hook included: raising a dispute pauses release; PRD §7 valid/invalid reason categories are recorded and shown to admin, but do not hard-block filing (admin adjudicates) — this is an Architect judgment call, flag to Sal/Manager for confirmation.

## Assumptions (Architect's call, not asked separately)
- **Database:** SQLite (via `better-sqlite3`) for this pass instead of a live Postgres server — zero setup, fully testable in a sandbox, schema uses portable SQL types so migrating to Postgres later is straightforward. Production should move to Postgres per PRD §11.
- **Stripe keys:** code reads `STRIPE_SECRET_KEY` from env; no real key is available in this sandbox, so the Coder must build a thin Stripe client wrapper that (a) calls the real Stripe test-mode API when a key is present, and (b) the Tester will run against a **fake/stub Stripe client** so the full flow is testable without live credentials. This stub must implement the same interface so swapping in real Stripe later is a one-line change.
- **Fee model:** platform fee = 3% of sale amount, computed in integer cents to avoid float rounding bugs. Stripe's own per-transaction processing fee is not modeled separately — it's deducted by Stripe automatically and out of scope here.
- **Users/listings:** stubbed minimal tables (no auth) — full account/listing system is a separate MVP item per PRD §8, out of scope here.
- **Delivery window:** 48 hours (upper bound of PRD's 24–48h) starts from a "delivered" event, not from "shipped" — carrier tracking integration is out of scope; "delivered" is set by an explicit action (buyer confirms receipt or admin/webhook marks it).

## State machine
`CREATED → HELD → SHIPPED → DELIVERED → (RELEASED | DISPUTED → RELEASED|REFUNDED)`
Also: `DELIVERED` auto-transitions to `RELEASED` if `window_expires_at` passes with no dispute and no explicit buyer confirmation (buyer confirmation also transitions directly to `RELEASED` early).

| State | Meaning |
|---|---|
| CREATED | Order + PaymentIntent created, payment not yet captured |
| HELD | Payment captured, funds held on platform (escrow) |
| SHIPPED | Seller marked shipped |
| DELIVERED | Delivery confirmed; `window_expires_at` = delivered_at + 48h starts |
| DISPUTED | Buyer raised a dispute; release paused pending admin resolution |
| RELEASED | Funds transferred to seller (minus 3% fee); terminal |
| REFUNDED | Dispute resolved in buyer's favor; funds refunded; terminal |

## Data model
- `users(id, name, email, role['buyer'|'seller'|'admin'], stripe_account_id nullable)`
- `listings(id, seller_id, title, price_cents)`
- `orders(id, listing_id, buyer_id, seller_id, amount_cents, platform_fee_cents, status, stripe_payment_intent_id, stripe_transfer_id nullable, shipped_at, delivered_at, window_expires_at, dispute_reason_text, dispute_category['valid'|'invalid'|null], dispute_resolution['release'|'refund' nullable], created_at, updated_at)`
- `order_events(id, order_id, event_type, payload_json, created_at)` — full audit trail/timeline for the Manager and Tester to inspect

## API endpoints
- `POST /orders` — create order + Stripe PaymentIntent (manual capture) → CREATED
- `POST /orders/:id/capture` — capture payment (simulates webhook confirmation) → HELD
- `POST /orders/:id/ship` — seller marks shipped → SHIPPED
- `POST /orders/:id/deliver` — mark delivered, compute `window_expires_at` → DELIVERED
- `POST /orders/:id/confirm` — buyer confirms early → triggers release now → RELEASED
- `POST /orders/:id/dispute` — buyer raises dispute (reason text + auto-tagged category from PRD §7 list) → DISPUTED, cancels pending auto-release
- `POST /admin/orders/:id/resolve` — admin resolves: `{action: "release"|"refund"}` → RELEASED or REFUNDED
- `POST /admin/run-release-check` — same logic the background job runs; also callable manually for testing
- `GET /orders/:id` — full detail + event timeline
- `GET /orders?buyer_id=|seller_id=` — list

## Background job
A `node-cron` (or `setInterval` fallback) job runs every minute in dev, scanning `DELIVERED` orders where `now > window_expires_at`, and releases them (same function backing the manual endpoint above — no duplicated logic).

## Non-goals for this pass (explicitly out of scope)
- User authentication / real accounts (PRD §8, separate item)
- Listing creation, photo upload, search/filters (separate MVP items)
- Full admin dispute-resolution UI (only the API endpoint + a minimal status page)
- Real shipping-carrier tracking
- Messaging system
- Full Next.js production frontend — a minimal static HTML/JS demo only
- Security/adversarial testing (locked in with Sal as a later pass)

## Deliverables expected from the Coder
- Runnable Node.js/Express service (`npm start`) with SQLite persistence, seeded with 1-2 demo users/listing so the flow can be exercised immediately.
- Stripe client wrapper with a stub mode (default, no key needed) and a real-Stripe-Connect mode gated on `STRIPE_SECRET_KEY` being set.
- Background release job wired in.
- Minimal static HTML/JS pages: checkout (create + pay), order status/timeline (ship/deliver/confirm/dispute actions), and a simple admin resolve page.
- A short README covering how to run it, how the stub Stripe mode works, and how to switch to real Stripe test keys.

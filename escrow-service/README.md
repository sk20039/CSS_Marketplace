# Escrow Service - USA Cricket Marketplace (C2C resale)

Implements the order/escrow state machine from `escrow_build_plan.md` (Architect):
Stripe Connect–style escrow, 3% platform fee, 48h auto-release window, and a
dispute hook with PRD §7 reason auto-tagging.

## Requirements

- Node.js 18+ (tested on Node 22)
- No external database - persistence is a local SQLite file via `better-sqlite3`.

## Run it

```bash
cd escrow-service
npm install
npm start
```

The server listens on **http://localhost:3000** by default (override with `PORT` in
env or a `.env` file - see `.env.example`).

On first run it creates `data/escrow.sqlite3` and seeds:
- a demo buyer (`buyer@demo.test`), seller (`seller@demo.test`, with a stub Stripe
  Connect account id), and admin user
- two demo listings (a cricket bat and a helmet)

Demo UI (plain HTML/JS, no build step, served as static files by the same server):
- `http://localhost:3000/index.html` — checkout: pick a buyer + listing, "Create Order & Pay"
- `http://localhost:3000/order.html?id=<id>` — order status/timeline with action
  buttons appropriate to the order's current state (ship / deliver / confirm / dispute)
- `http://localhost:3000/admin.html` — lists disputed orders (release/refund
  buttons) and delivered orders awaiting auto-release, plus a manual "Run
  Release Check Now" button

## Stripe: stub mode vs real mode

Both modes implement the exact same interface (`src/stripeClient.js`):
`createPaymentIntent`, `capturePaymentIntent`, `createTransfer`, `createRefund`.
Switching is a **one-line env var change** - nothing else in the codebase
changes.

- **STUB mode (default)**: no `STRIPE_SECRET_KEY` set. No network calls at
  all; PaymentIntents/Transfers/Refunds are simulated in-process with fake
  ids (`pi_stub_...`, `tr_stub_...`, `re_stub_...`) and always "succeed"
  synchronously. This is what the smoke tests below run against, and what
  you get out of the box with `npm install && npm start`.
- **REAL mode**: set `STRIPE_SECRET_KEY=sk_test_...` (a real Stripe **test**
  key) in your environment or `.env`. Uses the real `stripe` npm package
  against Stripe Connect test mode, separate-charges-and-transfers pattern:
  a PaymentIntent (manual capture) is created and captured on the
  platform's own account, then a separate `stripe.transfers.create` moves
  the seller's payout to their **connected account id** (stored in
  `users.stripe_account_id`) on release, referencing the original charge as
  `source_transaction`. Refunds go through `stripe.refunds.create` against
  the original PaymentIntent.
  - You'd need to replace the seeded `acct_stub_seller_1` with a real
    Stripe Connect **test** connected account id for a full real-mode run;
    this repo does not create Connect accounts for you (out of scope - see
    plan's non-goals around account onboarding).

## Auto-release job

A `node-cron` job (`src/scheduler.js`) runs every minute by default
(`RELEASE_CHECK_CRON` env var to change it) and releases any `DELIVERED`
order whose 48h `window_expires_at` has passed with no dispute filed. It
calls the exact same function (`runReleaseCheck()` in `src/orderService.js`)
that backs `POST /admin/run-release-check`, so there is one implementation
of the release-sweep logic, not two.

To see auto-release fire quickly in a demo without waiting 48 hours, set
in `.env`:
```
DELIVERY_WINDOW_HOURS=0.001
RELEASE_CHECK_CRON=*/10 * * * * *
```
(≈3.6 second window, checked every 10 seconds.)

## API endpoints

| Method | Path | Effect |
|---|---|---|
| POST | `/orders` | `{listing_id, buyer_id}` → create order + PaymentIntent → `CREATED` |
| POST | `/orders/:id/capture` | capture payment → `HELD` |
| POST | `/orders/:id/ship` | seller marks shipped → `SHIPPED` |
| POST | `/orders/:id/deliver` | mark delivered, sets `window_expires_at` → `DELIVERED` |
| POST | `/orders/:id/confirm` | buyer confirms early → releases now → `RELEASED` |
| POST | `/orders/:id/dispute` | `{reason}` → tags reason, → `DISPUTED` (blocks auto-release) |
| POST | `/admin/orders/:id/resolve` | `{action: "release"\|"refund"}` → `RELEASED`/`REFUNDED` |
| POST | `/admin/run-release-check` | runs the same sweep the cron job runs (also releases any window-expired `DELIVERED` orders) |
| GET | `/orders/:id` | full order + event timeline |
| GET | `/orders?buyer_id=&seller_id=&status=` | list/filter orders (`status` supports comma-separated values, e.g. `DISPUTED,DELIVERED`, used by the admin page) |
| GET | `/api/users`, `/api/listings` | demo-UI helper endpoints (list seeded users/listings; no auth/catalog system exists per plan's non-goals) |

## Fee math

`platform_fee_cents = round(amount_cents * 300 / 10000)` (300 bps = 3%),
computed as integer arithmetic throughout (`src/orderService.js:computeFee`)
to avoid floating-point rounding bugs. `seller_payout_cents = amount_cents -
platform_fee_cents`. Both are stored on the order at creation time so the
payout figure used at release matches what was quoted at checkout.

## Dispute reason auto-tagging (PRD §7)

`src/disputeCategorizer.js` regex-matches the free-text reason against the
PRD's known valid reasons (major undisclosed crack/damage, fake/counterfeit,
wrong item received, major mismatch from photos) and invalid reasons
(changed mind, doesn't like pickup/feel, bat heavier than expected). The tag
(`valid` / `invalid` / `uncategorized`) is stored and shown to the admin but
**never blocks filing** - the admin always adjudicates via
`/admin/orders/:id/resolve`.

**Scope note beyond the plan**: the data model has no per-listing "was X
disclosed" flag, so the "heavier than expected, if weight was disclosed"
condition can't be evaluated conditionally. Any heaviness/weight complaint
is conservatively tagged `invalid` regardless of disclosure. Flagging this
for Manager/Sal - if per-listing disclosed specs get added to the data
model later, this categorizer should read that field.

## Exercising the happy path via curl

```bash
BASE=http://localhost:3000

# 1. Create order (listing 1, buyer 1 from the seed data)
curl -s -X POST $BASE/orders -H 'Content-Type: application/json' \
  -d '{"listing_id":1,"buyer_id":1}' | tee /tmp/order.json
ORDER_ID=$(node -e "console.log(require('/tmp/order.json').id)")

# 2. Capture payment -> HELD
curl -s -X POST $BASE/orders/$ORDER_ID/capture

# 3. Seller ships -> SHIPPED
curl -s -X POST $BASE/orders/$ORDER_ID/ship

# 4. Mark delivered -> DELIVERED (starts the 48h window)
curl -s -X POST $BASE/orders/$ORDER_ID/deliver

# 5. Buyer confirms early -> RELEASED (funds transferred to seller minus 3% fee)
curl -s -X POST $BASE/orders/$ORDER_ID/confirm

# Full timeline:
curl -s $BASE/orders/$ORDER_ID | python3 -m json.tool
```

## Exercising the dispute path via curl

```bash
BASE=http://localhost:3000

curl -s -X POST $BASE/orders -H 'Content-Type: application/json' \
  -d '{"listing_id":2,"buyer_id":1}' | tee /tmp/order2.json
ORDER_ID=$(node -e "console.log(require('/tmp/order2.json').id)")

curl -s -X POST $BASE/orders/$ORDER_ID/capture
curl -s -X POST $BASE/orders/$ORDER_ID/ship
curl -s -X POST $BASE/orders/$ORDER_ID/deliver

# Buyer files a dispute (auto-tagged 'valid' against PRD §7 patterns)
curl -s -X POST $BASE/orders/$ORDER_ID/dispute -H 'Content-Type: application/json' \
  -d '{"reason":"There is a major undisclosed crack in the bat"}'

# This order is now DISPUTED and the auto-release sweep will skip it even
# past its window - verify with a manual sweep:
curl -s -X POST $BASE/admin/run-release-check

# Admin resolves in the buyer's favor:
curl -s -X POST $BASE/admin/orders/$ORDER_ID/resolve -H 'Content-Type: application/json' \
  -d '{"action":"refund"}'

curl -s $BASE/orders/$ORDER_ID | python3 -m json.tool
```

Or do all of this through the demo UI: `index.html` → `order.html?id=...` →
`admin.html`.

## Project layout

```
escrow-service/
  src/
    db.js                 SQLite schema + seed data
    stripeClient.js        Stub + real Stripe client, shared interface
    disputeCategorizer.js  PRD §7 valid/invalid reason auto-tagging
    orderService.js        State machine, fee math, shared release logic
    scheduler.js            node-cron auto-release job
    app.js                  Express routes + static file serving
    server.js               Entry point (npm start)
  public/                  Static demo UI (checkout / order / admin pages)
  data/                    SQLite file lives here (gitignored)
  .env.example
```

## Non-goals (carried over from the build plan, unchanged)

No auth, no listing creation/search UI, no real carrier tracking, no
messaging, no production Next.js frontend, no security/adversarial testing
pass. See `escrow_build_plan.md` for the authoritative list.

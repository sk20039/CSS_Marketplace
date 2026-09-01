# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

USA Cricket Equipment Marketplace — a C2C resale platform for cricket bats and gear. The only service built so far is `escrow-service`, which handles order lifecycle, Stripe Connect escrow payments, and dispute handling.

## Commands

All commands run from `escrow-service/`:

```bash
npm start          # production: node src/server.js
npm run dev        # dev with auto-reload: node --watch src/server.js
```

No test runner is configured. Tests are written as one-off scripts and run via the agent pipeline (see Agent workflow below). To exercise the service manually, start it and use the demo UI at `http://localhost:3000` or call the REST API directly.

**Environment variables** (all optional — defaults work out of the box in stub mode):
- `STRIPE_SECRET_KEY` — if set, switches from stub to real Stripe Connect test-mode API
- `STRIPE_STUB_LATENCY_MS` — artificial latency for the stub client (use in concurrency tests to expose races)
- `DELIVERY_WINDOW_HOURS` — default `48`; hours before auto-release fires after delivery
- `PLATFORM_FEE_BPS` — default `800` (8% expressed in basis points)
- `RELEASE_CHECK_CRON` — default `* * * * *` (every minute); node-cron schedule for auto-release sweep
- `DB_PATH` — default `escrow-service/data/escrow.sqlite3`
- `PORT` — default `3000`

## Architecture

### escrow-service

`src/server.js` — entry point; loads env, builds Express app, starts the cron scheduler.

`src/app.js` — defines all Express routes. Delegates all business logic to `orderService`. Also serves `public/` as static files for the demo UI.

`src/orderService.js` — the core. Order state machine, all business logic, Stripe calls, fee math. Key design rules:
- **Race-condition safety**: every path that moves money (capture, release, refund) uses a *reserve → call Stripe → finalize-or-revert* pattern. A synchronous conditional `UPDATE ... WHERE status = <expected>` (checked via `changes` count) happens **before** any `await` on Stripe. The first caller to win that UPDATE owns the transition; the loser gets a 409.
- **Transient states** for in-flight Stripe calls: `CAPTURING`, `RELEASING`, `REFUNDING`. If Stripe fails, the order reverts to its prior state for safe retry.
- **Fee math**: integer cents only — `Math.round((amountCents * PLATFORM_FEE_BPS) / 10000)`. No float arithmetic.
- `runReleaseCheck()` is the single implementation of the auto-release sweep used by both the background cron job and `POST /admin/run-release-check`.

`src/db.js` — `better-sqlite3` singleton. Creates schema on startup, seeds 2 demo users and 2 listings on first run (idempotent). Database is SQLite for this pass; schema uses portable SQL types for a future Postgres migration.

`src/stripeClient.js` — dual-mode Stripe wrapper. Same interface (`createPaymentIntent`, `capturePaymentIntent`, `createTransfer`, `createRefund`) in both modes. **Stub mode** (no key set): in-memory simulation, no network. **Real mode** (key set): Stripe Connect "separate charges and transfers" — charge buyer to platform account (manual capture), then `stripe.transfers.create` to seller's connected account on release.

`src/scheduler.js` — wraps `node-cron` to run `runReleaseCheck()` on a schedule. Exposes `startScheduler()`/`stopScheduler()` so tests can control it.

`src/disputeCategorizer.js` — regex-based tagging of dispute reasons against PRD §7's valid/invalid categories. Informational only; never blocks filing. Admin adjudicates regardless of tag.

### Order state machine

```
CREATED → (capture) → CAPTURING → HELD → (ship) → SHIPPED → (deliver) → DELIVERED
                                                                  |
                                                   (buyer confirm / auto-release)
                                                                  |
                                                            RELEASING → RELEASED
                                                                  |
                                                         (dispute) → DISPUTED
                                                                        |
                                                      (admin: release) → RELEASING → RELEASED
                                                      (admin: refund)  → REFUNDING → REFUNDED
```

### Demo UI (public/)

Three static HTML/JS pages that call the REST API:
- `index.html` — checkout: create an order and capture payment
- `order.html` — order timeline with ship/deliver/confirm/dispute actions
- `admin.html` — dispute resolution page

### What does not yet exist

Per the build plan's explicit non-goals: user authentication, listing creation/search, shipping-carrier tracking, messaging, and a full Next.js production frontend. The stack for those (per PRD §11) will be React/Next.js frontend, Node.js or Python backend, PostgreSQL.

## Agent workflow

When Sal hands Claude a feature request, Claude runs a sequential 4-role pipeline per `docs/agent_workflow_charter.md`:

1. **Architect** — reads docs, asks Sal key open questions via `AskUserQuestion`, produces a written build plan (no code).
2. **Coder** — implements the plan as real, runnable code files; notes assumptions where the plan under-specified.
3. **Tester** — finds functional and edge-case bugs (logic, bad inputs, boundary conditions, race conditions); priority areas: escrow state transitions, timing window, fee math, dispute validation, race conditions. Returns findings only, no fixes.
4. **Manager** — checks implementation against plan, triages Tester findings, reports a concise punch list to Sal.

Each role runs as a subagent; the orchestrating session relays the Manager's summary and deliverables to Sal.

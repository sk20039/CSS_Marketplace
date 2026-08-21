// Core order state machine + escrow business logic.
// CREATED -> HELD -> SHIPPED -> DELIVERED -> RELEASED
//                                   |-> DISPUTED -> RELEASED | REFUNDED
//                                   |-> (buyer confirm) -> RELEASED
//
// The auto-release job (scheduler.js) and the manual
// POST /admin/run-release-check endpoint both call `runReleaseCheck()` below
// so there is exactly one implementation of the release-sweep logic.

const db = require('./db');
const { stripeClient } = require('./stripeClient');
const { categorizeDispute } = require('./disputeCategorizer');
const notifications = require('./notifications');

const DELIVERY_WINDOW_MS =
  Number(process.env.DELIVERY_WINDOW_HOURS || 48) * 60 * 60 * 1000;
const PLATFORM_FEE_BPS = Number(process.env.PLATFORM_FEE_BPS || 300); // 300 bps = 3%
const LISTING_SERVICE_URL = process.env.LISTING_SERVICE_URL || 'http://localhost:3002';

// Fetches the listing straight from listing-service (the source of truth for
// price and seller_id) rather than trusting escrow-service's own `listings`
// table, which is only ever populated by client-pushed /api/sync/listing
// calls. Trusting that local mirror for money-critical fields let any logged
// -in buyer overwrite a listing's price/seller_id right before purchasing it
// - fetching live from listing-service closes that off.
async function fetchAuthoritativeListing(listingId) {
  let res;
  try {
    res = await fetch(`${LISTING_SERVICE_URL}/listings/${listingId}`);
  } catch (err) {
    throw new OrderError(`Could not reach listing-service to verify listing ${listingId}`, 502);
  }
  if (res.status === 404) {
    throw new OrderError(`Listing ${listingId} not found`, 404);
  }
  if (!res.ok) {
    throw new OrderError(`listing-service returned an error for listing ${listingId}`, 502);
  }
  return res.json();
}

// Tells listing-service to flip a listing back to 'active' after a pre-shipment
// cancellation so it can be purchased again. Best-effort: a failure here is
// logged but never surfaces to the caller — the refund has already succeeded.
async function markListingActive(listingId) {
  try {
    const res = await fetch(`${LISTING_SERVICE_URL}/listings/${listingId}/mark-active`, {
      method: 'PATCH',
      headers: { 'x-internal-secret': process.env.JWT_SECRET || 'change-me' },
    });
    if (!res.ok) throw new Error(`listing-service returned ${res.status}`);
    return true;
  } catch (err) {
    console.error(`[orderService] markListingActive(${listingId}) failed:`, err.message);
    return false;
  }
}

// Tells listing-service to flip a listing to 'sold' once its payment has
// actually been captured (funds in escrow) - not at order creation, since an
// order can still fail to capture and get abandoned. This is a best-effort
// service-to-service call: if it fails, the payment has already succeeded,
// so we log it rather than fail the request - a human can reconcile the
// listing status manually, but we must never lose track of captured money
// just because this side-call hiccuped.
async function markListingSold(listingId) {
  try {
    const res = await fetch(`${LISTING_SERVICE_URL}/listings/${listingId}/mark-sold`, {
      method: 'PATCH',
      headers: { 'x-internal-secret': process.env.JWT_SECRET || 'change-me' },
    });
    if (!res.ok) {
      throw new Error(`listing-service returned ${res.status}`);
    }
    return true;
  } catch (err) {
    return false;
  }
}

class OrderError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Thrown by shared finalize functions when the conditional UPDATE finds the
// order is no longer in the expected transient status — meaning a concurrent
// path (another HTTP request or a recovery sweep) already finalized it.
// Normal processing propagates this as a 500. Recovery catches it and treats
// it as a success (the order reached its correct terminal state via the other path).
class FinalizeConflictError extends Error {
  constructor(orderId, operationType, stripeId) {
    super(`Order ${orderId} ${operationType} finalize conflict (Stripe ID: ${stripeId}) — another path already finalized`);
    this.name = 'FinalizeConflictError';
    this.orderId = orderId;
    this.stripeId = stripeId;
  }
}

function nowIso() {
  return new Date().toISOString();
}

// Integer-cents fee math (no floating point). 3% == 300 basis points.
function computeFee(amountCents) {
  const platformFeeCents = Math.round((amountCents * PLATFORM_FEE_BPS) / 10000);
  const sellerPayoutCents = amountCents - platformFeeCents;
  return { platformFeeCents, sellerPayoutCents };
}

function recordEvent(orderId, eventType, payload) {
  db.prepare(
    `INSERT INTO order_events (order_id, event_type, payload_json, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(orderId, eventType, JSON.stringify(payload || {}), nowIso());
}

function getOrder(id) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) throw new OrderError(`Order ${id} not found`, 404);
  return order;
}

function getOrderWithTimeline(id) {
  const order = getOrder(id);
  const events = db
    .prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY id ASC')
    .all(id)
    .map((e) => ({ ...e, payload: JSON.parse(e.payload_json || '{}') }));
  return { ...order, events };
}

function listOrders({ buyerId, sellerId }) {
  if (buyerId) {
    return db.prepare('SELECT * FROM orders WHERE buyer_id = ? ORDER BY id DESC').all(buyerId);
  }
  if (sellerId) {
    return db.prepare('SELECT * FROM orders WHERE seller_id = ? ORDER BY id DESC').all(sellerId);
  }
  return db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
}

function assertStatus(order, expected) {
  const expectedList = Array.isArray(expected) ? expected : [expected];
  if (!expectedList.includes(order.status)) {
    throw new OrderError(
      `Order ${order.id} is in status ${order.status}, expected ${expectedList.join(' or ')}`,
      409
    );
  }
}

// A valid listing_id/buyer_id per the schema is an INTEGER primary key.
// Accept a JS number that's a positive integer, or a numeric string (JSON
// clients sometimes send ids as strings); reject everything else (booleans,
// floats, objects, arrays, null, undefined) before it ever reaches a SQLite
// bind param, where it would otherwise throw a raw TypeError -> 500.
function isPositiveIntegerId(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0;
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return Number(value) > 0;
  return false;
}

// ---- POST /orders ----
async function createOrder({ listingId, buyerId }) {
  if (!isPositiveIntegerId(listingId)) {
    throw new OrderError('listing_id must be a positive integer', 400);
  }
  if (!isPositiveIntegerId(buyerId)) {
    throw new OrderError('buyer_id must be a positive integer', 400);
  }
  const normalizedListingId = Number(listingId);
  const normalizedBuyerId = Number(buyerId);

  const listing = await fetchAuthoritativeListing(normalizedListingId);
  if (listing.status && listing.status !== 'active') {
    throw new OrderError(`Listing ${normalizedListingId} is not active (status: ${listing.status})`, 409);
  }
  const sellerId = Number(listing.seller_id);
  const buyer = db.prepare('SELECT * FROM users WHERE id = ?').get(normalizedBuyerId);
  if (!buyer) throw new OrderError(`Buyer ${normalizedBuyerId} not found`, 404);

  if (sellerId === normalizedBuyerId) {
    throw new OrderError('buyer_id cannot be the seller of the listing (cannot buy your own listing)', 400);
  }

  const amountCents = listing.price_cents;
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new OrderError(
      `Listing ${normalizedListingId} has an invalid price_cents (${amountCents}); amount_cents must be a positive integer`,
      400
    );
  }
  const { platformFeeCents, sellerPayoutCents } = computeFee(amountCents);

  // Keep the local mirror in sync too, now purely for the admin demo views -
  // it is no longer trusted for money-critical fields.
  db.prepare(
    'INSERT OR REPLACE INTO listings (id, seller_id, title, price_cents) VALUES (?, ?, ?, ?)'
  ).run(normalizedListingId, sellerId, listing.title, amountCents);

  const intent = await stripeClient.createPaymentIntent({
    amountCents,
    currency: 'usd',
    metadata: { listingId: String(normalizedListingId), buyerId: String(normalizedBuyerId) },
  });

  const ts = nowIso();
  const result = db
    .prepare(
      `INSERT INTO orders (
        listing_id, buyer_id, seller_id, amount_cents, platform_fee_cents, seller_payout_cents,
        status, stripe_payment_intent_id, stripe_client_secret, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'CREATED', ?, ?, ?, ?)`
    )
    .run(
      normalizedListingId,
      normalizedBuyerId,
      sellerId,
      amountCents,
      platformFeeCents,
      sellerPayoutCents,
      intent.id,
      intent.client_secret || null,
      ts,
      ts
    );

  const orderId = result.lastInsertRowid;
  recordEvent(orderId, 'ORDER_CREATED', {
    listingId: normalizedListingId,
    buyerId: normalizedBuyerId,
    sellerId,
    amountCents,
    platformFeeCents,
    sellerPayoutCents,
    stripePaymentIntentId: intent.id,
    stripeMode: stripeClient.mode,
  });

  return getOrderWithTimeline(orderId);
}

// ---- POST /orders/:id/capture ----
// Same reserve -> Stripe -> finalize shape as performRelease/performRefund
// below: reserve CREATED -> CAPTURING atomically BEFORE calling Stripe, so a
// concurrent capture request loses the reservation UPDATE (0 rows changed)
// and gets a clean 409 instead of racing the unconditional final UPDATE that
// used to run here unconditionally after the await.
async function captureOrder(id) {
  if (!reserveTransition(id, 'CREATED', 'CAPTURING')) {
    throw reservationConflictError(id, 'CREATED', 'captured');
  }

  const order = getOrder(id);

  let captured;
  try {
    captured = await stripeClient.capturePaymentIntent(order.stripe_payment_intent_id, {
      idempotencyKey: `capture_order_${id}`,
    });
    if (captured.status !== 'succeeded') {
      throw new Error(`Stripe capture did not succeed (status=${captured.status})`);
    }
  } catch (err) {
    // Stripe call failed (or didn't succeed) - revert the reservation so the
    // order is retryable instead of stuck in CAPTURING or silently losing
    // the failure.
    revertTransition(id, 'CAPTURING', 'CREATED');
    recordEvent(id, 'CAPTURE_FAILED', { error: err.message });
    throw new OrderError(`Stripe capture failed for order ${id}: ${err.message}`, 502);
  }

  return finalizeCaptured(order, captured, { triggeredBy: 'capture_request' });
}

// Shared capture finalization — called by captureOrder and by recoveryService.
// Writes HELD status + charge ID, records events, marks listing sold, fires
// notification. Throws FinalizeConflictError if the order was already finalized
// by a concurrent path (recovery catches this and treats it as success).
async function finalizeCaptured(order, stripeCapture, { triggeredBy }) {
  const ts = nowIso();
  const finalized = db
    .prepare(
      `UPDATE orders SET status = 'HELD', stripe_payment_intent_id = ?, stripe_charge_id = ?,
         updated_at = ?, transition_started_at = NULL, recovery_claimed_at = NULL
         WHERE id = ? AND status = 'CAPTURING'`
    )
    .run(stripeCapture.id, stripeCapture.chargeId || null, ts, order.id);

  if (finalized.changes === 0) {
    recordEvent(order.id, 'CAPTURE_FINALIZE_CONFLICT', { triggeredBy, stripePaymentIntentId: stripeCapture.id });
    throw new FinalizeConflictError(order.id, 'capture', stripeCapture.id);
  }

  recordEvent(order.id, 'PAYMENT_CAPTURED', {
    triggeredBy,
    stripePaymentIntentId: stripeCapture.id,
    chargeId: stripeCapture.chargeId || null,
  });

  const markedSold = await markListingSold(order.listing_id);
  recordEvent(order.id, markedSold ? 'LISTING_MARKED_SOLD' : 'LISTING_MARK_SOLD_FAILED', {
    listingId: order.listing_id,
  });

  notifications.notifyOrderCaptured(order).catch(() => {});

  return getOrderWithTimeline(order.id);
}

// ---- POST /orders/:id/ship ----
function shipOrder(id) {
  const order = getOrder(id);
  assertStatus(order, 'HELD');

  const ts = nowIso();
  db.prepare(
    `UPDATE orders SET status = 'SHIPPED', shipped_at = ?, updated_at = ? WHERE id = ?`
  ).run(ts, ts, id);
  recordEvent(id, 'SHIPPED', { shippedAt: ts });
  notifications.notifyShipped(order).catch(() => {});

  return getOrderWithTimeline(id);
}

// ---- POST /orders/:id/deliver ----
function deliverOrder(id) {
  const order = getOrder(id);
  assertStatus(order, 'SHIPPED');

  const ts = nowIso();
  const windowExpiresAt = new Date(Date.now() + DELIVERY_WINDOW_MS).toISOString();
  db.prepare(
    `UPDATE orders SET status = 'DELIVERED', delivered_at = ?, window_expires_at = ?, updated_at = ? WHERE id = ?`
  ).run(ts, windowExpiresAt, ts, id);
  recordEvent(id, 'DELIVERED', { deliveredAt: ts, windowExpiresAt });
  notifications.notifyDelivered(order).catch(() => {});

  return getOrderWithTimeline(id);
}

// ---- Atomic reserve/revert helpers ----
// better-sqlite3 statements are synchronous, so a single UPDATE ... WHERE
// status=? cannot be interleaved by another request's JS - whichever
// caller's reserve UPDATE actually runs first wins the transition, full
// stop. Every money-moving path MUST reserve via one of these guarded
// conditional updates BEFORE calling Stripe, never after.
function reserveTransition(orderId, fromStatus, toStatus) {
  const ts = nowIso();
  // prior_status = status captures the OLD value of the status column before
  // it is overwritten (SQL evaluates all RHS expressions from the original row).
  // transition_started_at is the precise moment this transient state began,
  // used by recovery to calculate staleness independently of updated_at.
  const result = db
    .prepare(
      `UPDATE orders
       SET status = ?, updated_at = ?, prior_status = status, transition_started_at = ?
       WHERE id = ? AND status = ?`
    )
    .run(toStatus, ts, ts, orderId, fromStatus);
  return result.changes > 0;
}

function revertTransition(orderId, fromStatus, toStatus) {
  const ts = nowIso();
  db.prepare(`UPDATE orders SET status = ?, updated_at = ? WHERE id = ? AND status = ?`).run(
    toStatus,
    ts,
    orderId,
    fromStatus
  );
}

function reservationConflictError(orderId, expectedStatus, action) {
  const current = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
  if (!current) return new OrderError(`Order ${orderId} not found`, 404);
  return new OrderError(
    `Order ${orderId} cannot be ${action}: expected status ${expectedStatus} but order is ${current.status} ` +
      `(already reserved/processed by a concurrent request, or in an incompatible state)`,
    409
  );
}

// Shared release implementation - reserves the transition atomically, THEN
// transfers the seller payout via Stripe, THEN finalizes. Used by: buyer
// early confirm, auto-release sweep (cron + manual endpoint), and admin
// dispute resolution ("release"). `fromStatus` is the single state each of
// those call sites is allowed to release from (DELIVERED or DISPUTED).
async function performRelease(orderId, { triggeredBy, fromStatus }) {
  if (!reserveTransition(orderId, fromStatus, 'RELEASING')) {
    throw reservationConflictError(orderId, fromStatus, 'released');
  }

  const order = getOrder(orderId);

  let transfer;
  try {
    const seller = db.prepare('SELECT * FROM users WHERE id = ?').get(order.seller_id);
    if (!seller || !seller.stripe_account_id) {
      revertTransition(orderId, 'RELEASING', fromStatus);
      recordEvent(orderId, 'RELEASE_FAILED', {
        triggeredBy,
        error: `seller ${order.seller_id} has no connected Stripe account`,
      });
      throw new OrderError(
        `Order ${orderId} cannot be released: seller ${order.seller_id} has no connected Stripe account`,
        502
      );
    }
    const destination = seller.stripe_account_id;
    // source_transaction must be the Charge ID (ch_...) — Stripe rejects a PaymentIntent ID (pi_...).
    // stripe_charge_id is written by captureOrder for all orders captured after the db migration.
    // If it is missing, revert and fail safely rather than send Stripe an invalid object ID.
    if (!order.stripe_charge_id) {
      revertTransition(orderId, 'RELEASING', fromStatus);
      recordEvent(orderId, 'RELEASE_FAILED', {
        triggeredBy,
        error: 'stripe_charge_id is not set — manual reconciliation required',
      });
      throw new OrderError(
        `Order ${orderId} cannot be released: stripe_charge_id is not set. ` +
        `Look up the Charge ID (ch_...) for PaymentIntent ${order.stripe_payment_intent_id} ` +
        `in the Stripe dashboard, then run: ` +
        `UPDATE orders SET stripe_charge_id = 'ch_...' WHERE id = ${orderId}`,
        500
      );
    }
    transfer = await stripeClient.createTransfer({
      amountCents: order.seller_payout_cents,
      currency: 'usd',
      destination,
      metadata: { orderId: String(order.id), operationType: 'release' },
      sourceTransactionId: order.stripe_charge_id,
      idempotencyKey: `release_order_${orderId}`,
    });
  } catch (err) {
    // Stripe call failed - revert the reservation so the order is retryable
    // instead of stuck in RELEASING or silently losing the failure.
    revertTransition(orderId, 'RELEASING', fromStatus);
    recordEvent(orderId, 'RELEASE_FAILED', { triggeredBy, error: err.message });
    throw new OrderError(`Stripe transfer failed for order ${orderId}: ${err.message}`, 502);
  }

  return finalizeReleased(order, transfer, { triggeredBy });
}

// Shared release finalization — called by performRelease and by recoveryService.
// Throws FinalizeConflictError if the order was already finalized by a concurrent path.
async function finalizeReleased(order, stripeTransfer, { triggeredBy }) {
  const ts = nowIso();
  const finalized = db
    .prepare(
      `UPDATE orders SET status = 'RELEASED', stripe_transfer_id = ?,
         updated_at = ?, transition_started_at = NULL, recovery_claimed_at = NULL
         WHERE id = ? AND status = 'RELEASING'`
    )
    .run(stripeTransfer.id, ts, order.id);

  if (finalized.changes === 0) {
    recordEvent(order.id, 'RELEASE_FINALIZE_CONFLICT', { triggeredBy, stripeTransferId: stripeTransfer.id });
    throw new FinalizeConflictError(order.id, 'release', stripeTransfer.id);
  }

  recordEvent(order.id, 'RELEASED', {
    triggeredBy,
    stripeTransferId: stripeTransfer.id,
    sellerPayoutCents: order.seller_payout_cents,
    platformFeeCents: order.platform_fee_cents,
  });
  notifications.notifyReleased(order, { triggeredBy }).catch(() => {});

  return getOrderWithTimeline(order.id);
}

// Shared refund implementation - same reserve -> Stripe -> finalize shape as
// performRelease. Only entry point today is admin dispute resolution
// ("refund"), reserving DISPUTED -> REFUNDING -> REFUNDED.
async function performRefund(orderId, { triggeredBy, fromStatus }) {
  if (!reserveTransition(orderId, fromStatus, 'REFUNDING')) {
    throw reservationConflictError(orderId, fromStatus, 'refunded');
  }

  const order = getOrder(orderId);

  let refund;
  try {
    refund = await stripeClient.createRefund({
      paymentIntentId: order.stripe_payment_intent_id,
      amountCents: order.amount_cents,
      metadata: { orderId: String(orderId), operationType: 'refund_dispute' },
      idempotencyKey: `refund_dispute_order_${orderId}`,
    });
  } catch (err) {
    revertTransition(orderId, 'REFUNDING', fromStatus);
    recordEvent(orderId, 'REFUND_FAILED', { triggeredBy, error: err.message });
    throw new OrderError(`Stripe refund failed for order ${orderId}: ${err.message}`, 502);
  }

  return finalizeRefunded(order, refund, { triggeredBy });
}

// Shared refund finalization — called by performRefund and by recoveryService.
// Throws FinalizeConflictError if the order was already finalized by a concurrent path.
async function finalizeRefunded(order, stripeRefund, { triggeredBy }) {
  const ts = nowIso();
  const finalized = db
    .prepare(
      `UPDATE orders SET status = 'REFUNDED', stripe_refund_id = ?,
         updated_at = ?, transition_started_at = NULL, recovery_claimed_at = NULL
         WHERE id = ? AND status = 'REFUNDING'`
    )
    .run(stripeRefund.id, ts, order.id);

  if (finalized.changes === 0) {
    recordEvent(order.id, 'REFUND_FINALIZE_CONFLICT', { triggeredBy, stripeRefundId: stripeRefund.id });
    throw new FinalizeConflictError(order.id, 'refund', stripeRefund.id);
  }

  recordEvent(order.id, 'REFUNDED', { triggeredBy, stripeRefundId: stripeRefund.id });
  notifications.notifyRefunded(order, { triggeredBy }).catch(() => {});

  return getOrderWithTimeline(order.id);
}

// ---- POST /orders/:id/cancel ----
// Pre-shipment cancellation: HELD -> CANCELLING -> CANCELLED + partial refund
// (buyer gets back amount_cents minus platform_fee_cents; platform keeps fee).
// Available to buyers and admins only (sellers cannot cancel — enforced in app.js).
// Follows the same reserve -> Stripe -> finalize pattern as performRefund so
// a concurrent ship/capture can never race past the atomic reservation UPDATE.
async function cancelOrder(id, { cancelledBy, reason }) {
  // Coerce reason to a string to prevent SQLite bind errors from unexpected types.
  const normalizedReason = reason != null ? String(reason).trim() || null : null;

  if (!reserveTransition(id, 'HELD', 'CANCELLING')) {
    throw reservationConflictError(id, 'HELD', 'cancelled');
  }

  const order = getOrder(id);

  // Refund buyer their amount minus the platform fee (platform keeps the fee).
  if (order.platform_fee_cents == null || !Number.isFinite(order.amount_cents - order.platform_fee_cents)) {
    revertTransition(id, 'CANCELLING', 'HELD');
    throw new OrderError(`Order ${id} has invalid fee data; cannot compute refund amount`, 500);
  }
  const refundAmountCents = order.amount_cents - order.platform_fee_cents;

  // Persist the cancellation reason before the Stripe call so recovery can
  // read it from the CANCELLING row if the process crashes after this point.
  db.prepare('UPDATE orders SET cancellation_reason = ? WHERE id = ? AND status = ?')
    .run(normalizedReason, id, 'CANCELLING');

  let refund;
  try {
    refund = await stripeClient.createRefund({
      paymentIntentId: order.stripe_payment_intent_id,
      amountCents: refundAmountCents,
      metadata: { orderId: String(id), operationType: 'cancel' },
      idempotencyKey: `cancel_order_${id}`,
    });
  } catch (err) {
    revertTransition(id, 'CANCELLING', 'HELD');
    recordEvent(id, 'CANCEL_FAILED', { cancelledBy, error: err.message });
    throw new OrderError(`Stripe refund failed for order ${id}: ${err.message}`, 502);
  }

  // Re-read the order to pick up cancellation_reason (written above).
  return finalizeCancelled(getOrder(id), refund, { cancelledBy });
}

// Shared cancellation finalization — called by cancelOrder and by recoveryService.
// Reads cancellation_reason from the order row (written before the Stripe call).
// Throws FinalizeConflictError if the order was already finalized by a concurrent path.
async function finalizeCancelled(order, stripeRefund, { cancelledBy }) {
  const refundAmountCents = order.amount_cents - order.platform_fee_cents;
  const ts = nowIso();
  const finalized = db
    .prepare(
      `UPDATE orders SET status = 'CANCELLED', stripe_refund_id = ?,
         updated_at = ?, transition_started_at = NULL, recovery_claimed_at = NULL
         WHERE id = ? AND status = 'CANCELLING'`
    )
    .run(stripeRefund.id, ts, order.id);

  if (finalized.changes === 0) {
    recordEvent(order.id, 'CANCEL_FINALIZE_CONFLICT', { cancelledBy, stripeRefundId: stripeRefund.id });
    throw new FinalizeConflictError(order.id, 'cancel', stripeRefund.id);
  }

  recordEvent(order.id, 'CANCELLED', {
    cancelledBy,
    stripeRefundId: stripeRefund.id,
    refundAmountCents,
    platformFeeKeptCents: order.platform_fee_cents,
    reason: order.cancellation_reason,
  });
  notifications.notifyCancelled(order, { cancelledBy }).catch(() => {});

  // Best-effort: re-activate listing so it can be bought again.
  // This runs only after Stripe confirms the refund — never before.
  const reactivated = await markListingActive(order.listing_id);
  recordEvent(order.id, reactivated ? 'LISTING_REACTIVATED' : 'LISTING_REACTIVATE_FAILED', {
    listingId: order.listing_id,
  });

  return getOrderWithTimeline(order.id);
}

// ---- POST /orders/:id/confirm ----
async function confirmOrder(id) {
  return performRelease(id, { triggeredBy: 'buyer_confirm', fromStatus: 'DELIVERED' });
}

// ---- POST /orders/:id/dispute ----
// Reserves DELIVERED -> DISPUTED with the same atomic conditional-UPDATE
// pattern, so a dispute can never land after a release has already won the
// race for this order (and vice versa).
function disputeOrder(id, reasonText) {
  if (typeof reasonText !== 'string' || !reasonText.trim()) {
    throw new OrderError('dispute reason text is required and must be a non-empty string', 400);
  }

  const { category, matchedPattern } = categorizeDispute(reasonText);
  const ts = nowIso();
  const result = db
    .prepare(
      `UPDATE orders SET status = 'DISPUTED', dispute_reason_text = ?, dispute_category = ?, updated_at = ?
       WHERE id = ? AND status = 'DELIVERED'`
    )
    .run(reasonText, category, ts, id);

  if (result.changes === 0) {
    const current = db.prepare('SELECT status FROM orders WHERE id = ?').get(id);
    if (!current) throw new OrderError(`Order ${id} not found`, 404);
    throw new OrderError(
      `Order ${id} is already being released (status ${current.status}); dispute not possible`,
      409
    );
  }

  recordEvent(id, 'DISPUTED', { reasonText, category, matchedPattern });
  notifications.notifyDisputed(getOrder(id)).catch(() => {});

  return getOrderWithTimeline(id);
}

// ---- POST /admin/orders/:id/resolve ----
async function resolveDispute(id, action) {
  getOrder(id); // 404 if the order doesn't exist at all

  if (action === 'release') {
    await performRelease(id, { triggeredBy: 'admin_resolve', fromStatus: 'DISPUTED' });
    db.prepare(`UPDATE orders SET dispute_resolution = 'release' WHERE id = ?`).run(id);
    recordEvent(id, 'DISPUTE_RESOLVED', { action: 'release' });
    return getOrderWithTimeline(id);
  }

  if (action === 'refund') {
    await performRefund(id, { triggeredBy: 'admin_resolve', fromStatus: 'DISPUTED' });
    db.prepare(`UPDATE orders SET dispute_resolution = 'refund' WHERE id = ?`).run(id);
    recordEvent(id, 'DISPUTE_RESOLVED', { action: 'refund' });
    return getOrderWithTimeline(id);
  }

  throw new OrderError(`Unknown resolution action '${action}', expected 'release' or 'refund'`, 400);
}

// ---- Shared release-sweep logic: cron job AND POST /admin/run-release-check ----
// Scans DELIVERED orders (DISPUTED orders are a different status and are
// therefore never touched here - filing a dispute immediately removes an
// order from this sweep) whose window has expired, and releases them.
// Each candidate goes through the same guarded performRelease() as confirm/
// admin-release, so a candidate that's raced away (disputed, or released by
// another concurrent sweep/confirm) between the SELECT and this loop just
// fails its reservation and is reported in `failed`, never double-paid.
async function runReleaseCheck() {
  const nowIsoStr = nowIso();
  const candidates = db
    .prepare(
      `SELECT * FROM orders WHERE status = 'DELIVERED' AND window_expires_at IS NOT NULL AND window_expires_at <= ?`
    )
    .all(nowIsoStr);

  const released = [];
  const failed = [];
  for (const order of candidates) {
    try {
      const result = await performRelease(order.id, { triggeredBy: 'auto_release_sweep', fromStatus: 'DELIVERED' });
      released.push(result.id);
    } catch (err) {
      failed.push({ orderId: order.id, error: err.message });
    }
  }

  return {
    checkedAt: nowIsoStr,
    candidateCount: candidates.length,
    releasedOrderIds: released,
    failed,
  };
}

module.exports = {
  OrderError,
  FinalizeConflictError,
  computeFee,
  createOrder,
  captureOrder,
  cancelOrder,
  shipOrder,
  deliverOrder,
  confirmOrder,
  disputeOrder,
  resolveDispute,
  runReleaseCheck,
  getOrderWithTimeline,
  listOrders,
  // Shared finalization functions — used by both normal processing and recoveryService.
  finalizeCaptured,
  finalizeReleased,
  finalizeRefunded,
  finalizeCancelled,
};

'use strict';
// Core order state machine + escrow business logic.
// CREATED -> HELD -> SHIPPED -> DELIVERED -> RELEASED
//                                   |-> DISPUTED -> RELEASED | REFUNDED
//                                   |-> (buyer confirm) -> RELEASED
//
// The auto-release job (scheduler.js) and the manual
// POST /admin/run-release-check endpoint both call `runReleaseCheck()` below
// so there is exactly one implementation of the release-sweep logic.

const pool = require('./db');
const { stripeClient } = require('./stripeClient');
const { categorizeDispute } = require('./disputeCategorizer');
const notifications = require('./notifications');
const shippoClient = require('./shippoClient');

const DELIVERY_WINDOW_MS =
  Number(process.env.DELIVERY_WINDOW_HOURS || 48) * 60 * 60 * 1000;
const PLATFORM_FEE_BPS = Number(process.env.PLATFORM_FEE_BPS || 800); // 800 bps = 8%
const MIN_PLATFORM_FEE_CENTS = Number(process.env.MIN_PLATFORM_FEE_CENTS || 200); // $2.00 minimum
const LISTING_SERVICE_URL = process.env.LISTING_SERVICE_URL || 'http://localhost:3002';

// US address validation (buyer shipping address on orders)
const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
]);
const ZIP_RE = /^\d{5}(-\d{4})?$/;

function validateShippingAddress(addr) {
  if (!addr || typeof addr !== 'object') return 'shipping_address is required';
  if (!addr.name  || typeof addr.name  !== 'string' || !addr.name.trim())  return 'shipping_address.name is required';
  if (!addr.line1 || typeof addr.line1 !== 'string' || !addr.line1.trim()) return 'shipping_address.line1 is required';
  if (!addr.city  || typeof addr.city  !== 'string' || !addr.city.trim())  return 'shipping_address.city is required';
  if (!addr.state || !US_STATES.has(String(addr.state).toUpperCase())) return 'shipping_address.state must be a valid US state or DC abbreviation';
  if (!addr.zip   || !ZIP_RE.test(String(addr.zip).trim())) return 'shipping_address.zip must be a 5-digit or ZIP+4 US postal code';
  return null;
}

function sanitizeShippingAddress(addr) {
  return {
    name:  String(addr.name).trim(),
    line1: String(addr.line1).trim(),
    line2: addr.line2 ? String(addr.line2).trim() : null,
    city:  String(addr.city).trim(),
    state: String(addr.state).toUpperCase().trim(),
    zip:   String(addr.zip).trim(),
    phone: addr.phone ? String(addr.phone).replace(/\D/g, '') : null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

// Serialize a TIMESTAMPTZ column returned by pg (Date object or ISO string) to ISO string.
function ts(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

// Normalize an order row from pg: convert TIMESTAMPTZ Date objects to ISO strings.
// BIGINT columns (id, *_id) are already numbers via the type parser in db.js.
// shipping_address is stripped from all API responses (privacy — buyer's address).
function normalizeOrder(row) {
  if (!row) return null;
  // eslint-disable-next-line no-unused-vars
  const { shipping_address, ...rest } = row;
  return {
    ...rest,
    shipped_at:           ts(row.shipped_at),
    delivered_at:         ts(row.delivered_at),
    window_expires_at:    ts(row.window_expires_at),
    created_at:           ts(row.created_at),
    updated_at:           ts(row.updated_at),
    transition_started_at: ts(row.transition_started_at),
    recovery_claimed_at:  ts(row.recovery_claimed_at),
  };
}

function normalizeEvent(row) {
  if (!row) return null;
  return {
    ...row,
    created_at: ts(row.created_at),
    payload:    JSON.parse(row.payload_json || '{}'),
  };
}

// Integer-cents fee math (no floating point). 8% == 800 basis points, $2.00 minimum.
// Operates on item_price_cents only — shipping is excluded from the fee basis.
// Fee = max(8% of item price, $2.00 min), capped at item price to prevent negative payout.
function computeFee(itemPriceCents) {
  const rawFeeCents = Math.round((itemPriceCents * PLATFORM_FEE_BPS) / 10000);
  const platformFeeCents = Math.min(Math.max(rawFeeCents, MIN_PLATFORM_FEE_CENTS), itemPriceCents);
  const sellerPayoutCents = itemPriceCents - platformFeeCents;
  return { platformFeeCents, sellerPayoutCents };
}

async function recordEvent(orderId, eventType, payload) {
  await pool.query(
    `INSERT INTO order_events (order_id, event_type, payload_json, created_at)
     VALUES ($1, $2, $3, $4)`,
    [orderId, eventType, JSON.stringify(payload || {}), nowIso()]
  );
}

async function getOrder(id) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
  if (!rows[0]) throw new OrderError(`Order ${id} not found`, 404);
  return normalizeOrder(rows[0]);
}

async function getOrderWithTimeline(id) {
  const order = await getOrder(id);
  const { rows } = await pool.query(
    'SELECT * FROM order_events WHERE order_id = $1 ORDER BY id ASC',
    [id]
  );
  return { ...order, events: rows.map(normalizeEvent) };
}

async function listOrders({ buyerId, sellerId }) {
  if (buyerId) {
    const { rows } = await pool.query(
      'SELECT * FROM orders WHERE buyer_id = $1 ORDER BY id DESC',
      [buyerId]
    );
    return rows.map(normalizeOrder);
  }
  if (sellerId) {
    const { rows } = await pool.query(
      'SELECT * FROM orders WHERE seller_id = $1 ORDER BY id DESC',
      [sellerId]
    );
    return rows.map(normalizeOrder);
  }
  const { rows } = await pool.query('SELECT * FROM orders ORDER BY id DESC');
  return rows.map(normalizeOrder);
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
function isPositiveIntegerId(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0;
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return Number(value) > 0;
  return false;
}

// ---------------------------------------------------------------------------
// External service calls
// ---------------------------------------------------------------------------

async function fetchAuthoritativeListing(listingId) {
  let res;
  try {
    res = await fetch(`${LISTING_SERVICE_URL}/listings/${listingId}`);
  } catch (err) {
    throw new OrderError(`Could not reach listing-service to verify listing ${listingId}`, 502);
  }
  if (res.status === 404) throw new OrderError(`Listing ${listingId} not found`, 404);
  if (!res.ok) throw new OrderError(`listing-service returned an error for listing ${listingId}`, 502);
  return res.json();
}

async function markListingActive(listingId) {
  try {
    const res = await fetch(`${LISTING_SERVICE_URL}/listings/${listingId}/mark-active`, {
      method: 'PATCH',
      headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET || '' },
    });
    if (!res.ok) throw new Error(`listing-service returned ${res.status}`);
    return true;
  } catch (err) {
    console.error(`[orderService] markListingActive(${listingId}) failed:`, err.message);
    return false;
  }
}

async function markListingSold(listingId) {
  try {
    const res = await fetch(`${LISTING_SERVICE_URL}/listings/${listingId}/mark-sold`, {
      method: 'PATCH',
      headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET || '' },
    });
    if (!res.ok) throw new Error(`listing-service returned ${res.status}`);
    return true;
  } catch (err) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

class OrderError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Thrown by shared finalize functions when the conditional UPDATE finds the
// order is no longer in the expected transient status.
class FinalizeConflictError extends Error {
  constructor(orderId, operationType, stripeId) {
    super(`Order ${orderId} ${operationType} finalize conflict (Stripe ID: ${stripeId}) — another path already finalized`);
    this.name = 'FinalizeConflictError';
    this.orderId = orderId;
    this.stripeId = stripeId;
  }
}

// ---------------------------------------------------------------------------
// Atomic reserve/revert helpers
// ---------------------------------------------------------------------------

// Returns true if the reservation succeeded (rowCount > 0).
// Uses a single conditional UPDATE — atomic in PostgreSQL.
async function reserveTransition(orderId, fromStatus, toStatus) {
  const ts_now = nowIso();
  const result = await pool.query(
    `UPDATE orders
     SET status = $1, updated_at = $2, prior_status = status, transition_started_at = $3
     WHERE id = $4 AND status = $5`,
    [toStatus, ts_now, ts_now, orderId, fromStatus]
  );
  return result.rowCount > 0;
}

async function revertTransition(orderId, fromStatus, toStatus) {
  const ts_now = nowIso();
  await pool.query(
    `UPDATE orders SET status = $1, updated_at = $2 WHERE id = $3 AND status = $4`,
    [toStatus, ts_now, orderId, fromStatus]
  );
}

async function reservationConflictError(orderId, expectedStatus, action) {
  const { rows } = await pool.query('SELECT status FROM orders WHERE id = $1', [orderId]);
  if (!rows[0]) return new OrderError(`Order ${orderId} not found`, 404);
  return new OrderError(
    `Order ${orderId} cannot be ${action}: expected status ${expectedStatus} but order is ${rows[0].status} ` +
    `(already reserved/processed by a concurrent request, or in an incompatible state)`,
    409
  );
}

// ---------------------------------------------------------------------------
// Exported helpers used by app.js shipping-rates route
// ---------------------------------------------------------------------------

// Expose validateShippingAddress under a public name so app.js can call it
// before even hitting createOrder (for the /shipping-rates pre-check).
function validateShippingAddressPublic(addr) {
  return validateShippingAddress(addr);
}

// Expose fetchAuthoritativeListing for the /shipping-rates route.
async function fetchListingPublic(listingId) {
  return fetchAuthoritativeListing(listingId);
}

// ---------------------------------------------------------------------------
// POST /orders
// ---------------------------------------------------------------------------

async function createOrder({ listingId, buyerId, shippingAddress, shippoRateId, rateToken }) {
  if (!isPositiveIntegerId(listingId)) {
    throw new OrderError('listing_id must be a positive integer', 400);
  }
  if (!isPositiveIntegerId(buyerId)) {
    throw new OrderError('buyer_id must be a positive integer', 400);
  }
  const addrError = validateShippingAddress(shippingAddress);
  if (addrError) throw new OrderError(addrError, 422);
  if (!shippoRateId) {
    throw new OrderError('shippo_rate_id is required — select a shipping rate before placing an order', 422);
  }
  if (!rateToken) {
    throw new OrderError('rate_token is required — retrieve fresh shipping rates and select one', 422);
  }
  const sanitizedAddr = sanitizeShippingAddress(shippingAddress);
  const normalizedListingId = Number(listingId);
  const normalizedBuyerId   = Number(buyerId);

  const listing = await fetchAuthoritativeListing(normalizedListingId);
  if (listing.status && listing.status !== 'active') {
    throw new OrderError(`Listing ${normalizedListingId} is not active (status: ${listing.status})`, 409);
  }
  const sellerId = Number(listing.seller_id);

  const { rows: buyerRows } = await pool.query('SELECT * FROM users WHERE id = $1', [normalizedBuyerId]);
  if (!buyerRows[0]) throw new OrderError(`Buyer ${normalizedBuyerId} not found`, 404);

  if (sellerId === normalizedBuyerId) {
    throw new OrderError('buyer_id cannot be the seller of the listing (cannot buy your own listing)', 400);
  }

  const itemPriceCents = listing.price_cents;
  if (!Number.isInteger(itemPriceCents) || itemPriceCents <= 0) {
    throw new OrderError(
      `Listing ${normalizedListingId} has an invalid price_cents (${itemPriceCents}); item_price_cents must be a positive integer`,
      400
    );
  }

  // ── Shipping rate verification ────────────────────────────────────────────
  // 1. Re-fetch seller's ship-from address (authoritative from escrow DB).
  const { rows: sellerRows } = await pool.query('SELECT ship_from_address FROM users WHERE id = $1', [sellerId]);
  const sellerShipFrom = sellerRows[0]?.ship_from_address
    ? (typeof sellerRows[0].ship_from_address === 'string'
        ? JSON.parse(sellerRows[0].ship_from_address)
        : sellerRows[0].ship_from_address)
    : null;
  if (!sellerShipFrom) {
    throw new OrderError(
      `Order cannot be created: seller ${sellerId} has no ship-from address on file`,
      422
    );
  }

  // 2. Validate package dims on the listing (must exist — enforced at listing creation).
  const { weight_oz, pkg_length_in, pkg_width_in, pkg_height_in } = listing;
  const missingDims = [
    !weight_oz     && 'weight_oz',
    !pkg_length_in && 'pkg_length_in',
    !pkg_width_in  && 'pkg_width_in',
    !pkg_height_in && 'pkg_height_in',
  ].filter(Boolean);
  if (missingDims.length > 0) {
    throw new OrderError(
      `Listing ${normalizedListingId} is missing package dimensions: ${missingDims.join(', ')}`,
      422
    );
  }

  const parcel = {
    weight_oz:  Number(weight_oz),
    length_in:  Number(pkg_length_in),
    width_in:   Number(pkg_width_in),
    height_in:  Number(pkg_height_in),
  };

  // 3. Verify rate_token — binds shippo_rate_id to this listing + seller zip + buyer address + parcel.
  const tokenValid = shippoClient.verifyRateToken(
    rateToken,
    shippoRateId,
    normalizedListingId,
    sellerShipFrom.zip,
    sanitizedAddr,   // normalized buyer address (same normalization used when token was issued)
    parcel
  );
  if (!tokenValid) {
    throw new OrderError(
      'Shipping rate is not valid for this order — please refresh shipping rates and select again',
      422
    );
  }

  // 4. Fetch the rate from Shippo to get the authoritative price.
  //    The browser-submitted price is ignored entirely.
  const rateData = await shippoClient.getRate(shippoRateId);
  if (!rateData) {
    throw new OrderError(
      'Selected shipping rate has expired or is invalid — please refresh shipping rates and select again',
      422
    );
  }
  const shippingCents = rateData.price_cents;

  const amountCents = itemPriceCents + shippingCents;
  // Platform fee is based on item price only — shipping passes through to carrier.
  const { platformFeeCents, sellerPayoutCents } = computeFee(itemPriceCents);

  // Keep local mirror in sync for admin views.
  await pool.query(
    `INSERT INTO listings (id, seller_id, title, price_cents)
     OVERRIDING SYSTEM VALUE
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET
       seller_id   = EXCLUDED.seller_id,
       title       = EXCLUDED.title,
       price_cents = EXCLUDED.price_cents`,
    [normalizedListingId, sellerId, listing.title, itemPriceCents]
  );

  const intent = await stripeClient.createPaymentIntent({
    amountCents,
    currency: 'usd',
    metadata: { listingId: String(normalizedListingId), buyerId: String(normalizedBuyerId) },
  });

  const ts_now = nowIso();
  const { rows: inserted } = await pool.query(
    `INSERT INTO orders (
       listing_id, buyer_id, seller_id, amount_cents, item_price_cents, shipping_cents,
       platform_fee_cents, seller_payout_cents,
       status, stripe_payment_intent_id, stripe_client_secret, shipping_address,
       shippo_rate_id,
       created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'CREATED', $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      normalizedListingId, normalizedBuyerId, sellerId,
      amountCents, itemPriceCents, shippingCents,
      platformFeeCents, sellerPayoutCents,
      intent.id, intent.client_secret || null,
      JSON.stringify(sanitizedAddr),
      shippoRateId,
      ts_now, ts_now,
    ]
  );
  const orderId = Number(inserted[0].id);

  await recordEvent(orderId, 'ORDER_CREATED', {
    listingId: normalizedListingId,
    buyerId: normalizedBuyerId,
    sellerId,
    itemPriceCents,
    shippingCents,
    amountCents,
    platformFeeCents,
    sellerPayoutCents,
    shippoRateId,
    stripePaymentIntentId: intent.id,
    stripeMode: stripeClient.mode,
  });

  return getOrderWithTimeline(orderId);
}

// ---------------------------------------------------------------------------
// POST /orders/:id/capture
// ---------------------------------------------------------------------------

async function captureOrder(id) {
  if (!await reserveTransition(id, 'CREATED', 'CAPTURING')) {
    throw await reservationConflictError(id, 'CREATED', 'captured');
  }

  const order = await getOrder(id);

  let captured;
  try {
    captured = await stripeClient.capturePaymentIntent(order.stripe_payment_intent_id, {
      idempotencyKey: `capture_order_${id}`,
    });
    if (captured.status !== 'succeeded') {
      throw new Error(`Stripe capture did not succeed (status=${captured.status})`);
    }
  } catch (err) {
    await revertTransition(id, 'CAPTURING', 'CREATED');
    await recordEvent(id, 'CAPTURE_FAILED', { error: err.message });
    throw new OrderError(`Stripe capture failed for order ${id}: ${err.message}`, 502);
  }

  return finalizeCaptured(order, captured, { triggeredBy: 'capture_request' });
}

// Shared capture finalization — called by captureOrder and by recoveryService.
async function finalizeCaptured(order, stripeCapture, { triggeredBy }) {
  const ts_now = nowIso();
  const client = await pool.connect();
  let conflict = false;

  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE orders
       SET status = 'HELD', stripe_payment_intent_id = $1, stripe_charge_id = $2,
           updated_at = $3, transition_started_at = NULL, recovery_claimed_at = NULL
       WHERE id = $4 AND status = 'CAPTURING'`,
      [stripeCapture.id, stripeCapture.chargeId || null, ts_now, order.id]
    );
    if (result.rowCount === 0) {
      conflict = true;
      throw new FinalizeConflictError(order.id, 'capture', stripeCapture.id);
    }
    await client.query(
      `INSERT INTO order_events (order_id, event_type, payload_json, created_at)
       VALUES ($1, $2, $3, $4)`,
      [order.id, 'PAYMENT_CAPTURED', JSON.stringify({
        triggeredBy,
        stripePaymentIntentId: stripeCapture.id,
        chargeId: stripeCapture.chargeId || null,
      }), ts_now]
    );
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (conflict) {
      await pool.query(
        `INSERT INTO order_events (order_id, event_type, payload_json, created_at)
         VALUES ($1, $2, $3, $4)`,
        [order.id, 'CAPTURE_FINALIZE_CONFLICT',
         JSON.stringify({ triggeredBy, stripePaymentIntentId: stripeCapture.id }), ts_now]
      );
    }
    throw err;
  } finally {
    client.release();
  }

  const markedSold = await markListingSold(order.listing_id);
  await recordEvent(order.id, markedSold ? 'LISTING_MARKED_SOLD' : 'LISTING_MARK_SOLD_FAILED', {
    listingId: order.listing_id,
  });

  notifications.notifyOrderCaptured(order).catch(() => {});
  return getOrderWithTimeline(order.id);
}

// ---------------------------------------------------------------------------
// POST /orders/:id/ship
// ---------------------------------------------------------------------------

async function shipOrder(id) {
  const order = await getOrder(id);
  assertStatus(order, 'HELD');

  const ts_now = nowIso();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE orders SET status = 'SHIPPED', shipped_at = $1, updated_at = $2 WHERE id = $3`,
      [ts_now, ts_now, id]
    );
    await client.query(
      `INSERT INTO order_events (order_id, event_type, payload_json, created_at)
       VALUES ($1, $2, $3, $4)`,
      [id, 'SHIPPED', JSON.stringify({ shippedAt: ts_now }), ts_now]
    );
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }

  notifications.notifyShipped(order).catch(() => {});
  return getOrderWithTimeline(id);
}

// ---------------------------------------------------------------------------
// POST /orders/:id/deliver
// ---------------------------------------------------------------------------

async function deliverOrder(id) {
  const order = await getOrder(id);
  assertStatus(order, 'SHIPPED');

  const ts_now = nowIso();
  const windowExpiresAt = new Date(Date.now() + DELIVERY_WINDOW_MS).toISOString();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE orders
       SET status = 'DELIVERED', delivered_at = $1, window_expires_at = $2, updated_at = $3
       WHERE id = $4`,
      [ts_now, windowExpiresAt, ts_now, id]
    );
    await client.query(
      `INSERT INTO order_events (order_id, event_type, payload_json, created_at)
       VALUES ($1, $2, $3, $4)`,
      [id, 'DELIVERED', JSON.stringify({ deliveredAt: ts_now, windowExpiresAt }), ts_now]
    );
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }

  notifications.notifyDelivered(order).catch(() => {});
  return getOrderWithTimeline(id);
}

// ---------------------------------------------------------------------------
// Shared release implementation
// ---------------------------------------------------------------------------

async function performRelease(orderId, { triggeredBy, fromStatus }) {
  if (!await reserveTransition(orderId, fromStatus, 'RELEASING')) {
    throw await reservationConflictError(orderId, fromStatus, 'released');
  }

  const order = await getOrder(orderId);

  let transfer;
  try {
    const { rows: sellerRows } = await pool.query('SELECT * FROM users WHERE id = $1', [order.seller_id]);
    const seller = sellerRows[0];
    if (!seller || !seller.stripe_account_id) {
      await revertTransition(orderId, 'RELEASING', fromStatus);
      await recordEvent(orderId, 'RELEASE_FAILED', {
        triggeredBy,
        error: `seller ${order.seller_id} has no connected Stripe account`,
      });
      throw new OrderError(
        `Order ${orderId} cannot be released: seller ${order.seller_id} has no connected Stripe account`,
        502
      );
    }
    const destination = seller.stripe_account_id;
    if (!order.stripe_charge_id) {
      await revertTransition(orderId, 'RELEASING', fromStatus);
      await recordEvent(orderId, 'RELEASE_FAILED', {
        triggeredBy,
        error: 'stripe_charge_id is not set — manual reconciliation required',
      });
      throw new OrderError(
        `Order ${orderId} cannot be released: stripe_charge_id is not set. ` +
        `Look up the Charge ID (ch_...) for PaymentIntent ${order.stripe_payment_intent_id} ` +
        `in the Stripe dashboard, then UPDATE orders SET stripe_charge_id = 'ch_...' WHERE id = ${orderId}`,
        500
      );
    }
    transfer = await stripeClient.createTransfer({
      amountCents:         order.seller_payout_cents,
      currency:            'usd',
      destination,
      metadata:            { orderId: String(order.id), operationType: 'release' },
      sourceTransactionId: order.stripe_charge_id,
      transferGroup:       `order_${orderId}`,
      idempotencyKey:      `release_order_${orderId}`,
    });
  } catch (err) {
    if (!(err instanceof OrderError)) {
      await revertTransition(orderId, 'RELEASING', fromStatus);
      await recordEvent(orderId, 'RELEASE_FAILED', { triggeredBy, error: err.message });
      throw new OrderError(`Stripe transfer failed for order ${orderId}: ${err.message}`, 502);
    }
    throw err;
  }

  return finalizeReleased(order, transfer, { triggeredBy });
}

// Shared release finalization — called by performRelease and by recoveryService.
async function finalizeReleased(order, stripeTransfer, { triggeredBy }) {
  const ts_now = nowIso();
  const client = await pool.connect();
  let conflict = false;

  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE orders
       SET status = 'RELEASED', stripe_transfer_id = $1,
           updated_at = $2, transition_started_at = NULL, recovery_claimed_at = NULL
       WHERE id = $3 AND status = 'RELEASING'`,
      [stripeTransfer.id, ts_now, order.id]
    );
    if (result.rowCount === 0) {
      conflict = true;
      throw new FinalizeConflictError(order.id, 'release', stripeTransfer.id);
    }
    await client.query(
      `INSERT INTO order_events (order_id, event_type, payload_json, created_at)
       VALUES ($1, $2, $3, $4)`,
      [order.id, 'RELEASED', JSON.stringify({
        triggeredBy,
        stripeTransferId:    stripeTransfer.id,
        sellerPayoutCents:   order.seller_payout_cents,
        platformFeeCents:    order.platform_fee_cents,
      }), ts_now]
    );
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (conflict) {
      await pool.query(
        `INSERT INTO order_events (order_id, event_type, payload_json, created_at)
         VALUES ($1, $2, $3, $4)`,
        [order.id, 'RELEASE_FINALIZE_CONFLICT',
         JSON.stringify({ triggeredBy, stripeTransferId: stripeTransfer.id }), ts_now]
      );
    }
    throw err;
  } finally {
    client.release();
  }

  notifications.notifyReleased(order, { triggeredBy }).catch(() => {});
  return getOrderWithTimeline(order.id);
}

// ---------------------------------------------------------------------------
// Shared refund implementation
// ---------------------------------------------------------------------------

async function performRefund(orderId, { triggeredBy, fromStatus }) {
  if (!await reserveTransition(orderId, fromStatus, 'REFUNDING')) {
    throw await reservationConflictError(orderId, fromStatus, 'refunded');
  }

  const order = await getOrder(orderId);

  let refund;
  try {
    refund = await stripeClient.createRefund({
      paymentIntentId: order.stripe_payment_intent_id,
      amountCents:     order.amount_cents,
      metadata:        { orderId: String(orderId), operationType: 'refund_dispute' },
      idempotencyKey:  `refund_dispute_order_${orderId}`,
    });
  } catch (err) {
    await revertTransition(orderId, 'REFUNDING', fromStatus);
    await recordEvent(orderId, 'REFUND_FAILED', { triggeredBy, error: err.message });
    throw new OrderError(`Stripe refund failed for order ${orderId}: ${err.message}`, 502);
  }

  return finalizeRefunded(order, refund, { triggeredBy });
}

// Shared refund finalization — called by performRefund and by recoveryService.
async function finalizeRefunded(order, stripeRefund, { triggeredBy }) {
  const ts_now = nowIso();
  const client = await pool.connect();
  let conflict = false;

  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE orders
       SET status = 'REFUNDED', stripe_refund_id = $1,
           updated_at = $2, transition_started_at = NULL, recovery_claimed_at = NULL
       WHERE id = $3 AND status = 'REFUNDING'`,
      [stripeRefund.id, ts_now, order.id]
    );
    if (result.rowCount === 0) {
      conflict = true;
      throw new FinalizeConflictError(order.id, 'refund', stripeRefund.id);
    }
    await client.query(
      `INSERT INTO order_events (order_id, event_type, payload_json, created_at)
       VALUES ($1, $2, $3, $4)`,
      [order.id, 'REFUNDED', JSON.stringify({ triggeredBy, stripeRefundId: stripeRefund.id }), ts_now]
    );
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (conflict) {
      await pool.query(
        `INSERT INTO order_events (order_id, event_type, payload_json, created_at)
         VALUES ($1, $2, $3, $4)`,
        [order.id, 'REFUND_FINALIZE_CONFLICT',
         JSON.stringify({ triggeredBy, stripeRefundId: stripeRefund.id }), ts_now]
      );
    }
    throw err;
  } finally {
    client.release();
  }

  notifications.notifyRefunded(order, { triggeredBy }).catch(() => {});
  return getOrderWithTimeline(order.id);
}

// ---------------------------------------------------------------------------
// POST /orders/:id/cancel
// ---------------------------------------------------------------------------

async function cancelOrder(id, { cancelledBy, reason }) {
  const normalizedReason = reason != null ? String(reason).trim() || null : null;

  if (!await reserveTransition(id, 'HELD', 'CANCELLING')) {
    throw await reservationConflictError(id, 'HELD', 'cancelled');
  }

  const order = await getOrder(id);

  if (order.platform_fee_cents == null || !Number.isFinite(order.amount_cents - order.platform_fee_cents)) {
    await revertTransition(id, 'CANCELLING', 'HELD');
    throw new OrderError(`Order ${id} has invalid fee data; cannot compute refund amount`, 500);
  }
  const refundAmountCents = order.amount_cents - order.platform_fee_cents;

  // Persist cancellation metadata before Stripe call so recovery can read it.
  await pool.query(
    'UPDATE orders SET cancellation_reason = $1, cancellation_cause = $2 WHERE id = $3 AND status = $4',
    [normalizedReason, 'buyer_change_of_mind', id, 'CANCELLING']
  );

  let refund;
  if (refundAmountCents === 0) {
    // Platform fee equals the entire order amount; no Stripe refund needed.
    refund = { id: null };
  } else {
    try {
      refund = await stripeClient.createRefund({
        paymentIntentId: order.stripe_payment_intent_id,
        amountCents:     refundAmountCents,
        metadata:        { orderId: String(id), operationType: 'cancel' },
        idempotencyKey:  `cancel_order_${id}`,
      });
    } catch (err) {
      await revertTransition(id, 'CANCELLING', 'HELD');
      await recordEvent(id, 'CANCEL_FAILED', { cancelledBy, error: err.message });
      throw new OrderError(`Stripe refund failed for order ${id}: ${err.message}`, 502);
    }
  }

  return finalizeCancelled(await getOrder(id), refund, { cancelledBy });
}

// Shared cancellation finalization — called by cancelOrder and by recoveryService.
async function finalizeCancelled(order, stripeRefund, { cancelledBy }) {
  // seller_late: full refund (platform does not retain fee)
  // buyer_change_of_mind or null: partial refund (platform keeps fee)
  const refundAmountCents = order.cancellation_cause === 'seller_late'
    ? order.amount_cents
    : order.amount_cents - order.platform_fee_cents;
  const ts_now = nowIso();
  const client = await pool.connect();
  let conflict = false;

  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE orders
       SET status = 'CANCELLED', stripe_refund_id = $1,
           updated_at = $2, transition_started_at = NULL, recovery_claimed_at = NULL
       WHERE id = $3 AND status = 'CANCELLING'`,
      [stripeRefund.id, ts_now, order.id]
    );
    if (result.rowCount === 0) {
      conflict = true;
      throw new FinalizeConflictError(order.id, 'cancel', stripeRefund.id);
    }
    await client.query(
      `INSERT INTO order_events (order_id, event_type, payload_json, created_at)
       VALUES ($1, $2, $3, $4)`,
      [order.id, 'CANCELLED', JSON.stringify({
        cancelledBy,
        stripeRefundId:       stripeRefund.id,
        refundAmountCents,
        platformFeeKeptCents: order.platform_fee_cents,
        reason:               order.cancellation_reason,
      }), ts_now]
    );
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (conflict) {
      await pool.query(
        `INSERT INTO order_events (order_id, event_type, payload_json, created_at)
         VALUES ($1, $2, $3, $4)`,
        [order.id, 'CANCEL_FINALIZE_CONFLICT',
         JSON.stringify({ cancelledBy, stripeRefundId: stripeRefund.id }), ts_now]
      );
    }
    throw err;
  } finally {
    client.release();
  }

  notifications.notifyCancelled(order, { cancelledBy }).catch(() => {});

  const reactivated = await markListingActive(order.listing_id);
  await recordEvent(order.id, reactivated ? 'LISTING_REACTIVATED' : 'LISTING_REACTIVATE_FAILED', {
    listingId: order.listing_id,
  });

  return getOrderWithTimeline(order.id);
}

// ---------------------------------------------------------------------------
// POST /orders/:id/confirm
// ---------------------------------------------------------------------------

async function confirmOrder(id) {
  return performRelease(id, { triggeredBy: 'buyer_confirm', fromStatus: 'DELIVERED' });
}

// ---------------------------------------------------------------------------
// POST /orders/:id/dispute
// ---------------------------------------------------------------------------

async function disputeOrder(id, reasonText) {
  if (typeof reasonText !== 'string' || !reasonText.trim()) {
    throw new OrderError('dispute reason text is required and must be a non-empty string', 400);
  }

  const { category, matchedPattern } = categorizeDispute(reasonText);
  const ts_now = nowIso();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE orders
       SET status = 'DISPUTED', dispute_reason_text = $1, dispute_category = $2, updated_at = $3
       WHERE id = $4 AND status = 'DELIVERED'`,
      [reasonText, category, ts_now, id]
    );
    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      const { rows } = await pool.query('SELECT status FROM orders WHERE id = $1', [id]);
      if (!rows[0]) throw new OrderError(`Order ${id} not found`, 404);
      throw new OrderError(
        `Order ${id} is already being released (status ${rows[0].status}); dispute not possible`,
        409
      );
    }
    await client.query(
      `INSERT INTO order_events (order_id, event_type, payload_json, created_at)
       VALUES ($1, $2, $3, $4)`,
      [id, 'DISPUTED', JSON.stringify({ reasonText, category, matchedPattern }), ts_now]
    );
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }

  const order = await getOrder(id);
  notifications.notifyDisputed(order).catch(() => {});
  return getOrderWithTimeline(id);
}

// ---------------------------------------------------------------------------
// POST /admin/orders/:id/resolve
// ---------------------------------------------------------------------------

async function resolveDispute(id, action) {
  await getOrder(id); // 404 if not found

  if (action === 'release') {
    await performRelease(id, { triggeredBy: 'admin_resolve', fromStatus: 'DISPUTED' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE orders SET dispute_resolution = 'release' WHERE id = $1`, [id]);
      await client.query(
        `INSERT INTO order_events (order_id, event_type, payload_json, created_at)
         VALUES ($1, $2, $3, $4)`,
        [id, 'DISPUTE_RESOLVED', JSON.stringify({ action: 'release' }), nowIso()]
      );
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
    return getOrderWithTimeline(id);
  }

  if (action === 'refund') {
    await performRefund(id, { triggeredBy: 'admin_resolve', fromStatus: 'DISPUTED' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE orders SET dispute_resolution = 'refund' WHERE id = $1`, [id]);
      await client.query(
        `INSERT INTO order_events (order_id, event_type, payload_json, created_at)
         VALUES ($1, $2, $3, $4)`,
        [id, 'DISPUTE_RESOLVED', JSON.stringify({ action: 'refund' }), nowIso()]
      );
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
    return getOrderWithTimeline(id);
  }

  throw new OrderError(`Unknown resolution action '${action}', expected 'release' or 'refund'`, 400);
}

// ---------------------------------------------------------------------------
// Auto-release sweep
// ---------------------------------------------------------------------------

async function runReleaseCheck() {
  const nowIsoStr = nowIso();
  const { rows: candidates } = await pool.query(
    `SELECT * FROM orders
     WHERE status = 'DELIVERED'
       AND window_expires_at IS NOT NULL
       AND window_expires_at <= $1`,
    [nowIsoStr]
  );

  const released = [];
  const failed   = [];
  for (const rawOrder of candidates) {
    const order = normalizeOrder(rawOrder);
    try {
      const result = await performRelease(order.id, {
        triggeredBy: 'auto_release_sweep',
        fromStatus:  'DELIVERED',
      });
      released.push(result.id);
    } catch (err) {
      failed.push({ orderId: order.id, error: err.message });
    }
  }

  return {
    checkedAt:       nowIsoStr,
    candidateCount:  candidates.length,
    releasedOrderIds: released,
    failed,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

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
  finalizeCaptured,
  finalizeReleased,
  finalizeRefunded,
  finalizeCancelled,
  // Exported for use by the /shipping-rates route in app.js.
  validateShippingAddressPublic,
  fetchListingPublic,
};

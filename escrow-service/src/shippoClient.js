'use strict';
/**
 * Shippo REST API wrapper.
 *
 * Modes
 * ──────────────────────────────────────────────────────────────────────────
 * stub  — SHIPPO_API_KEY absent AND NODE_ENV !== 'production'
 *         Returns synthetic rates for automated tests and local dev.
 *         Stub rates have fixed IDs that stub getRate() can look up.
 *
 * real  — SHIPPO_API_KEY is set → calls Shippo test/live REST API.
 *
 * If SHIPPO_API_KEY is absent in a production environment (NODE_ENV=production),
 * getRates() and getRate() throw a 503-level error rather than silently
 * returning fake data.  This prevents staging from accidentally serving
 * test-mode stub prices to buyers.
 *
 * Rate-token security
 * ──────────────────────────────────────────────────────────────────────────
 * Every rate returned by getRates() includes a rate_token: an HMAC-SHA256
 * signature over:
 *   rate_id | listing_id | seller_zip | buyer name/addr/zip | parcel dims
 *
 * The token cryptographically binds a Shippo rate_id to the exact quote
 * context (which listing, which seller ship-from, which buyer ship-to,
 * which parcel).  On order creation the server re-derives the token and
 * rejects any mismatch, ensuring the browser cannot swap in a cheaper rate
 * from a different address or listing.
 */

const crypto = require('crypto');

const SHIPPO_API_KEY = process.env.SHIPPO_API_KEY || '';
const IS_PRODUCTION  = process.env.NODE_ENV === 'production';
const STUB_MODE      = !SHIPPO_API_KEY && !IS_PRODUCTION;

const SHIPPO_BASE = 'https://api.goshippo.com';

// ── Stub data ──────────────────────────────────────────────────────────────

const STUB_RATES = [
  {
    rate_id:      'stub_rate_usps_priority',
    carrier:      'USPS',
    service:      'Priority Mail',
    price_cents:  895,
    est_days:     2,
    est_delivery: null,
  },
  {
    rate_id:      'stub_rate_usps_first_class',
    carrier:      'USPS',
    service:      'First Class Package',
    price_cents:  425,
    est_days:     4,
    est_delivery: null,
  },
  {
    rate_id:      'stub_rate_ups_ground',
    carrier:      'UPS',
    service:      'UPS® Ground',
    price_cents:  1150,
    est_days:     5,
    est_delivery: null,
  },
];

// Keyed by rate_id for O(1) lookup in getRate() stub.
const STUB_RATE_MAP = Object.fromEntries(STUB_RATES.map(r => [r.rate_id, r]));

// ── HMAC rate-token helpers ────────────────────────────────────────────────

/**
 * Build the canonical signing payload for a rate.
 * Any change to listing_id, seller zip, buyer address, or parcel dims
 * produces a different token — the browser cannot forge a valid one.
 */
function _tokenPayload(rateId, listingId, sellerZip, buyerAddr, parcel) {
  return [
    String(rateId),
    String(listingId),
    String(sellerZip || '').trim(),
    String(buyerAddr.name  || '').trim(),
    String(buyerAddr.line1 || '').trim(),
    String(buyerAddr.line2 || '').trim(),
    String(buyerAddr.city  || '').trim(),
    String(buyerAddr.state || '').toUpperCase().trim(),
    String(buyerAddr.zip   || '').trim(),
    String(parcel.weight_oz),
    String(parcel.length_in),
    String(parcel.width_in),
    String(parcel.height_in),
  ].join('|');
}

function _hmacSecret() {
  return (
    process.env.SHIPPING_HMAC_SECRET ||
    process.env.INTERNAL_SERVICE_SECRET ||
    'dev-shipping-secret'
  );
}

function makeRateToken(rateId, listingId, sellerZip, buyerAddr, parcel) {
  const payload = _tokenPayload(rateId, listingId, sellerZip, buyerAddr, parcel);
  return crypto.createHmac('sha256', _hmacSecret()).update(payload).digest('base64url');
}

function verifyRateToken(token, rateId, listingId, sellerZip, buyerAddr, parcel) {
  const expected = makeRateToken(rateId, listingId, sellerZip, buyerAddr, parcel);
  if (!token || token.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── Real Shippo helpers ────────────────────────────────────────────────────

function _shippoFetch(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      Authorization:  `ShippoToken ${SHIPPO_API_KEY}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`${SHIPPO_BASE}${path}`, opts);
}

// Convert a Shippo Rate object to our internal shape, adding rate_token.
function _normalizeRate(r, listingId, sellerZip, buyerAddr, parcel) {
  const priceCents = Math.round(parseFloat(r.amount_local || r.amount) * 100);
  return {
    rate_id:      r.object_id,
    carrier:      r.provider,
    service:      r.servicelevel ? r.servicelevel.name : r.service_level_name || '',
    price_cents:  priceCents,
    est_days:     r.estimated_days ?? null,
    est_delivery: r.duration_terms || null,
    rate_token:   makeRateToken(r.object_id, listingId, sellerZip, buyerAddr, parcel),
  };
}

// ── Label purchase error types ─────────────────────────────────────────────
//
// Callers (purchaseLabelForOrder) branch on err.definitive:
//   true  → Shippo definitively rejected or reported ERROR; safe to revert.
//   false → Ambiguous (network / 5xx); unknown whether label was created;
//            leave order in LABELING and let recovery resolve.

class ShippoDefinitiveError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.definitive  = true;
    this.statusCode  = statusCode || 502;
  }
}

class ShippoAmbiguousError extends Error {
  constructor(message) {
    super(message);
    this.definitive  = false;
    this.statusCode  = 503;
  }
}

// Normalize a Shippo Transaction object into our internal label shape.
function _normalizeLabelResult(t) {
  return {
    label_id:        t.object_id,
    label_url:       t.label_url || null,
    tracking_number: t.tracking_number || null,
    carrier:         t.tracking_carrier || null,
    carrier_service: t.servicelevel_token || null,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * getRates — create a Shippo shipment and return available rates.
 *
 * @param {object} from       seller ship-from address { name, line1, line2?, city, state, zip, phone?, email? }
 * @param {object} to         buyer  ship-to  address  { name, line1, line2?, city, state, zip }
 * @param {object} parcel     { weight_oz, length_in, width_in, height_in }
 * @param {number} listingId  used to bind the rate token to this specific listing
 * @param {object} buyerAddr  raw buyer address (identical to `to` — kept separate for token clarity)
 * @returns {Promise<Array>}  array of { rate_id, carrier, service, price_cents, est_days, est_delivery, rate_token }
 */
async function getRates(from, to, parcel, listingId, buyerAddr) {
  if (!SHIPPO_API_KEY) {
    if (IS_PRODUCTION) {
      const err = new Error(
        'Shipping rates are not available: SHIPPO_API_KEY is not configured. ' +
        'Contact the site administrator.'
      );
      err.statusCode = 503;
      throw err;
    }
    // Stub mode — local dev and automated tests only.
    return STUB_RATES.map(r => ({
      ...r,
      rate_token: makeRateToken(r.rate_id, listingId, from.zip, buyerAddr, parcel),
    }));
  }

  const shipmentBody = {
    address_from: {
      name:    from.name    || 'Seller',
      street1: from.line1,
      street2: from.line2   || '',
      city:    from.city,
      state:   from.state,
      zip:     from.zip,
      country: 'US',
      phone:   from.phone   || '',
      email:   from.email   || '',
    },
    address_to: {
      name:    to.name      || 'Buyer',
      street1: to.line1,
      street2: to.line2     || '',
      city:    to.city,
      state:   to.state,
      zip:     to.zip,
      country: 'US',
    },
    parcels: [
      {
        length:        String(parcel.length_in),
        width:         String(parcel.width_in),
        height:        String(parcel.height_in),
        distance_unit: 'in',
        // Shippo expects pounds; convert from ounces.
        weight:        (parcel.weight_oz / 16).toFixed(4),
        mass_unit:     'lb',
      },
    ],
    async: false,
  };

  console.log(
    `[shippo] getRates: listing=${listingId} ` +
    `from_state=${from.state} from_zip=${from.zip} ` +
    `to_state=${to.state} to_zip=${String(to.zip || '').slice(0, 3)}xxx ` +
    `parcel=${JSON.stringify(parcel)}`
  );

  const res = await _shippoFetch('/shipments/', 'POST', shipmentBody);
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    console.error(`[shippo] shipment HTTP ${res.status}:`, JSON.stringify(errBody));
    const err = new Error(
      `Shippo shipment creation failed: ${errBody.detail || errBody.non_field_errors || res.status}`
    );
    err.statusCode = 502;
    throw err;
  }

  const data = await res.json();
  console.log(
    `[shippo] shipment ${data.object_id} status=${data.status} ` +
    `rates_total=${(data.rates || []).length} ` +
    `msg_count=${(data.messages || []).length}`
  );

  const rates = (data.rates || [])
    .filter(r => r.object_status !== 'INVALID')
    .map(r => _normalizeRate(r, listingId, from.zip, buyerAddr, parcel));

  console.log(`[shippo] returning ${rates.length} valid rate(s) to caller`);
  return rates;
}

/**
 * getRate — fetch a single rate by ID.
 * Returns { rate_id, price_cents } or null if rate not found/expired.
 * Used server-side to get the authoritative price before creating an order.
 */
async function getRate(rateId) {
  if (!SHIPPO_API_KEY) {
    if (IS_PRODUCTION) {
      const err = new Error('Shippo is not configured');
      err.statusCode = 503;
      throw err;
    }
    // Stub mode.
    const r = STUB_RATE_MAP[rateId];
    if (!r) return null;
    return { rate_id: r.rate_id, price_cents: r.price_cents, carrier: r.carrier, carrier_service: r.service };
  }

  const res = await _shippoFetch(`/rates/${rateId}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const err = new Error(`Shippo rate fetch failed: ${errBody.detail || res.status}`);
    err.statusCode = 502;
    throw err;
  }
  const r = await res.json();
  return {
    rate_id:         r.object_id,
    price_cents:     Math.round(parseFloat(r.amount_local || r.amount) * 100),
    carrier:         r.provider || null,
    carrier_service: r.servicelevel ? r.servicelevel.name : (r.service_level_name || null),
  };
}

/**
 * purchaseLabel — buy a shipping label from Shippo for the given rate.
 *
 * Uses async:false so Shippo processes the purchase synchronously.
 * Sets metadata:"order:<orderId>" for crash-recovery lookup.
 *
 * Throws ShippoDefinitiveError for:
 *   - HTTP 4xx (Shippo rejected the request)
 *   - Transaction status ERROR (Shippo processed but label failed)
 *   - Unexpected non-SUCCESS status with async:false
 *
 * Throws ShippoAmbiguousError for:
 *   - Network-level errors (timeout, ECONNRESET, etc.)
 *   - HTTP 5xx (Shippo may have started processing)
 *
 * Caller must handle the two error types differently:
 *   definitive → revert LABELING → HELD (retry is safe)
 *   ambiguous  → leave in LABELING (recovery will query Shippo to resolve)
 */
async function purchaseLabel(rateId, orderId) {
  if (!SHIPPO_API_KEY) {
    if (IS_PRODUCTION) {
      throw new ShippoDefinitiveError('Shippo is not configured (SHIPPO_API_KEY missing)', 503);
    }
    // Stub mode — return synthetic label data for local dev and tests.
    const stubRate = STUB_RATE_MAP[rateId] || { carrier: 'USPS', service: 'Priority Mail' };
    return {
      label_id:        `stub_txn_${rateId}_order_${orderId}`,
      label_url:       'https://example.com/stub-label-sample.pdf',
      tracking_number: `STUB${Date.now()}`,
      carrier:         stubRate.carrier,
      carrier_service: stubRate.service,
    };
  }

  let res;
  try {
    res = await _shippoFetch('/transactions/', 'POST', {
      rate:            rateId,
      label_file_type: 'PDF',
      async:           false,
      metadata:        `order:${orderId}`,
    });
  } catch (networkErr) {
    // Network-level failure: the request may or may not have reached Shippo.
    throw new ShippoAmbiguousError(
      `Network error contacting Shippo during label purchase: ${networkErr.message}`
    );
  }

  // HTTP 4xx — definitive: Shippo rejected the request before creating anything.
  if (res.status >= 400 && res.status < 500) {
    const errBody = await res.json().catch(() => ({}));
    throw new ShippoDefinitiveError(
      `Shippo label purchase rejected (HTTP ${res.status}): ` +
      (errBody.detail || errBody.non_field_errors || JSON.stringify(errBody)),
      502
    );
  }

  // HTTP 5xx — ambiguous: Shippo may have begun processing the transaction.
  if (res.status >= 500) {
    const errBody = await res.json().catch(() => ({}));
    throw new ShippoAmbiguousError(
      `Shippo returned HTTP ${res.status} during label purchase: ` +
      (errBody.detail || String(res.status))
    );
  }

  const t = await res.json();

  // status ERROR — definitive: Shippo created a record but the label failed.
  if (t.status === 'ERROR') {
    const msgs = (t.messages || [])
      .map(m => m.text || m.message || JSON.stringify(m))
      .join('; ');
    throw new ShippoDefinitiveError(
      `Shippo transaction created but label purchase failed (status ERROR): ${msgs || 'no detail'}`,
      502
    );
  }

  // With async:false, any status other than SUCCESS is unexpected.
  if (t.status !== 'SUCCESS') {
    throw new ShippoDefinitiveError(
      `Shippo label purchase returned unexpected status: ${t.status}`,
      502
    );
  }

  console.log(`[shippo] purchaseLabel: txn=${t.object_id} tracking=${t.tracking_number} order=${orderId}`);
  return _normalizeLabelResult(t);
}

/**
 * findTransactionByRate — query Shippo for any transaction created for this
 * rate+order combination.  Used by crash recovery to determine whether a
 * label was purchased during an ambiguous failure (network timeout, 5xx).
 *
 * Returns one of:
 *   { label_id, label_url, tracking_number, carrier, carrier_service }
 *       → SUCCESS transaction found; caller should finalize the order.
 *   { error: true }
 *       → ERROR transaction found; definitive failure, safe to revert.
 *   { pending: true, status }
 *       → QUEUED/WAITING; still in progress, retry next sweep.
 *   null
 *       → No transaction found; positive confirmation, safe to revert.
 *
 * Throws on network/API errors (caller should treat as ambiguous).
 *
 * NOTE: Shippo does not support server-side filtering by rate or metadata.
 * We fetch the most-recent 50 transactions and filter client-side using:
 *   primary   — t.rate === rateId
 *   secondary — t.metadata === 'order:<orderId>'  (exact match)
 * This covers all practical recovery scenarios (label purchased within
 * minutes of the ambiguous failure).
 */
async function findTransactionByRate(rateId, orderId) {
  if (!SHIPPO_API_KEY) {
    // Stub mode has no persistent transaction store.
    return null;
  }

  let res;
  try {
    res = await _shippoFetch('/transactions/?results=50', 'GET');
  } catch (networkErr) {
    throw new Error(`Cannot query Shippo transactions for recovery: ${networkErr.message}`);
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(
      `Shippo transactions list returned HTTP ${res.status}: ` +
      (errBody.detail || String(res.status))
    );
  }

  const data = await res.json();
  const transactions = data.results || [];

  const expectedMeta = `order:${orderId}`;
  const match = transactions.find(
    t => t.rate === rateId && t.metadata === expectedMeta
  );

  if (!match) return null;

  if (match.status === 'SUCCESS') {
    return _normalizeLabelResult(match);
  }

  if (match.status === 'ERROR') {
    return { error: true };
  }

  // QUEUED or WAITING — still in progress (should not happen with async:false).
  return { pending: true, status: match.status };
}

/**
 * voidLabel — request a Shippo refund/void for a purchased shipping label.
 *
 * Uses async:false so Shippo processes the void synchronously.
 *
 * Throws ShippoDefinitiveError for:
 *   - HTTP 4xx (Shippo rejected the void — label already used, too old, etc.)
 *   - Refund status ERROR (Shippo processed but void definitively failed)
 *   - Unexpected non-SUCCESS status
 *
 * Throws ShippoAmbiguousError for:
 *   - Network-level errors (timeout, ECONNRESET, etc.)
 *   - HTTP 5xx (Shippo may have started processing)
 *
 * Caller branches on err.definitive:
 *   true  → record LABEL_VOID_FAILED; continue with order cancellation
 *   false → leave order in CANCELLING; recovery reconciles via findRefundByTransaction
 *
 * In stub mode, STUB_VOID_MODE env var controls behaviour (for tests only):
 *   'definitive' → throws ShippoDefinitiveError
 *   'ambiguous'  → throws ShippoAmbiguousError
 *   (unset)      → returns synthetic success
 */
async function voidLabel(labelId) {
  if (!SHIPPO_API_KEY) {
    if (IS_PRODUCTION) {
      throw new ShippoDefinitiveError('Shippo is not configured (SHIPPO_API_KEY missing)', 503);
    }
    const mode = process.env.STUB_VOID_MODE || '';
    if (mode === 'definitive') {
      throw new ShippoDefinitiveError('Stub: definitive void failure (STUB_VOID_MODE=definitive)');
    }
    if (mode === 'ambiguous') {
      throw new ShippoAmbiguousError('Stub: ambiguous void failure (STUB_VOID_MODE=ambiguous)');
    }
    return { void_id: `stub_void_${labelId}`, refund_cents: 0 };
  }

  let res;
  try {
    res = await _shippoFetch('/refunds/', 'POST', { transaction: labelId, async: false });
  } catch (networkErr) {
    throw new ShippoAmbiguousError(
      `Network error contacting Shippo during label void: ${networkErr.message}`
    );
  }

  if (res.status >= 400 && res.status < 500) {
    const errBody = await res.json().catch(() => ({}));
    throw new ShippoDefinitiveError(
      `Shippo label void rejected (HTTP ${res.status}): ` +
      (errBody.detail || errBody.non_field_errors || JSON.stringify(errBody)),
      502
    );
  }

  if (res.status >= 500) {
    const errBody = await res.json().catch(() => ({}));
    throw new ShippoAmbiguousError(
      `Shippo returned HTTP ${res.status} during label void: ` +
      (errBody.detail || String(res.status))
    );
  }

  const r = await res.json();

  if (r.status === 'ERROR') {
    const msgs = (r.messages || [])
      .map(m => m.text || m.message || JSON.stringify(m))
      .join('; ');
    throw new ShippoDefinitiveError(
      `Shippo label void failed (status ERROR): ${msgs || 'no detail'}`,
      502
    );
  }

  // QUEUED or PENDING — void is still processing; treat as ambiguous so recovery
  // can reconcile via findRefundByTransaction on the next sweep rather than
  // treating the in-flight void as a definitive failure.
  if (r.status === 'QUEUED' || r.status === 'PENDING') {
    throw new ShippoAmbiguousError(
      `Shippo label void is still processing (status: ${r.status}) — recovery will reconcile`
    );
  }

  if (r.status !== 'SUCCESS') {
    throw new ShippoDefinitiveError(
      `Shippo label void returned unexpected status: ${r.status}`,
      502
    );
  }

  console.log(`[shippo] voidLabel: refund=${r.object_id} label=${labelId} amount=${r.amount}`);
  return {
    void_id:      r.object_id,
    refund_cents: Math.round(parseFloat(r.amount || 0) * 100),
  };
}

/**
 * findRefundByTransaction — query Shippo for any refund created for this label_id.
 * Used by crash recovery to reconcile ambiguous void outcomes before deciding
 * whether to retry the void or continue with cancellation.
 *
 * Returns one of:
 *   { void_id, refund_cents } → SUCCESS refund found; write label_voided_at.
 *   { error: true }           → ERROR status; definitive failure, continue without void.
 *   { pending: true, status } → QUEUED/PENDING; still processing, retry next sweep.
 *   null                      → No refund found; positive confirmation, safe to retry void.
 *
 * In stub mode, always returns null (no persistent state).
 */
async function findRefundByTransaction(labelId) {
  if (!SHIPPO_API_KEY) {
    return null; // stub mode — no persistent transaction store
  }

  let res;
  try {
    res = await _shippoFetch('/refunds/?results=50', 'GET');
  } catch (networkErr) {
    throw new Error(`Cannot query Shippo refunds for void recovery: ${networkErr.message}`);
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(
      `Shippo refunds list returned HTTP ${res.status}: ` +
      (errBody.detail || String(res.status))
    );
  }

  const data = await res.json();
  const refunds = data.results || [];
  const match = refunds.find(r => r.transaction === labelId);

  if (!match) return null;

  if (match.status === 'SUCCESS') {
    return {
      void_id:      match.object_id,
      refund_cents: Math.round(parseFloat(match.amount || 0) * 100),
    };
  }

  if (match.status === 'ERROR') {
    return { error: true };
  }

  // QUEUED or PENDING — still processing, retry next sweep.
  return { pending: true, status: match.status };
}

// ── Webhook token verification ─────────────────────────────────────────────

/**
 * verifyWebhookToken — constant-time comparison of a provided URL query token
 * against the expected SHIPPO_WEBHOOK_TOKEN env var value.
 *
 * Uses HMAC-SHA256 digests of both values so that timingSafeEqual always
 * receives equal-length (32-byte) buffers regardless of token length.
 * This avoids leaking token length via a timing side-channel on the
 * length-check branch that Buffer.from comparisons would require.
 *
 * @param {string|undefined} provided  — value from req.query.token
 * @param {string}           expected  — value from process.env.SHIPPO_WEBHOOK_TOKEN
 * @returns {boolean}
 */
function verifyWebhookToken(provided, expected) {
  if (!provided || !expected) return false;
  // Digest both values with a fixed comparison key so timingSafeEqual always
  // gets 32-byte buffers regardless of input length.
  const CMP_KEY = 'shippo-wh-tok-cmp';
  const h1 = crypto.createHmac('sha256', CMP_KEY).update(String(provided)).digest();
  const h2 = crypto.createHmac('sha256', CMP_KEY).update(String(expected)).digest();
  try {
    return crypto.timingSafeEqual(h1, h2);
  } catch {
    return false;
  }
}

/**
 * registerTracking — register a carrier+tracking_number with Shippo to receive
 * webhook events for own-label shipments.  Best-effort; caller wraps in try-catch.
 *
 * Stub mode: no-op (returns immediately without network call).
 * Real mode: POST /tracks/ with carrier + tracking_number.
 */
async function registerTracking(carrier, trackingNumber, orderId) {
  if (!SHIPPO_API_KEY) {
    // Stub mode — no-op.
    return;
  }

  const res = await _shippoFetch('/tracks/', 'POST', {
    carrier:          carrier.toLowerCase(),
    tracking_number:  trackingNumber,
    metadata:         `order:${orderId}`,
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const err = new Error(
      `Shippo registerTracking failed: ${errBody.detail || res.status}`
    );
    err.statusCode = res.status;
    throw err;
  }
}

module.exports = {
  getRates,
  getRate,
  purchaseLabel,
  findTransactionByRate,
  voidLabel,
  findRefundByTransaction,
  registerTracking,
  makeRateToken,
  verifyRateToken,
  verifyWebhookToken,
  STUB_MODE,
};

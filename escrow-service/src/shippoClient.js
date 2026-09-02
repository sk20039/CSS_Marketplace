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

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * getRates — create a Shippo shipment and return available rates.
 *
 * @param {object} from       seller ship-from address { name, line1, line2?, city, state, zip }
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
    return { rate_id: r.rate_id, price_cents: r.price_cents };
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
    rate_id:     r.object_id,
    price_cents: Math.round(parseFloat(r.amount_local || r.amount) * 100),
  };
}

module.exports = {
  getRates,
  getRate,
  makeRateToken,
  verifyRateToken,
  STUB_MODE,
};

// tests/shipping.test.js
// Shipping rate retrieval, rate-token verification, order creation with shipping,
// amount math, and tamper-protection tests for escrow-service.
//
// Runs entirely in stub mode (no SHIPPO_API_KEY required).
// Run: node tests/shipping.test.js
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST ||
  'postgres://escrow_user:escrow_pass@127.0.0.1:5432/escrow_db_test';
delete process.env.STRIPE_SECRET_KEY;
delete process.env.SHIPPO_API_KEY;         // force stub mode
delete process.env.NODE_ENV;               // not production → stub allowed
process.env.LISTING_SERVICE_URL     = 'http://127.0.0.1:19876';
process.env.FRONTEND_ORIGIN         = 'http://localhost:3003';
process.env.JWT_SECRET              = 'test-jwt-secret';
process.env.SHIPPING_HMAC_SECRET    = 'test-shipping-hmac-secret-32chars!!';
process.env.INTERNAL_SERVICE_SECRET = 'test-internal-secret-32-chars!!!';

const http    = require('http');
const request = require('supertest');
const { buildApp } = require('../src/app');
const pool    = require('../src/db');

// ── Minimal test harness ──────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`);
}
function assertMatch(str, re, msg) {
  if (!re.test(str)) throw new Error(msg || `Expected /${re.source}/ to match: ${str}`);
}

// ── Listing-service mock ──────────────────────────────────────────────────
// Stands in for the real listing-service so createOrder and shipping-rates
// can call fetchAuthoritativeListing() without a running service.

let mockListingData = {
  id: 1, seller_id: 1, title: 'Test Bat', price_cents: 2000,
  status: 'active',
  weight_oz: 64, pkg_length_in: 36, pkg_width_in: 6, pkg_height_in: 6,
};

function startMockListingService() {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (/\/listings\/\d+$/.test(req.url)) {
      res.writeHead(200);
      res.end(JSON.stringify(mockListingData));
    } else if (/\/listings\/\d+\/mark-sold/.test(req.url)) {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });
  server.listen(19876);
  return server;
}

// ── DB helpers ────────────────────────────────────────────────────────────

let testUserId;
let testSellerId;
let buyerToken;
let sellerToken;

async function seedUsers() {
  // Delete in FK-safe order.
  await pool.query('DELETE FROM reviews');
  await pool.query('DELETE FROM messages');
  await pool.query('DELETE FROM order_events');
  await pool.query('DELETE FROM orders');
  await pool.query('DELETE FROM listings');
  await pool.query('DELETE FROM users');

  const shipFrom = JSON.stringify({
    name: 'Test Seller', line1: '123 Ship St', city: 'Houston',
    state: 'TX', zip: '77001', phone: '5551234567',
  });

  const { rows: [seller] } = await pool.query(
    `INSERT INTO users (name, email, role, ship_from_address)
     OVERRIDING SYSTEM VALUE
     VALUES ('Test Seller', 'seller@test.test', 'seller', $1)
     ON CONFLICT (email) DO UPDATE SET ship_from_address = $1
     RETURNING id`,
    [shipFrom]
  );
  testSellerId = Number(seller.id);

  const { rows: [buyer] } = await pool.query(
    `INSERT INTO users (name, email, role)
     OVERRIDING SYSTEM VALUE
     VALUES ('Test Buyer', 'buyer@test.test', 'buyer')
     ON CONFLICT (email) DO UPDATE SET role = 'buyer'
     RETURNING id`,
  );
  testUserId = Number(buyer.id);

  // Also ensure a listing mirror exists in escrow (seller_id matches).
  await pool.query(
    `INSERT INTO listings (id, seller_id, title, price_cents)
     OVERRIDING SYSTEM VALUE
     VALUES (1, $1, 'Test Bat', 2000)
     ON CONFLICT (id) DO UPDATE SET seller_id = $1, price_cents = 2000`,
    [testSellerId]
  );

  // Update mock listing data seller_id to match.
  mockListingData.seller_id = testSellerId;
}

function makeJwt(userId, role) {
  const jwt = require('jsonwebtoken');
  const secret = process.env.JWT_SECRET || 'change-me';
  return jwt.sign({ sub: userId, email: `${role}@test.test`, role }, secret, { expiresIn: '1h' });
}

// ── Shared fixtures ────────────────────────────────────────────────────────

const VALID_BUYER_ADDR = {
  name: 'Test Buyer', line1: '456 Buy Ln', city: 'Austin',
  state: 'TX', zip: '78701', phone: '5559876543',
};

// ── Tests ─────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n=== escrow-service shipping tests ===');

  const mockServer = startMockListingService();
  const app = buildApp();
  await seedUsers();

  buyerToken  = makeJwt(testUserId,   'buyer');
  sellerToken = makeJwt(testSellerId, 'seller');

  // ── 1. POST /shipping-rates — happy path ───────────────────────────────

  await test('POST /shipping-rates returns stub rates for valid listing', async () => {
    const res = await request(app)
      .post('/shipping-rates')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ listing_id: 1, shipping_address: VALID_BUYER_ADDR });
    assertEqual(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(Array.isArray(res.body.rates), 'rates must be an array');
    assert(res.body.rates.length > 0, 'rates must not be empty');
    const r = res.body.rates[0];
    assert(r.rate_id,     'rate must have rate_id');
    assert(r.carrier,     'rate must have carrier');
    assert(r.service,     'rate must have service');
    assert(r.price_cents > 0, 'rate must have positive price_cents');
    assert(r.rate_token,  'rate must have rate_token');
    assert(res.body.stub === true, 'stub flag must be true in test mode');
  });

  // ── 2. POST /shipping-rates — missing package dims ─────────────────────

  await test('POST /shipping-rates returns 422 when listing has no package dims', async () => {
    const saved = { ...mockListingData };
    mockListingData = { ...mockListingData, weight_oz: null, pkg_length_in: null, pkg_width_in: null, pkg_height_in: null };
    const res = await request(app)
      .post('/shipping-rates')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ listing_id: 1, shipping_address: VALID_BUYER_ADDR });
    mockListingData = saved;
    assertEqual(res.status, 422, `expected 422, got ${res.status}`);
    assert(res.body.error.includes('missing package dimensions'), `unexpected error: ${res.body.error}`);
  });

  // ── 3. POST /shipping-rates — invalid shipping address ─────────────────

  await test('POST /shipping-rates returns 422 for invalid buyer address', async () => {
    const res = await request(app)
      .post('/shipping-rates')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ listing_id: 1, shipping_address: { name: 'X', line1: '1 St', city: 'Austin', state: 'ZZ', zip: '78701' } });
    assertEqual(res.status, 422, `expected 422, got ${res.status}`);
    assertMatch(res.body.error, /state/, 'error should mention state');
  });

  // ── 4. POST /shipping-rates — missing listing_id ───────────────────────

  await test('POST /shipping-rates returns 400 when listing_id is missing', async () => {
    const res = await request(app)
      .post('/shipping-rates')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ shipping_address: VALID_BUYER_ADDR });
    assertEqual(res.status, 400, `expected 400, got ${res.status}`);
  });

  // ── 5. POST /shipping-rates — requires auth ────────────────────────────

  await test('POST /shipping-rates returns 401 without auth token', async () => {
    const res = await request(app)
      .post('/shipping-rates')
      .send({ listing_id: 1, shipping_address: VALID_BUYER_ADDR });
    assertEqual(res.status, 401, `expected 401, got ${res.status}`);
  });

  // ── 6. POST /orders — free-shipping model ────────────────────────────────

  await test('POST /orders creates order with shipping_cents=0 (free shipping model)', async () => {
    const res = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ listing_id: 1, shipping_address: VALID_BUYER_ADDR });
    assertEqual(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    const order = res.body;
    assertEqual(order.shipping_cents, 0, 'shipping_cents must be 0 (free shipping)');
    assertEqual(order.item_price_cents, mockListingData.price_cents, 'item_price_cents must match listing');
    // In stub mode tax = 0, so amount_cents == item_price_cents
    assertEqual(order.amount_cents, mockListingData.price_cents,
      'amount_cents must equal item price only (no shipping component)');
  });

  // ── 7. POST /orders — extra rate fields are silently ignored ──────────────

  await test('POST /orders ignores extra rate fields — still returns 201 with shipping_cents=0', async () => {
    const res = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({
        listing_id: 1,
        shipping_address: VALID_BUYER_ADDR,
        shippo_rate_id: 'stub_rate_usps_priority',
        rate_token:     'some_token_value',
      });
    assertEqual(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assertEqual(res.body.shipping_cents, 0, 'shipping_cents must be 0 regardless of extra fields');
  });

  // ── 8. POST /orders — amount_cents has no shipping component ─────────────

  await test('amount_cents equals item price only (no shipping component)', async () => {
    const res = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ listing_id: 1, shipping_address: VALID_BUYER_ADDR });
    assertEqual(res.status, 201, `expected 201, got ${res.status}`);
    const order = res.body;
    assertEqual(order.amount_cents, order.item_price_cents,
      'amount_cents must equal item_price_cents (no shipping)');
    assertEqual(order.shipping_cents, 0, 'shipping_cents must be 0');
    const expectedFee = Math.max(Math.round((order.item_price_cents * 800) / 10000), 200);
    assertEqual(order.platform_fee_cents, expectedFee,
      'platform_fee_cents must be based on item price only');
    assertEqual(order.seller_payout_cents, order.item_price_cents - expectedFee,
      'seller_payout = item - fee');
  });

  // ── 9. POST /orders — seller_payout does not include shipping ────────────

  await test('seller_payout_cents does not include shipping (shipping is seller responsibility)', async () => {
    const res = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ listing_id: 1, shipping_address: VALID_BUYER_ADDR });
    assertEqual(res.status, 201, `expected 201, got ${res.status}`);
    const order = res.body;
    const expectedFee = Math.max(Math.round((order.item_price_cents * 800) / 10000), 200);
    // seller_payout = item_price - platform_fee only (no shipping added)
    assertEqual(order.seller_payout_cents, order.item_price_cents - expectedFee,
      'seller_payout_cents must not include any shipping amount');
    assert(order.seller_payout_cents > 0, 'seller payout must be positive');
  });

  // ── 10. POST /orders — shipping_address is still required ────────────────

  await test('POST /orders returns 4xx when shipping_address is missing', async () => {
    const res = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ listing_id: 1 });
    assert(res.status >= 400, `expected 4xx error, got ${res.status}`);
  });

  // ── 11. POST /orders — order has CREATED status ───────────────────────────

  await test('POST /orders returns order in CREATED status with correct id', async () => {
    const res = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ listing_id: 1, shipping_address: VALID_BUYER_ADDR });
    assertEqual(res.status, 201, `expected 201, got ${res.status}`);
    const order = res.body;
    assert(order.id, 'order must have an id');
    assertEqual(order.status, 'CREATED', `expected CREATED, got ${order.status}`);
    assertEqual(order.amount_cents, order.item_price_cents,
      'amount_cents == item price only');
    assertEqual(order.shipping_cents, 0, 'shipping_cents must be 0');
  });

  // ── 12. Platform fee is item-price-only regardless of shipping ────────────

  await test('Platform fee is based on item price only (shipping excluded from fee base)', async () => {
    const res = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ listing_id: 1, shipping_address: VALID_BUYER_ADDR });
    assertEqual(res.status, 201, `expected 201, got ${JSON.stringify(res.body)}`);
    const order = res.body;
    const itemOnly = mockListingData.price_cents; // 2000 cents
    const expectedFee = Math.max(Math.round((itemOnly * 800) / 10000), 200);
    assertEqual(order.platform_fee_cents, expectedFee,
      'platform fee must not include shipping');
    assertEqual(order.seller_payout_cents, itemOnly - expectedFee,
      'seller payout must not include shipping');
    assertEqual(order.shipping_cents, 0,
      'shipping_cents must be 0 in free-shipping model');
    assertEqual(order.amount_cents, itemOnly,
      'total must be item price only (no shipping)');
  });

  // ── 13. Seller with no ship_from_address → 422 on /shipping-rates ──────

  await test('POST /shipping-rates returns 422 when seller has no ship_from_address', async () => {
    // Temporarily clear seller's ship_from_address.
    await pool.query('UPDATE users SET ship_from_address = NULL WHERE id = $1', [testSellerId]);
    const res = await request(app)
      .post('/shipping-rates')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ listing_id: 1, shipping_address: VALID_BUYER_ADDR });
    // Restore.
    const shipFrom = JSON.stringify({
      name: 'Test Seller', line1: '123 Ship St', city: 'Houston',
      state: 'TX', zip: '77001', phone: '5551234567',
    });
    await pool.query('UPDATE users SET ship_from_address = $1 WHERE id = $2', [shipFrom, testSellerId]);
    assertEqual(res.status, 422, `expected 422, got ${res.status}: ${JSON.stringify(res.body)}`);
    assertMatch(res.body.error, /ship.from/i, `unexpected error: ${res.body.error}`);
  });

  // ── Cleanup ────────────────────────────────────────────────────────────

  mockServer.close();
  await pool.end();

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();

// tests/free_shipping.test.js
// Tests for the free-shipping model:
//   - Buyer pays nothing for shipping (shipping_cents = 0 on all orders)
//   - Seller fetches rates via GET /orders/:id/seller-shipping-rates (HELD only)
//   - Seller buys platform label via POST /orders/:id/purchase-label
//   - Seller uses own label via POST /orders/:id/ship-own-label
//   - Payout guard: label cost > seller_payout → 422 before Shippo call
//   - Release with platform label: transfer = seller_payout - label_cost_cents
//   - Release with own label: transfer = full seller_payout (no deduction)
//
// Runs entirely in stub mode.  Run: node tests/free_shipping.test.js
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST ||
  'postgres://escrow_user:escrow_pass@127.0.0.1:5432/escrow_db_test';
delete process.env.STRIPE_SECRET_KEY;
delete process.env.SHIPPO_API_KEY;
delete process.env.NODE_ENV;
process.env.LISTING_SERVICE_URL     = 'http://127.0.0.1:19877';
process.env.FRONTEND_ORIGIN         = 'http://localhost:3003';
process.env.JWT_SECRET              = 'test-jwt-secret';
process.env.SHIPPING_HMAC_SECRET    = 'test-shipping-hmac-secret-32chars!!';
process.env.INTERNAL_SERVICE_SECRET = 'test-internal-secret-32-chars!!!';
// Raise rate limits so lifecycle tests don't self-throttle.
process.env.RATE_LIMIT_LABEL_PURCHASE_MAX = '500';
process.env.RATE_LIMIT_ORDER_CREATE_MAX   = '500';
process.env.RATE_LIMIT_DISPUTE_MAX        = '500';

const http    = require('http');
const request = require('supertest');
const { buildApp } = require('../src/app');
const pool    = require('../src/db');
const { stripeClient } = require('../src/stripeClient');

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
    if (process.env.VERBOSE) console.error(err.stack);
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

// ── Mock listing service ──────────────────────────────────────────────────

let mockSellerId;
let mockListingData = {
  id: 1, title: 'Test Bat', price_cents: 5000,
  status: 'active',
  weight_oz: 64, pkg_length_in: 36, pkg_width_in: 6, pkg_height_in: 6,
};

function startMockListingService() {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (/\/listings\/\d+$/.test(req.url)) {
      res.writeHead(200);
      res.end(JSON.stringify({ ...mockListingData, seller_id: mockSellerId }));
    } else if (/\/listings\/\d+\/mark-sold/.test(req.url)) {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    } else if (/\/listings\/\d+\/mark-active/.test(req.url)) {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });
  server.listen(19877);
  return server;
}

// ── DB helpers ────────────────────────────────────────────────────────────

let testBuyerId;
let testSellerId;
let testAdminId;
let buyerToken;
let sellerToken;
let adminToken;

async function seedUsers() {
  await pool.query('DELETE FROM reviews');
  await pool.query('DELETE FROM messages');
  await pool.query('DELETE FROM order_events');
  await pool.query('DELETE FROM orders');
  await pool.query('DELETE FROM listings');
  await pool.query('DELETE FROM users');

  const shipFrom = JSON.stringify({
    name: 'Free Ship Seller', line1: '100 Seller Ave', city: 'Houston',
    state: 'TX', zip: '77001', phone: '5550001111',
  });

  const { rows: [seller] } = await pool.query(
    `INSERT INTO users (name, email, role, stripe_account_id, ship_from_address)
     OVERRIDING SYSTEM VALUE
     VALUES ('Free Ship Seller', 'fs_seller@test.test', 'seller', 'acct_stub_fs_seller', $1)
     ON CONFLICT (email) DO UPDATE
       SET ship_from_address = $1, stripe_account_id = 'acct_stub_fs_seller'
     RETURNING id`,
    [shipFrom]
  );
  testSellerId = Number(seller.id);
  mockSellerId = testSellerId;

  const { rows: [buyer] } = await pool.query(
    `INSERT INTO users (name, email, role)
     OVERRIDING SYSTEM VALUE
     VALUES ('Free Ship Buyer', 'fs_buyer@test.test', 'buyer')
     ON CONFLICT (email) DO UPDATE SET role = 'buyer'
     RETURNING id`,
  );
  testBuyerId = Number(buyer.id);

  const { rows: [admin] } = await pool.query(
    `INSERT INTO users (name, email, role)
     OVERRIDING SYSTEM VALUE
     VALUES ('Free Ship Admin', 'fs_admin@test.test', 'admin')
     ON CONFLICT (email) DO UPDATE SET role = 'admin'
     RETURNING id`,
  );
  testAdminId = Number(admin.id);

  await pool.query(
    `INSERT INTO listings (id, seller_id, title, price_cents)
     OVERRIDING SYSTEM VALUE
     VALUES (1, $1, 'Test Bat', 5000)
     ON CONFLICT (id) DO UPDATE SET seller_id = $1, price_cents = 5000`,
    [testSellerId]
  );
}

function makeJwt(userId, role) {
  const jwt = require('jsonwebtoken');
  return jwt.sign(
    { sub: userId, email: `${role}@test.test`, role },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

// ── Shared fixtures ────────────────────────────────────────────────────────

const VALID_BUYER_ADDR = {
  name: 'Free Ship Buyer', line1: '456 Buy Ln', city: 'Austin',
  state: 'TX', zip: '78701', phone: '5559876543',
};

// ── Lifecycle helpers ──────────────────────────────────────────────────────

// Create and capture an order, returning orderId in HELD state.
async function createHeldOrder(app) {
  const createRes = await request(app)
    .post('/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ listing_id: 1, shipping_address: VALID_BUYER_ADDR });
  assert(createRes.status === 201, `createOrder failed: ${JSON.stringify(createRes.body)}`);
  const orderId = createRes.body.id;

  const captureRes = await request(app)
    .post(`/orders/${orderId}/capture`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({});
  assert(captureRes.status === 200, `capture failed: ${JSON.stringify(captureRes.body)}`);
  assertEqual(captureRes.body.status, 'HELD', `expected HELD, got ${captureRes.body.status}`);
  return orderId;
}

// Fetch the first seller rate for a HELD order.
async function getFirstSellerRate(app, orderId) {
  const ratesRes = await request(app)
    .get(`/orders/${orderId}/seller-shipping-rates`)
    .set('Authorization', `Bearer ${sellerToken}`);
  assert(ratesRes.status === 200, `getSellerRates failed: ${JSON.stringify(ratesRes.body)}`);
  assert(ratesRes.body.rates.length > 0, 'rates must not be empty');
  return ratesRes.body.rates[0];
}

// Bring an order to RELEASED through: HELD→label→(db SHIPPED)→deliver→confirm.
// Platform label orders are transitioned to SHIPPED by the carrier TRANSIT webhook;
// in tests, we advance the status directly in the DB to avoid needing a real webhook.
async function releaseOrderWithPlatformLabel(app, orderId) {
  const rate = await getFirstSellerRate(app, orderId);

  const labelRes = await request(app)
    .post(`/orders/${orderId}/purchase-label`)
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ shippo_rate_id: rate.rate_id, rate_token: rate.rate_token });
  assert(labelRes.status === 200, `purchase-label failed: ${JSON.stringify(labelRes.body)}`);

  // Simulate carrier TRANSIT webhook advancing HELD → SHIPPED.
  const ts = new Date().toISOString();
  await pool.query(
    `UPDATE orders SET status = 'SHIPPED', shipped_at = $1, updated_at = $1 WHERE id = $2`,
    [ts, orderId]
  );

  const deliverRes = await request(app)
    .post(`/orders/${orderId}/deliver`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({});
  assert(deliverRes.status === 200, `deliver failed: ${JSON.stringify(deliverRes.body)}`);

  const confirmRes = await request(app)
    .post(`/orders/${orderId}/confirm`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({});
  assert(confirmRes.status === 200, `confirm failed: ${JSON.stringify(confirmRes.body)}`);
  return confirmRes.body;
}

// ── Tests ─────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n=== free shipping model tests ===');

  const mockServer = startMockListingService();
  const app = buildApp();
  await seedUsers();

  buyerToken  = makeJwt(testBuyerId,  'buyer');
  sellerToken = makeJwt(testSellerId, 'seller');
  adminToken  = makeJwt(testAdminId,  'admin');

  // ── 1. GET /orders/:id/seller-shipping-rates — happy path ──────────────

  await test('GET /orders/:id/seller-shipping-rates returns rates for HELD order', async () => {
    const orderId = await createHeldOrder(app);
    const res = await request(app)
      .get(`/orders/${orderId}/seller-shipping-rates`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assertEqual(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(Array.isArray(res.body.rates), 'rates must be an array');
    assert(res.body.rates.length > 0, 'rates must not be empty');
    const r = res.body.rates[0];
    assert(r.rate_id,       'rate must have rate_id');
    assert(r.carrier,       'rate must have carrier');
    assert(r.service,       'rate must have service');
    assert(r.price_cents > 0, 'rate must have positive price_cents');
    assert(r.rate_token,    'rate must have rate_token');
    assert(res.body.stub === true, 'stub flag must be true');
  });

  // ── 2. GET /orders/:id/seller-shipping-rates — buyer is forbidden ───────

  await test('GET /orders/:id/seller-shipping-rates returns 403 for buyer', async () => {
    const orderId = await createHeldOrder(app);
    const res = await request(app)
      .get(`/orders/${orderId}/seller-shipping-rates`)
      .set('Authorization', `Bearer ${buyerToken}`);
    assertEqual(res.status, 403, `expected 403, got ${res.status}`);
  });

  // ── 3. GET /orders/:id/seller-shipping-rates — requires HELD status ─────

  await test('GET /orders/:id/seller-shipping-rates returns 409 for non-HELD order', async () => {
    // Create order (CREATED, not yet captured)
    const createRes = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ listing_id: 1, shipping_address: VALID_BUYER_ADDR });
    assertEqual(createRes.status, 201);
    const orderId = createRes.body.id;

    const res = await request(app)
      .get(`/orders/${orderId}/seller-shipping-rates`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assertEqual(res.status, 409, `expected 409, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  // ── 4. POST /orders/:id/purchase-label — stores label_cost_cents ─────────

  await test('purchase-label stores label_cost_cents on order and keeps HELD status', async () => {
    const orderId = await createHeldOrder(app);
    const rate = await getFirstSellerRate(app, orderId);

    const res = await request(app)
      .post(`/orders/${orderId}/purchase-label`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ shippo_rate_id: rate.rate_id, rate_token: rate.rate_token });
    assertEqual(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    const order = res.body;
    // After label purchase, order returns to HELD (not LABELING)
    assertEqual(order.status, 'HELD', `expected HELD, got ${order.status}`);
    assert(order.label_cost_cents > 0, `label_cost_cents must be positive, got ${order.label_cost_cents}`);
    assertEqual(order.label_cost_cents, rate.price_cents,
      `label_cost_cents (${order.label_cost_cents}) must match selected rate (${rate.price_cents})`);
    assert(order.label_id, 'order must have a label_id');
    assert(order.tracking_number, 'order must have a tracking_number');
  });

  // ── 5. POST /orders/:id/ship-own-label — HELD → SHIPPED transition ───────

  await test('ship-own-label transitions order from HELD to SHIPPED', async () => {
    const orderId = await createHeldOrder(app);

    const res = await request(app)
      .post(`/orders/${orderId}/ship-own-label`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ carrier: 'USPS', tracking_number: 'TEST9400111899223461962345' });
    assertEqual(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    const order = res.body;
    assertEqual(order.status, 'SHIPPED', `expected SHIPPED, got ${order.status}`);
    assertEqual(order.carrier, 'USPS', 'carrier must be stored');
    assertEqual(order.tracking_number, 'TEST9400111899223461962345', 'tracking_number must be stored');
    // No label cost deducted for own-label
    assert(order.label_cost_cents == null || order.label_cost_cents === 0,
      `label_cost_cents must be null/0 for own-label, got ${order.label_cost_cents}`);
  });

  // ── 6. POST /orders/:id/ship-own-label — buyer is forbidden ─────────────

  await test('ship-own-label returns 403 for buyer', async () => {
    const orderId = await createHeldOrder(app);
    const res = await request(app)
      .post(`/orders/${orderId}/ship-own-label`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ carrier: 'USPS', tracking_number: '9400111899223461962345' });
    assertEqual(res.status, 403, `expected 403, got ${res.status}`);
  });

  // ── 7. POST /orders/:id/ship-own-label — requires carrier + tracking ─────

  await test('ship-own-label returns 422 when carrier is missing', async () => {
    const orderId = await createHeldOrder(app);
    const res = await request(app)
      .post(`/orders/${orderId}/ship-own-label`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ tracking_number: '9400111899223461962345' }); // no carrier
    assertEqual(res.status, 422, `expected 422, got ${res.status}`);
  });

  await test('ship-own-label returns 422 when tracking_number is missing', async () => {
    const orderId = await createHeldOrder(app);
    const res = await request(app)
      .post(`/orders/${orderId}/ship-own-label`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ carrier: 'USPS' }); // no tracking_number
    assertEqual(res.status, 422, `expected 422, got ${res.status}`);
  });

  // ── 8. Payout guard: label cost > seller_payout → 422 ────────────────────

  await test('purchase-label returns 422 when label cost exceeds seller payout', async () => {
    const orderId = await createHeldOrder(app);

    // Force seller_payout_cents to 1 cent so every label exceeds it.
    await pool.query(
      'UPDATE orders SET seller_payout_cents = 1 WHERE id = $1',
      [orderId]
    );

    const rate = await getFirstSellerRate(app, orderId);

    const res = await request(app)
      .post(`/orders/${orderId}/purchase-label`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ shippo_rate_id: rate.rate_id, rate_token: rate.rate_token });
    assertEqual(res.status, 422, `expected 422, got ${res.status}: ${JSON.stringify(res.body)}`);
    assertMatch(
      res.body.error,
      /costs more than your available sale proceeds|purchase shipping elsewhere/i,
      `unexpected error message: ${res.body.error}`
    );
  });

  // ── 9. Release with platform label: transfer = seller_payout - label_cost ──

  await test('release after platform label deducts label_cost_cents from Stripe transfer', async () => {
    const orderId = await createHeldOrder(app);

    // Get all rates to pick cheapest.
    const ratesRes = await request(app)
      .get(`/orders/${orderId}/seller-shipping-rates`)
      .set('Authorization', `Bearer ${sellerToken}`);
    const cheapestRate = ratesRes.body.rates.reduce(
      (min, r) => r.price_cents < min.price_cents ? r : min,
      ratesRes.body.rates[0]
    );

    // Get order to know seller_payout_cents before release.
    const orderBefore = (await request(app)
      .get(`/orders/${orderId}`)
      .set('Authorization', `Bearer ${sellerToken}`)
    ).body;
    const sellerPayout     = orderBefore.seller_payout_cents;
    const labelCost        = cheapestRate.price_cents;
    const expectedTransfer = sellerPayout - labelCost;

    // Purchase the cheapest label.
    const labelRes = await request(app)
      .post(`/orders/${orderId}/purchase-label`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ shippo_rate_id: cheapestRate.rate_id, rate_token: cheapestRate.rate_token });
    assertEqual(labelRes.status, 200, `purchase-label: ${JSON.stringify(labelRes.body)}`);
    assertEqual(labelRes.body.label_cost_cents, labelCost, 'label_cost_cents must match rate');

    // Platform label orders transition to SHIPPED via carrier TRANSIT webhook.
    // In tests, simulate this by advancing the order directly in the DB.
    const ts = new Date().toISOString();
    await pool.query(
      `UPDATE orders SET status = 'SHIPPED', shipped_at = $1, updated_at = $1 WHERE id = $2`,
      [ts, orderId]
    );

    // Snapshot transfer count before release.
    const transfersBefore = stripeClient._transfers ? stripeClient._transfers.length : 0;

    // Deliver and confirm.
    await request(app).post(`/orders/${orderId}/deliver`).set('Authorization', `Bearer ${adminToken}`).send({});
    const confirmRes = await request(app)
      .post(`/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({});
    assertEqual(confirmRes.status, 200, `confirm: ${JSON.stringify(confirmRes.body)}`);
    assertEqual(confirmRes.body.status, 'RELEASED', 'expected RELEASED');

    // Verify the stub recorded the correct transfer amount.
    if (stripeClient._transfers) {
      const newTransfers = stripeClient._transfers.slice(transfersBefore);
      assert(newTransfers.length > 0, 'a Stripe transfer must have been created');
      const lastTransfer = newTransfers[newTransfers.length - 1];
      assertEqual(lastTransfer.amountCents, expectedTransfer,
        `transfer ${lastTransfer.amountCents} must equal seller_payout(${sellerPayout}) - label_cost(${labelCost}) = ${expectedTransfer}`);
    }
  });

  // ── 10. Release with own label: full seller_payout transferred ────────────

  await test('release after own-label transfers full seller_payout (no label deduction)', async () => {
    const orderId = await createHeldOrder(app);

    // Get seller_payout before shipping.
    const orderBefore = (await request(app)
      .get(`/orders/${orderId}`)
      .set('Authorization', `Bearer ${sellerToken}`)
    ).body;
    const sellerPayout = orderBefore.seller_payout_cents;

    const transfersBefore = stripeClient._transfers ? stripeClient._transfers.length : 0;

    // Ship with own label.
    await request(app)
      .post(`/orders/${orderId}/ship-own-label`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ carrier: 'FedEx', tracking_number: 'TESTFEDEX123456789' });

    // Deliver → confirm.
    await request(app).post(`/orders/${orderId}/deliver`).set('Authorization', `Bearer ${adminToken}`).send({});
    const confirmRes = await request(app)
      .post(`/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({});
    assertEqual(confirmRes.status, 200, `confirm: ${JSON.stringify(confirmRes.body)}`);
    assertEqual(confirmRes.body.status, 'RELEASED');

    // Verify full payout transferred (label_cost_cents is null → deduction = 0).
    if (stripeClient._transfers) {
      const newTransfers = stripeClient._transfers.slice(transfersBefore);
      assert(newTransfers.length > 0, 'a Stripe transfer must have been created');
      const lastTransfer = newTransfers[newTransfers.length - 1];
      assertEqual(lastTransfer.amountCents, sellerPayout,
        `transfer must equal full seller_payout ${sellerPayout} when no platform label was purchased`);
    }
  });

  // ── 11. Historical orders: release unaffected by null label_cost_cents ────

  await test('historical order (label_cost_cents NULL) releases at full seller_payout', async () => {
    const orderId = await createHeldOrder(app);

    // Simulate historical order: ensure label_cost_cents is NULL.
    await pool.query('UPDATE orders SET label_cost_cents = NULL WHERE id = $1', [orderId]);

    const orderBefore = (await request(app)
      .get(`/orders/${orderId}`)
      .set('Authorization', `Bearer ${sellerToken}`)
    ).body;
    const sellerPayout = orderBefore.seller_payout_cents;

    const transfersBefore = stripeClient._transfers ? stripeClient._transfers.length : 0;

    // Ship with own label (no label purchase, so label_cost stays NULL).
    await request(app).post(`/orders/${orderId}/ship-own-label`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ carrier: 'UPS', tracking_number: 'TESTUPS9999999999' });
    await request(app).post(`/orders/${orderId}/deliver`).set('Authorization', `Bearer ${adminToken}`).send({});
    const confirmRes = await request(app)
      .post(`/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({});
    assertEqual(confirmRes.status, 200);
    assertEqual(confirmRes.body.status, 'RELEASED');

    // Verify full payout was transferred (null label_cost → 0 deduction).
    if (stripeClient._transfers) {
      const newTransfers = stripeClient._transfers.slice(transfersBefore);
      assert(newTransfers.length > 0, 'a Stripe transfer must have been created');
      const lastTransfer = newTransfers[newTransfers.length - 1];
      assertEqual(lastTransfer.amountCents, sellerPayout,
        `transfer must equal full seller_payout for historical order (label_cost_cents was NULL)`);
    }

    // Also verify label_cost_cents remains NULL in DB (not overwritten).
    const { rows: [row] } = await pool.query(
      'SELECT label_cost_cents FROM orders WHERE id = $1', [orderId]
    );
    assert(row.label_cost_cents == null, 'label_cost_cents must remain NULL for historical order');
  });

  // ── Cleanup ────────────────────────────────────────────────────────────

  mockServer.close();
  await pool.end();

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();

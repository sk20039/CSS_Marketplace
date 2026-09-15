// tests/shipping_phase3.test.js
// Phase 3 shipping label purchase tests.
//
// Covers: ship_by_date at HELD, label purchase happy path, idempotency,
// concurrency guard, ship-requires-label enforcement, label_url redaction,
// ambiguous/definitive failure distinction, LABELING recovery.
//
// Run: node tests/shipping_phase3.test.js
// Exit code 0 = all passed, 1 = any failed.
//
// Prerequisites:
//   1. DATABASE_URL_TEST set in .env or environment, pointing to escrow_db_test.
//   2. Migrations applied: DATABASE_URL=<test_url> node_modules/.bin/node-pg-migrate -m migrations up
//
// Runs entirely in stub mode (no SHIPPO_API_KEY or STRIPE_SECRET_KEY required).
'use strict';

// ---- Set DATABASE_URL to test DB BEFORE any src/ module load ----
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST ||
  'postgres://escrow_user:escrow_pass@127.0.0.1:5432/escrow_db_test';
delete process.env.STRIPE_SECRET_KEY;
delete process.env.SHIPPO_API_KEY;          // force Shippo stub mode
delete process.env.NODE_ENV;               // not production → stub allowed
process.env.LISTING_SERVICE_URL     = 'http://127.0.0.1:19877';
process.env.FRONTEND_ORIGIN         = 'http://localhost:3003';
process.env.JWT_SECRET              = 'test-jwt-secret-phase3-32chars!!';
process.env.SHIPPING_HMAC_SECRET    = 'test-shipping-hmac-phase3-32chars!';
process.env.INTERNAL_SERVICE_SECRET = 'test-internal-secret-phase3-32!!';

const http    = require('http');
const request = require('supertest');
const { buildApp } = require('../src/app');
const pool    = require('../src/db');
const {
  purchaseLabelForOrder,
  finalizeLabeled,
  revertLabelPurchase,
  getOrderWithTimeline,
} = require('../src/orderService');
const { runRecovery } = require('../src/recoveryService');

// ── Test harness ─────────────────────────────────────────────────────────────

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
  if (!re.test(str)) throw new Error(msg || `Expected /${re.source}/ to match: ${JSON.stringify(str)}`);
}

// ── Listing-service mock ──────────────────────────────────────────────────────

let mockListingData = {
  id: 1, seller_id: 1, title: 'Test Cricket Bat', price_cents: 5000,
  status: 'active',
  weight_oz: 48, pkg_length_in: 34, pkg_width_in: 6, pkg_height_in: 4,
};

function startMockListingService() {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (/\/listings\/\d+$/.test(req.url) && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify(mockListingData));
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

// ── DB helpers ────────────────────────────────────────────────────────────────

let testSellerId;
let testBuyerId;
let sellerToken;
let buyerToken;
let adminToken;
let adminId;

const SELLER_SHIP_FROM = {
  name: 'Phase3 Seller', line1: '100 Seller Ln', city: 'Houston',
  state: 'TX', zip: '77001', phone: '5551234567',
};

const BUYER_ADDR = {
  name: 'Phase3 Buyer', line1: '200 Buyer Rd', city: 'Austin',
  state: 'TX', zip: '78701', phone: '5559876543',
};

async function seedDB() {
  await pool.query('DELETE FROM reviews');
  await pool.query('DELETE FROM messages');
  await pool.query('DELETE FROM order_events');
  await pool.query('DELETE FROM orders');
  await pool.query('DELETE FROM listings');
  await pool.query('DELETE FROM users');

  const { rows: [seller] } = await pool.query(
    `INSERT INTO users (name, email, role, ship_from_address)
     OVERRIDING SYSTEM VALUE
     VALUES ('Phase3 Seller', 'p3seller@test.test', 'seller', $1)
     ON CONFLICT (email) DO UPDATE SET ship_from_address = $1
     RETURNING id`,
    [JSON.stringify(SELLER_SHIP_FROM)]
  );
  testSellerId = Number(seller.id);

  const { rows: [buyer] } = await pool.query(
    `INSERT INTO users (name, email, role)
     OVERRIDING SYSTEM VALUE
     VALUES ('Phase3 Buyer', 'p3buyer@test.test', 'buyer')
     ON CONFLICT (email) DO UPDATE SET role = 'buyer'
     RETURNING id`
  );
  testBuyerId = Number(buyer.id);

  const { rows: [admin] } = await pool.query(
    `INSERT INTO users (name, email, role)
     OVERRIDING SYSTEM VALUE
     VALUES ('Phase3 Admin', 'p3admin@test.test', 'admin')
     ON CONFLICT (email) DO UPDATE SET role = 'admin'
     RETURNING id`
  );
  adminId = Number(admin.id);

  await pool.query(
    `INSERT INTO listings (id, seller_id, title, price_cents)
     OVERRIDING SYSTEM VALUE
     VALUES (1, $1, 'Test Cricket Bat', 5000)
     ON CONFLICT (id) DO UPDATE SET seller_id = $1, price_cents = 5000`,
    [testSellerId]
  );

  mockListingData.seller_id = testSellerId;
}

function makeJwt(userId, role) {
  const jwt = require('jsonwebtoken');
  return jwt.sign(
    { sub: userId, email: `${role}@test.test`, role },
    process.env.JWT_SECRET || 'change-me',
    { expiresIn: '1h' }
  );
}

// Helper: create a fresh CREATED order and return its data.
// Shipping is now free for buyers — no rate selection at order creation.
async function createOrderViaApi(app) {
  const orderRes = await request(app)
    .post('/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({
      listing_id:       1,
      shipping_address: BUYER_ADDR,
    });
  assert(orderRes.status === 201, `createOrder failed: ${JSON.stringify(orderRes.body)}`);
  return { order: orderRes.body };
}

// Helper: fetch a rate for a HELD order and return { shippo_rate_id, rate_token }.
async function getSellerRate(app, orderId) {
  const res = await request(app)
    .get(`/orders/${orderId}/seller-shipping-rates`)
    .set('Authorization', `Bearer ${sellerToken}`);
  assert(res.status === 200, `seller-shipping-rates failed: ${JSON.stringify(res.body)}`);
  const rate = res.body.rates[0];
  assert(rate, 'must have at least one rate');
  return { shippo_rate_id: rate.rate_id, rate_token: rate.rate_token };
}

// Helper: purchase a label (GET rates then POST purchase-label).
async function purchaseLabelViaApi(app, orderId) {
  const body = await getSellerRate(app, orderId);
  const res = await request(app)
    .post(`/orders/${orderId}/purchase-label`)
    .set('Authorization', `Bearer ${sellerToken}`)
    .send(body);
  assertEqual(res.status, 200, `purchaseLabelViaApi failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

// Helper: capture an order (CREATED → HELD) via API.
async function captureOrder(app, orderId) {
  const res = await request(app)
    .post(`/orders/${orderId}/capture`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send();
  assert(res.status === 200, `capture failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

// Helper: create and capture an order, returning the HELD order.
async function createHeldOrder(app) {
  const { order } = await createOrderViaApi(app);
  return captureOrder(app, order.id);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n=== escrow-service shipping Phase 3 tests ===\n');

  const mockServer = startMockListingService();
  const app = buildApp();
  await seedDB();

  sellerToken = makeJwt(testSellerId, 'seller');
  buyerToken  = makeJwt(testBuyerId,  'buyer');
  adminToken  = makeJwt(adminId,      'admin');

  // ── 1. ship_by_date set at HELD ───────────────────────────────────────────

  await test('ship_by_date is set (3 business days out) when order moves to HELD', async () => {
    const held = await createHeldOrder(app);
    assertEqual(held.status, 'HELD', 'order must be HELD');
    assert(held.ship_by_date != null, 'ship_by_date must be set');

    const before = new Date(held.created_at);
    const shipBy = new Date(held.ship_by_date);
    // ship_by_date should be at least 3 calendar days in the future.
    const diffDays = (shipBy - before) / (1000 * 60 * 60 * 24);
    assert(diffDays >= 3, `ship_by_date should be ≥3 days out (got ${diffDays.toFixed(1)} days)`);
    // And at most 7 days (3 business days cannot span more than 7 calendar days).
    assert(diffDays <= 7, `ship_by_date should be ≤7 days out (got ${diffDays.toFixed(1)} days)`);
  });

  // ── 2. purchase-label — happy path ───────────────────────────────────────

  await test('POST /orders/:id/purchase-label returns HELD order with label fields', async () => {
    const held = await createHeldOrder(app);
    const o = await purchaseLabelViaApi(app, held.id);
    assertEqual(o.status, 'HELD', 'order must remain HELD after label purchase');
    assert(o.label_id,        'label_id must be set');
    assert(o.label_url,       'label_url must be set');
    assert(o.tracking_number, 'tracking_number must be set');
    assert(o.carrier,         'carrier must be set');
    assert(o.carrier_service, 'carrier_service must be set');
    assert(Number.isInteger(o.label_cost_cents) && o.label_cost_cents > 0, 'label_cost_cents must be a positive integer');
    assertEqual(o.shipping_cents, 0, 'shipping_cents must be 0 (free shipping for buyers)');
    // LABELING event should be in timeline.
    const labelEvent = (o.events || []).find(e => e.event_type === 'LABEL_PURCHASED');
    assert(labelEvent, 'LABEL_PURCHASED event must be recorded');
  });

  // ── 3. purchase-label — forbidden for buyer ──────────────────────────────

  await test('POST /orders/:id/purchase-label returns 403 for buyer', async () => {
    const held = await createHeldOrder(app);
    const res = await request(app)
      .post(`/orders/${held.id}/purchase-label`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ shippo_rate_id: 'stub_rate_usps_first_class', rate_token: 'dummy' });
    assertEqual(res.status, 403, `expected 403, got ${res.status}`);
  });

  // ── 4. purchase-label — requires auth ────────────────────────────────────

  await test('POST /orders/:id/purchase-label returns 401 without auth', async () => {
    const held = await createHeldOrder(app);
    const res = await request(app)
      .post(`/orders/${held.id}/purchase-label`)
      .send({ shippo_rate_id: 'stub_rate_usps_first_class', rate_token: 'dummy' });
    assertEqual(res.status, 401, `expected 401, got ${res.status}`);
  });

  // ── 5. purchase-label — idempotent (second call returns existing label) ──

  await test('POST /orders/:id/purchase-label is idempotent — second call returns existing label', async () => {
    const held = await createHeldOrder(app);

    // First call: fetch real rate and purchase.
    const body = await getSellerRate(app, held.id);
    const res1 = await request(app)
      .post(`/orders/${held.id}/purchase-label`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send(body);
    assertEqual(res1.status, 200, `first call failed: ${JSON.stringify(res1.body)}`);

    // Second call: label_id already set — idempotent short-circuit (body not re-validated).
    const res2 = await request(app)
      .post(`/orders/${held.id}/purchase-label`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send(body);
    assertEqual(res2.status, 200, `second call failed: ${JSON.stringify(res2.body)}`);

    // Both calls must return the same label_id.
    assertEqual(res2.body.label_id, res1.body.label_id, 'label_id must be identical on second call');
    // Only one LABEL_PURCHASED event should exist.
    const events = res2.body.events.filter(e => e.event_type === 'LABEL_PURCHASED');
    assertEqual(events.length, 1, `expected exactly 1 LABEL_PURCHASED event, got ${events.length}`);
  });

  // ── 6. purchase-label — 409 when order is in LABELING state ─────────────

  await test('POST /orders/:id/purchase-label returns 409 when order is already LABELING', async () => {
    const held = await createHeldOrder(app);

    // Manually force the order into LABELING (simulates in-flight purchase).
    await pool.query(
      `UPDATE orders SET status = 'LABELING', transition_started_at = NOW() WHERE id = $1`,
      [held.id]
    );

    const res = await request(app)
      .post(`/orders/${held.id}/purchase-label`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ shippo_rate_id: 'stub_rate_usps_first_class', rate_token: 'dummy' });
    assertEqual(res.status, 409, `expected 409, got ${res.status}: ${JSON.stringify(res.body)}`);
    assertMatch(res.body.error, /in progress|recovery/i, `unexpected error: ${res.body.error}`);

    // Restore to HELD for cleanup.
    await pool.query(`UPDATE orders SET status = 'HELD', transition_started_at = NULL WHERE id = $1`, [held.id]);
  });

  // ── 7. purchase-label — 409 when order is not HELD ───────────────────────

  await test('POST /orders/:id/purchase-label returns 409 when order is not HELD', async () => {
    const { order } = await createOrderViaApi(app);
    // Order is CREATED, not HELD.
    const res = await request(app)
      .post(`/orders/${order.id}/purchase-label`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ shippo_rate_id: 'stub_rate_usps_first_class', rate_token: 'dummy' });
    assertEqual(res.status, 409, `expected 409, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  // ── 8. ship — succeeds without platform label (own-label / no-label flow) ──

  await test('POST /orders/:id/ship succeeds when no platform label (label_id is null)', async () => {
    const held = await createHeldOrder(app);
    // Do not purchase label — manual ship is allowed in free-shipping model
    // when seller does not use a Shippo label (e.g. own carrier).
    const res = await request(app)
      .post(`/orders/${held.id}/ship`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send();
    assertEqual(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assertEqual(res.body.status, 'SHIPPED', 'order must be SHIPPED');
  });

  // ── 9. ship — 409 when platform label exists (carrier webhook handles it) ──

  await test('POST /orders/:id/ship returns 409 when platform label exists', async () => {
    const held = await createHeldOrder(app);

    // Purchase label — order stays HELD with label data.
    const labelRes = await purchaseLabelViaApi(app, held.id);
    assertEqual(labelRes.status, 'HELD', `label purchase must leave order HELD`);

    // Manual ship is blocked; carrier TRANSIT webhook handles transition.
    const shipRes = await request(app)
      .post(`/orders/${held.id}/ship`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send();
    assertEqual(shipRes.status, 409, `expected 409, got ${shipRes.status}: ${JSON.stringify(shipRes.body)}`);
    assertMatch(shipRes.body.error, /platform shipping label|carrier webhook|TRANSIT/i,
      `unexpected error: ${shipRes.body.error}`);
  });

  // ── 10. label_url redaction — buyer cannot see label_url ─────────────────

  await test('GET /orders/:id hides label_url from buyer', async () => {
    const held = await createHeldOrder(app);

    await purchaseLabelViaApi(app, held.id);

    // Seller can see label_url.
    const sellerView = await request(app)
      .get(`/orders/${held.id}`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assertEqual(sellerView.status, 200);
    assert(sellerView.body.label_url != null, 'seller must see label_url');

    // Buyer cannot see label_url.
    const buyerView = await request(app)
      .get(`/orders/${held.id}`)
      .set('Authorization', `Bearer ${buyerToken}`);
    assertEqual(buyerView.status, 200);
    assert(buyerView.body.label_url === undefined, 'buyer must not see label_url');

    // Admin can see label_url.
    const adminView = await request(app)
      .get(`/orders/${held.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assertEqual(adminView.status, 200);
    assert(adminView.body.label_url != null, 'admin must see label_url');
  });

  // ── 11. label_url redaction in order list ────────────────────────────────

  await test('GET /orders list hides label_url from buyer', async () => {
    const held = await createHeldOrder(app);
    await purchaseLabelViaApi(app, held.id);

    const res = await request(app)
      .get('/orders')
      .set('Authorization', `Bearer ${buyerToken}`);
    assertEqual(res.status, 200);
    const o = res.body.find(x => x.id === held.id);
    assert(o, 'order must be in list');
    assert(o.label_url === undefined, 'buyer must not see label_url in list');
  });

  // ── 12. definitive failure: revert LABELING → HELD ───────────────────────
  // Simulate a definitive Shippo failure by manually setting LABELING and
  // then verifying that recovery (stub mode = no transaction) reverts to HELD.
  // This also tests the ambiguous→revert-after-no-transaction recovery path.

  await test('Recovery reverts LABELING to HELD when Shippo returns no transaction (stub mode)', async () => {
    const held = await createHeldOrder(app);

    // Simulate: order entered LABELING but crashed before Shippo call completed.
    // In stub mode, findTransactionByRate returns null (no persistent store).
    await pool.query(
      `UPDATE orders
       SET status = 'LABELING', transition_started_at = NOW() - INTERVAL '15 minutes',
           prior_status = 'HELD'
       WHERE id = $1`,
      [held.id]
    );

    const result = await runRecovery();
    assert(!result.skipped, 'recovery must not be skipped');

    // The order should be reverted to HELD.
    const recovered = await getOrderWithTimeline(held.id);
    assertEqual(recovered.status, 'HELD', `order must be HELD after recovery, got ${recovered.status}`);
    assert(recovered.label_id == null, 'label_id must still be null after revert');

    // A revert event must be recorded.
    const revertEvent = (recovered.events || []).find(e => e.event_type === 'LABEL_PURCHASE_REVERTED');
    assert(revertEvent, 'LABEL_PURCHASE_REVERTED event must be recorded');
  });

  // ── 13. Recovery idempotency: two concurrent sweeps for LABELING ─────────
  // The recovery_claimed_at UPDATE is atomic — only one worker claims the order.

  await test('Two concurrent recovery sweeps claim LABELING order only once', async () => {
    const held = await createHeldOrder(app);

    await pool.query(
      `UPDATE orders
       SET status = 'LABELING', transition_started_at = NOW() - INTERVAL '15 minutes',
           prior_status = 'HELD'
       WHERE id = $1`,
      [held.id]
    );

    // Run two recovery sweeps "concurrently" (sequential in test, but both
    // see the same DB state since no await in between the query calls).
    const [r1, r2] = await Promise.all([runRecovery(), runRecovery()]);

    // One sweep may skip because it sees recoveryInProgress = true.
    // Or both run but only one claims the order.
    const totalRecovered = (r1.skipped ? 0 : r1.recoveredOrderIds.length) +
                           (r2.skipped ? 0 : r2.recoveredOrderIds.length);
    // The order should appear in exactly one sweep's result.
    assert(totalRecovered <= 1, `order must be claimed by at most one recovery sweep (got ${totalRecovered})`);

    // Regardless, the order must end up in HELD.
    const recovered = await getOrderWithTimeline(held.id);
    assertEqual(recovered.status, 'HELD', `order must be HELD after recovery, got ${recovered.status}`);
  });

  // ── 14. LABELING order with label already set is not double-finalized ─────
  // If somehow an order has status=LABELING AND label_id set (crash between
  // Shippo success and our finalize commit), recovery must complete the finalize.
  // In this test we inject that state and verify finalizeLabeled is safe to call.

  await test('finalizeLabeled with WHERE status=LABELING is a no-op if already HELD', async () => {
    const held = await createHeldOrder(app);

    // Manually purchase label, leaving order in HELD with label_id set.
    await pool.query(
      `UPDATE orders
       SET label_id = 'stub_test_label', label_url = 'https://example.com/test.pdf',
           label_cost_cents = $1, tracking_number = 'STUBTEST', carrier = 'USPS',
           carrier_service = 'Priority Mail'
       WHERE id = $2`,
      [held.shipping_cents, held.id]
    );

    // Simulate the finalizeLabeled being called again while order is already HELD.
    // (status != LABELING, so WHERE clause matches 0 rows → FinalizeConflictError)
    const { FinalizeConflictError } = require('../src/orderService');
    let threw = false;
    try {
      await finalizeLabeled({ id: held.id, shipping_cents: held.shipping_cents }, {
        label_id: 'stub_test_label_duplicate',
        label_url: 'https://example.com/dup.pdf',
        tracking_number: 'STUBDUP',
        carrier: 'USPS',
        carrier_service: 'Priority Mail',
      });
    } catch (err) {
      threw = true;
      assert(err instanceof FinalizeConflictError, `expected FinalizeConflictError, got: ${err.message}`);
    }
    assert(threw, 'finalizeLabeled must throw FinalizeConflictError when order is not in LABELING');

    // Original label_id must be unchanged.
    const { rows: [row] } = await pool.query('SELECT label_id FROM orders WHERE id = $1', [held.id]);
    assertEqual(row.label_id, 'stub_test_label', 'original label_id must be preserved');
  });

  // ── 15. revertLabelPurchase is guarded by label_id IS NULL ───────────────

  await test('revertLabelPurchase does not revert if label_id is already set', async () => {
    const held = await createHeldOrder(app);

    // Set the order to LABELING with a label_id already written (edge case).
    await pool.query(
      `UPDATE orders
       SET status = 'LABELING', label_id = 'existing_label', prior_status = 'HELD',
           transition_started_at = NOW()
       WHERE id = $1`,
      [held.id]
    );

    // revertLabelPurchase has AND label_id IS NULL, so it should match 0 rows.
    await revertLabelPurchase(held.id, { reason: 'test revert with label_id set' });

    // Order must still be LABELING (revert was a no-op due to label_id guard).
    const { rows: [row] } = await pool.query('SELECT status FROM orders WHERE id = $1', [held.id]);
    assertEqual(row.status, 'LABELING', 'order must remain LABELING when label_id is set');

    // Restore to HELD for test cleanup.
    await pool.query(
      `UPDATE orders SET status = 'HELD', label_id = NULL, transition_started_at = NULL WHERE id = $1`,
      [held.id]
    );
  });

  // ── 16. Admin can also purchase label ────────────────────────────────────

  await test('POST /orders/:id/purchase-label succeeds for admin', async () => {
    const held = await createHeldOrder(app);
    const body = await getSellerRate(app, held.id);
    const res = await request(app)
      .post(`/orders/${held.id}/purchase-label`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body);
    assertEqual(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.label_id, 'label_id must be set after admin purchase');
  });

  // ── 17. carrier and carrier_service are null at order creation ──────────────
  // (In the free-shipping model, carrier is not set until label purchase)

  await test('carrier and carrier_service are null at order creation (set at label purchase)', async () => {
    const { order } = await createOrderViaApi(app);
    assert(order.carrier == null, `carrier must be null at order creation (got ${JSON.stringify(order.carrier)})`);
    assert(order.carrier_service == null, `carrier_service must be null at order creation (got ${JSON.stringify(order.carrier_service)})`);
  });

  // ── 18. finalizeLabeled falls back to rate carrier when labelData has null values ─
  // (carrier is stored on the order by purchaseLabelForOrder before finalizeLabeled)

  await test('finalizeLabeled falls back to rate carrier when labelData carrier fields are null', async () => {
    const held = await createHeldOrder(app);

    // Carrier is null at order creation in the free-shipping model.
    // purchaseLabelForOrder stores shippo_rate_id before LABELING so recovery can re-derive carrier.
    // Manually set carrier/carrier_service to simulate what purchaseLabelForOrder would do.
    const FALLBACK_CARRIER = 'USPS';
    const FALLBACK_SERVICE = 'Priority Mail';
    await pool.query(
      `UPDATE orders SET status = 'LABELING', prior_status = 'HELD',
       carrier = $1, carrier_service = $2, transition_started_at = NOW() WHERE id = $3`,
      [FALLBACK_CARRIER, FALLBACK_SERVICE, held.id]
    );

    // Call finalizeLabeled with null carrier/service (simulates USPS Ground Advantage transaction).
    const result = await finalizeLabeled(
      { id: held.id, label_cost_cents: 895, carrier: FALLBACK_CARRIER, carrier_service: FALLBACK_SERVICE },
      {
        label_id:        'test_fallback_label_' + held.id,
        label_url:       'https://example.com/fallback.pdf',
        tracking_number: 'STUB_FALLBACK_' + held.id,
        carrier:         null,
        carrier_service: null,
      },
      895  // labelCostCents
    );

    assert(result.carrier != null, `carrier must not be null after finalize`);
    assertEqual(result.carrier, FALLBACK_CARRIER, 'carrier must fall back to the order-stored value');
    assert(result.carrier_service != null, 'carrier_service must not be null after finalize');
    assertEqual(result.carrier_service, FALLBACK_SERVICE, 'carrier_service must fall back to the order-stored value');
  });

  // ── 19. seller sees shipping_address in GET /orders/:id ──────────────────

  await test('GET /orders/:id includes shipping_address for seller', async () => {
    const held = await createHeldOrder(app);
    const res = await request(app)
      .get(`/orders/${held.id}`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assertEqual(res.status, 200, `expected 200, got ${res.status}`);
    assert(res.body.shipping_address != null, 'seller must see shipping_address');
    assertEqual(res.body.shipping_address.city, BUYER_ADDR.city,
      `shipping_address.city must be '${BUYER_ADDR.city}', got '${res.body.shipping_address?.city}'`);
  });

  // ── 20. buyer does not see shipping_address in GET /orders/:id ───────────

  await test('GET /orders/:id does not include shipping_address for buyer', async () => {
    const held = await createHeldOrder(app);
    const res = await request(app)
      .get(`/orders/${held.id}`)
      .set('Authorization', `Bearer ${buyerToken}`);
    assertEqual(res.status, 200, `expected 200, got ${res.status}`);
    assert(res.body.shipping_address == null || !('shipping_address' in res.body),
      'buyer must not see shipping_address');
  });

  // ── Cleanup ────────────────────────────────────────────────────────────────

  mockServer.close();
  await pool.end();

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();

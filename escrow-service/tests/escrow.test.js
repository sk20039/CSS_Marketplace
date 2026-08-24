// tests/escrow.test.js
//
// Standalone integration test — no test runner required.
// Run: node tests/escrow.test.js
// Exit code 0 = all passed, 1 = any failed.
//
// Full order lifecycle tests via HTTP API against a real PostgreSQL DB.
// Uses escrow_db_test; stub Stripe client only (no real charges).
//
// Prerequisites:
//   1. DATABASE_URL_TEST set (in .env or environment).
//   2. Migrations applied to escrow_db_test:
//        DATABASE_URL=<test_url> node_modules/.bin/node-pg-migrate -m migrations up
//
// Coverage:
//   - Order creation (with mock listing-service)
//   - Capture → HELD
//   - Ship → SHIPPED, Deliver → DELIVERED
//   - Buyer confirm → RELEASED (triggeredBy=buyer_confirm)
//   - Automatic release via /admin/run-release-check
//   - Dispute + admin resolve (refund)
//   - Dispute + admin resolve (release)
//   - Buyer cancellation + listing reactivation attempt
//   - Concurrent capture conflict (409)
//   - Messages and reviews endpoints

'use strict';

// ---- Must be set before any src/ module load ----
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'change-me'; // explicit: removed || '' fallback in requireAuth
delete process.env.STRIPE_SECRET_KEY; // force stub mode

// Start mock listing server before loading src/ (LISTING_SERVICE_URL must be set before require)
const http = require('http');
const jwt  = require('jsonwebtoken');

// ---------------------------------------------------------------------------
// Mock listing-service
// ---------------------------------------------------------------------------

let mockListing  = null; // set during setup after we know the seller ID
let mockMarkSoldOk   = true;
let mockMarkActiveOk = true;

const mockListingServer = http.createServer((req, res) => {
  if (req.method === 'GET' && /^\/listings\/\d+$/.test(req.url)) {
    if (!mockListing) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mockListing));
    }
  } else if (req.method === 'PATCH' && /^\/listings\/\d+\/mark-sold$/.test(req.url)) {
    res.writeHead(mockMarkSoldOk ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(mockMarkSoldOk ? { ok: true } : { error: 'listing-service down' }));
  } else if (req.method === 'PATCH' && /^\/listings\/\d+\/mark-active$/.test(req.url)) {
    res.writeHead(mockMarkActiveOk ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(mockMarkActiveOk ? { ok: true } : { error: 'listing-service down' }));
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function request(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let respBody;
        try { respBody = JSON.parse(data); } catch { respBody = data; }
        resolve({ status: res.statusCode, body: respBody });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const get  = (s, p, t)    => request(s, 'GET',  p, t, null);
const post = (s, p, t, b) => request(s, 'POST', p, t, b);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let pool, appServer;
let buyerId, sellerId, adminId;
let buyerToken, sellerToken, adminToken;
const LISTING_ID = 999; // mock listing ID
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function setup() {
  // Start mock listing server and set LISTING_SERVICE_URL
  await new Promise((resolve) => mockListingServer.listen(0, '127.0.0.1', resolve));
  const mockPort = mockListingServer.address().port;
  process.env.LISTING_SERVICE_URL = `http://127.0.0.1:${mockPort}`;

  // NOW load src/ modules (LISTING_SERVICE_URL is set)
  pool = require('../src/db');
  const { buildApp } = require('../src/app');

  // Truncate and seed
  await pool.query(`
    TRUNCATE reviews, messages, order_events, orders, listings, users
    RESTART IDENTITY CASCADE
  `);

  const { rows: [buyer] } = await pool.query(
    `INSERT INTO users (name, email, role) VALUES ('Test Buyer', 'buyer@escrow.test', 'buyer') RETURNING id`
  );
  const { rows: [seller] } = await pool.query(
    `INSERT INTO users (name, email, role, stripe_account_id)
     VALUES ('Test Seller', 'seller@escrow.test', 'seller', 'acct_stub_test_seller') RETURNING id`
  );
  const { rows: [admin] } = await pool.query(
    `INSERT INTO users (name, email, role) VALUES ('Test Admin', 'admin@escrow.test', 'admin') RETURNING id`
  );

  buyerId  = buyer.id;
  sellerId = seller.id;
  adminId  = admin.id;

  // JWT tokens
  buyerToken  = jwt.sign({ sub: String(buyerId),  email: 'buyer@escrow.test',  role: 'buyer'  }, JWT_SECRET);
  sellerToken = jwt.sign({ sub: String(sellerId), email: 'seller@escrow.test', role: 'seller' }, JWT_SECRET);
  adminToken  = jwt.sign({ sub: String(adminId),  email: 'admin@escrow.test',  role: 'admin'  }, JWT_SECRET);

  // Configure mock listing (seller is our seeded seller)
  mockListing = {
    id: LISTING_ID,
    seller_id: sellerId,
    title: 'Test Cricket Bat',
    price_cents: 9999,
    status: 'active',
  };
  mockMarkSoldOk   = true;
  mockMarkActiveOk = true;

  // Start app server
  const app = buildApp();
  appServer = http.createServer(app);
  await new Promise((resolve) => appServer.listen(0, '127.0.0.1', resolve));
}

async function teardown() {
  await new Promise((resolve) => appServer.close(resolve));
  await new Promise((resolve) => mockListingServer.close(resolve));
  await pool.end();
}

// ---------------------------------------------------------------------------
// Helpers: drive an order through states
// ---------------------------------------------------------------------------

async function createOrder() {
  const res = await post(appServer, '/orders', buyerToken, { listing_id: LISTING_ID });
  assertEqual(res.status, 201, `createOrder failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function captureOrder(orderId) {
  const res = await post(appServer, `/orders/${orderId}/capture`, buyerToken);
  assertEqual(res.status, 200, `captureOrder failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function shipOrder(orderId) {
  const res = await post(appServer, `/orders/${orderId}/ship`, sellerToken);
  assertEqual(res.status, 200, `shipOrder failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function deliverOrder(orderId) {
  const res = await post(appServer, `/orders/${orderId}/deliver`, sellerToken);
  assertEqual(res.status, 200, `deliverOrder failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function confirmOrder(orderId) {
  const res = await post(appServer, `/orders/${orderId}/confirm`, buyerToken);
  assertEqual(res.status, 200, `confirmOrder failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function disputeOrder(orderId, reason) {
  const res = await post(appServer, `/orders/${orderId}/dispute`, buyerToken, { reason });
  assertEqual(res.status, 200, `disputeOrder failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function cancelOrder(orderId) {
  const res = await post(appServer, `/orders/${orderId}/cancel`, buyerToken, { reason: 'changed mind' });
  assertEqual(res.status, 200, `cancelOrder failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function resolveDispute(orderId, action) {
  const res = await post(appServer, `/admin/orders/${orderId}/resolve`, adminToken, { action });
  assertEqual(res.status, 200, `resolveDispute failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function driveToHeld() {
  const order = await createOrder();
  return captureOrder(order.id);
}

async function driveToDelivered() {
  const held = await driveToHeld();
  await shipOrder(held.id);
  return deliverOrder(held.id);
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

async function runOrderCreationTests() {
  console.log('\nOrder creation');

  await test('POST /orders creates order in CREATED status with correct amounts', async () => {
    const order = await createOrder();
    assertEqual(order.status, 'CREATED', 'status must be CREATED');
    assertEqual(order.amount_cents, 9999, 'amount_cents must match listing price');
    assert(order.platform_fee_cents > 0, 'platform_fee_cents must be set');
    assertEqual(order.platform_fee_cents + order.seller_payout_cents, 9999, 'fee + payout must equal amount');
    assert(order.stripe_payment_intent_id, 'stripe_payment_intent_id must be set');
    assertEqual(order.buyer_id, buyerId, 'buyer_id must match token user');
    assertEqual(order.seller_id, sellerId, 'seller_id must match listing seller');
    assert(Array.isArray(order.events), 'events array must be present');
    assert(order.events.some((e) => e.event_type === 'ORDER_CREATED'), 'ORDER_CREATED event must be in timeline');
  });

  await test('POST /orders rejects unauthenticated request with 401', async () => {
    const res = await post(appServer, '/orders', null, { listing_id: LISTING_ID });
    assertEqual(res.status, 401, `expected 401, got ${res.status}`);
  });

  await test('POST /orders rejects missing listing_id with 400', async () => {
    const res = await post(appServer, '/orders', buyerToken, {});
    assertEqual(res.status, 400, `expected 400, got ${res.status}`);
  });
}

async function runCaptureTests() {
  console.log('\nCapture');

  await test('POST /orders/:id/capture transitions CREATED → HELD', async () => {
    const order = await createOrder();
    const held = await captureOrder(order.id);
    assertEqual(held.status, 'HELD', 'status must be HELD after capture');
    assert(held.stripe_charge_id, 'stripe_charge_id must be set after capture');
    assert(held.events.some((e) => e.event_type === 'PAYMENT_CAPTURED'), 'PAYMENT_CAPTURED event required');
  });

  await test('capture by seller is rejected with 403', async () => {
    const order = await createOrder();
    const res = await post(appServer, `/orders/${order.id}/capture`, sellerToken);
    assertEqual(res.status, 403, `expected 403, got ${res.status}`);
  });

  await test('double capture returns 409 conflict', async () => {
    const order = await createOrder();
    await captureOrder(order.id); // first capture succeeds
    const res = await post(appServer, `/orders/${order.id}/capture`, buyerToken);
    assertEqual(res.status, 409, `expected 409, got ${res.status}`);
  });
}

async function runShipDeliverTests() {
  console.log('\nShip and deliver');

  await test('POST /orders/:id/ship transitions HELD → SHIPPED', async () => {
    const held = await driveToHeld();
    const shipped = await shipOrder(held.id);
    assertEqual(shipped.status, 'SHIPPED', 'status must be SHIPPED');
    assert(shipped.shipped_at, 'shipped_at must be set');
    assert(shipped.events.some((e) => e.event_type === 'SHIPPED'), 'SHIPPED event required');
  });

  await test('ship by buyer is rejected with 403', async () => {
    const held = await driveToHeld();
    const res = await post(appServer, `/orders/${held.id}/ship`, buyerToken);
    assertEqual(res.status, 403, `expected 403, got ${res.status}`);
  });

  await test('POST /orders/:id/deliver transitions SHIPPED → DELIVERED', async () => {
    const held = await driveToHeld();
    await shipOrder(held.id);
    const delivered = await deliverOrder(held.id);
    assertEqual(delivered.status, 'DELIVERED', 'status must be DELIVERED');
    assert(delivered.delivered_at, 'delivered_at must be set');
    assert(delivered.window_expires_at, 'window_expires_at must be set');
    assert(delivered.events.some((e) => e.event_type === 'DELIVERED'), 'DELIVERED event required');
  });
}

async function runBuyerConfirmTests() {
  console.log('\nBuyer confirm → RELEASED');

  await test('POST /orders/:id/confirm transitions DELIVERED → RELEASED (buyer_confirm)', async () => {
    const delivered = await driveToDelivered();
    const released = await confirmOrder(delivered.id);
    assertEqual(released.status, 'RELEASED', 'status must be RELEASED');
    assert(released.stripe_transfer_id, 'stripe_transfer_id must be set');
    const releaseEvent = released.events.find((e) => e.event_type === 'RELEASED');
    assert(releaseEvent, 'RELEASED event required');
    assertEqual(releaseEvent.payload.triggeredBy, 'buyer_confirm', 'triggeredBy must be buyer_confirm');
  });

  await test('confirm by seller is rejected with 403', async () => {
    const delivered = await driveToDelivered();
    const res = await post(appServer, `/orders/${delivered.id}/confirm`, sellerToken);
    assertEqual(res.status, 403, `expected 403, got ${res.status}`);
  });
}

async function runAutoReleaseTests() {
  console.log('\nAuto-release (run-release-check)');

  await test('POST /admin/run-release-check releases DELIVERED orders past window', async () => {
    const delivered = await driveToDelivered();

    // Backdate window_expires_at so the sweep picks it up
    await pool.query(
      `UPDATE orders SET window_expires_at = $1 WHERE id = $2`,
      [new Date(Date.now() - 60000).toISOString(), delivered.id]
    );

    const res = await post(appServer, '/admin/run-release-check', adminToken);
    assertEqual(res.status, 200, `expected 200, got ${res.status}`);
    assert(res.body.releasedOrderIds.includes(delivered.id), 'orderId must appear in releasedOrderIds');

    const { rows: [row] } = await pool.query('SELECT status, stripe_transfer_id FROM orders WHERE id = $1', [delivered.id]);
    assertEqual(row.status, 'RELEASED', 'order must be RELEASED by sweep');
    assert(row.stripe_transfer_id, 'stripe_transfer_id must be set by sweep');
  });

  await test('DISPUTED orders are not auto-released by run-release-check', async () => {
    const delivered = await driveToDelivered();
    await disputeOrder(delivered.id, 'Item arrived damaged');

    await pool.query(
      `UPDATE orders SET window_expires_at = $1 WHERE id = $2`,
      [new Date(Date.now() - 60000).toISOString(), delivered.id]
    );

    const res = await post(appServer, '/admin/run-release-check', adminToken);
    assertEqual(res.status, 200, `expected 200, got ${res.status}`);
    assert(!res.body.releasedOrderIds.includes(delivered.id), 'DISPUTED order must not be auto-released');
  });
}

async function runDisputeTests() {
  console.log('\nDispute handling');

  await test('POST /orders/:id/dispute transitions DELIVERED → DISPUTED with category', async () => {
    const delivered = await driveToDelivered();
    const disputed = await disputeOrder(delivered.id, 'Item never arrived — not received');
    assertEqual(disputed.status, 'DISPUTED', 'status must be DISPUTED');
    assert(disputed.dispute_category, 'dispute_category must be set');
    const event = disputed.events.find((e) => e.event_type === 'DISPUTED');
    assert(event, 'DISPUTED event required');
    assert(event.payload.reasonText, 'reason must be in event payload');
  });

  await test('admin resolve refund: DISPUTED → REFUNDED', async () => {
    const delivered = await driveToDelivered();
    await disputeOrder(delivered.id, 'Counterfeit item received');
    const refunded = await resolveDispute(delivered.id, 'refund');
    assertEqual(refunded.status, 'REFUNDED', 'status must be REFUNDED');
    assert(refunded.stripe_refund_id, 'stripe_refund_id must be set');
    assert(refunded.events.some((e) => e.event_type === 'REFUNDED'), 'REFUNDED event required');
    assert(refunded.events.some((e) => e.event_type === 'DISPUTE_RESOLVED'), 'DISPUTE_RESOLVED event required');
  });

  await test('admin resolve release: DISPUTED → RELEASED', async () => {
    const delivered = await driveToDelivered();
    await disputeOrder(delivered.id, 'Buyer claims defect');
    const released = await resolveDispute(delivered.id, 'release');
    assertEqual(released.status, 'RELEASED', 'status must be RELEASED');
    assert(released.stripe_transfer_id, 'stripe_transfer_id must be set');
    assert(released.events.some((e) => e.event_type === 'RELEASED'), 'RELEASED event required');
    assert(released.events.some((e) => e.event_type === 'DISPUTE_RESOLVED'), 'DISPUTE_RESOLVED event required');
    assertEqual(released.dispute_resolution, 'release', 'dispute_resolution must be "release"');
  });

  await test('dispute requires a non-empty reason string', async () => {
    const delivered = await driveToDelivered();
    const res = await post(appServer, `/orders/${delivered.id}/dispute`, buyerToken, { reason: '' });
    assertEqual(res.status, 400, `expected 400, got ${res.status}`);
  });

  await test('dispute by seller is rejected with 403', async () => {
    const delivered = await driveToDelivered();
    const res = await post(appServer, `/orders/${delivered.id}/dispute`, sellerToken, { reason: 'test' });
    assertEqual(res.status, 403, `expected 403, got ${res.status}`);
  });
}

async function runCancellationTests() {
  console.log('\nCancellation');

  await test('buyer can cancel HELD order → CANCELLED with partial refund', async () => {
    const held = await driveToHeld();
    const cancelled = await cancelOrder(held.id);
    assertEqual(cancelled.status, 'CANCELLED', 'status must be CANCELLED');
    assert(cancelled.stripe_refund_id, 'stripe_refund_id must be set');
    const event = cancelled.events.find((e) => e.event_type === 'CANCELLED');
    assert(event, 'CANCELLED event required');
    assert(event.payload.refundAmountCents > 0, 'refundAmountCents must be positive');
    assert(event.payload.platformFeeKeptCents > 0, 'platform fee kept must be positive');
    // refundAmountCents + platformFeeKeptCents must equal amount_cents
    assertEqual(
      event.payload.refundAmountCents + event.payload.platformFeeKeptCents,
      cancelled.amount_cents,
      'refund + fee must equal order amount'
    );
  });

  await test('LISTING_REACTIVATE_FAILED event when listing-service is down', async () => {
    mockMarkActiveOk = false;
    try {
      const held = await driveToHeld();
      const cancelled = await cancelOrder(held.id);
      assertEqual(cancelled.status, 'CANCELLED', 'order must reach CANCELLED even if listing reactivation fails');
      assert(cancelled.events.some((e) => e.event_type === 'LISTING_REACTIVATE_FAILED'),
        'LISTING_REACTIVATE_FAILED event required');
    } finally {
      mockMarkActiveOk = true;
    }
  });

  await test('seller cannot cancel order (403)', async () => {
    const held = await driveToHeld();
    const res = await post(appServer, `/orders/${held.id}/cancel`, sellerToken, { reason: 'test' });
    assertEqual(res.status, 403, `expected 403, got ${res.status}`);
  });

  await test('cannot cancel a SHIPPED order', async () => {
    const held = await driveToHeld();
    await shipOrder(held.id);
    const res = await post(appServer, `/orders/${held.id}/cancel`, buyerToken, { reason: 'test' });
    assertEqual(res.status, 409, `expected 409, got ${res.status}`);
  });
}

async function runConcurrencyTests() {
  console.log('\nConcurrent transition protection');

  await test('concurrent capture: second request gets 409 (first wins reserveTransition)', async () => {
    const order = await createOrder();
    // Fire two captures simultaneously — only the first can win the conditional UPDATE
    const [r1, r2] = await Promise.all([
      post(appServer, `/orders/${order.id}/capture`, buyerToken),
      post(appServer, `/orders/${order.id}/capture`, buyerToken),
    ]);
    const statuses = [r1.status, r2.status].sort();
    // One should be 200 (captured) and one 409 (conflict)
    assertEqual(statuses[0], 200, 'one request must succeed (200)');
    assertEqual(statuses[1], 409, 'one request must conflict (409)');

    const { rows: [row] } = await pool.query('SELECT status FROM orders WHERE id = $1', [order.id]);
    assertEqual(row.status, 'HELD', 'order must be HELD after the race');
  });

  await test('concurrent dispute: second request gets 409', async () => {
    const delivered = await driveToDelivered();
    const [r1, r2] = await Promise.all([
      post(appServer, `/orders/${delivered.id}/dispute`, buyerToken, { reason: 'Item broken on arrival' }),
      post(appServer, `/orders/${delivered.id}/dispute`, buyerToken, { reason: 'Wrong item sent' }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assertEqual(statuses[0], 200, 'one dispute must succeed (200)');
    assertEqual(statuses[1], 409, 'second dispute must conflict (409)');
  });
}

async function runMessagesTests() {
  console.log('\nMessages');

  await test('buyer can send and retrieve messages on their order', async () => {
    const held = await driveToHeld();
    const orderId = held.id;

    const send = await post(appServer, `/orders/${orderId}/messages`, buyerToken, { body: 'Hello seller!' });
    assertEqual(send.status, 201, `send message failed: ${JSON.stringify(send.body)}`);
    assertEqual(send.body.body, 'Hello seller!', 'message body must match');
    assertEqual(send.body.sender_id, buyerId, 'sender_id must be buyer');

    const list = await get(appServer, `/orders/${orderId}/messages`, buyerToken);
    assertEqual(list.status, 200, `list messages failed: ${JSON.stringify(list.body)}`);
    assert(Array.isArray(list.body), 'messages must be an array');
    assert(list.body.some((m) => m.body === 'Hello seller!'), 'sent message must appear in list');
  });
}

async function runReviewTests() {
  console.log('\nReviews');

  await test('buyer can leave a review after order is RELEASED', async () => {
    const delivered = await driveToDelivered();
    const released = await confirmOrder(delivered.id);
    assertEqual(released.status, 'RELEASED');

    const res = await post(appServer, `/orders/${released.id}/review`, buyerToken, { rating: 5, body: 'Great seller!' });
    assertEqual(res.status, 201, `review failed: ${JSON.stringify(res.body)}`);
    assertEqual(res.body.rating, 5);
    assertEqual(res.body.reviewer_id, buyerId);
    assertEqual(res.body.reviewee_id, sellerId);
  });

  await test('duplicate review returns 409', async () => {
    const delivered = await driveToDelivered();
    const released = await confirmOrder(delivered.id);

    await post(appServer, `/orders/${released.id}/review`, buyerToken, { rating: 4, body: 'Good' });
    const r2 = await post(appServer, `/orders/${released.id}/review`, buyerToken, { rating: 3, body: 'Meh' });
    assertEqual(r2.status, 409, `expected 409, got ${r2.status}`);
  });

  await test('review requires rating 1-5', async () => {
    const delivered = await driveToDelivered();
    const released = await confirmOrder(delivered.id);

    const r = await post(appServer, `/orders/${released.id}/review`, buyerToken, { rating: 6 });
    assertEqual(r.status, 400, `expected 400 for rating=6, got ${r.status}`);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  console.log('=== Escrow Lifecycle Tests (PostgreSQL) ===');

  try {
    await setup();

    await runOrderCreationTests();
    await runCaptureTests();
    await runShipDeliverTests();
    await runBuyerConfirmTests();
    await runAutoReleaseTests();
    await runDisputeTests();
    await runCancellationTests();
    await runConcurrencyTests();
    await runMessagesTests();
    await runReviewTests();
  } finally {
    await teardown();
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();

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
const { makeRateToken } = require('../src/shippoClient');

// Stub shipping constants (must match STUB_RATES in shippoClient.js)
const STUB_RATE_ID        = 'stub_rate_usps_first_class';
const STUB_SHIPPING_CENTS = 425;
const SELLER_SHIP_ZIP     = '77001';
const TEST_PARCEL         = { weight_oz: 64, length_in: 36, width_in: 6, height_in: 6 };

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

const VALID_SHIPPING_ADDRESS = {
  name: 'John Buyer',
  line1: '123 Main St',
  city: 'Houston',
  state: 'TX',
  zip: '77001',
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function setup() {
  // Start mock listing server and set LISTING_SERVICE_URL
  await new Promise((resolve) => mockListingServer.listen(0, '127.0.0.1', resolve));
  const mockPort = mockListingServer.address().port;
  process.env.LISTING_SERVICE_URL = `http://127.0.0.1:${mockPort}`;

  // Raise rate limits so the full test suite (which creates many orders/labels) does not self-throttle.
  process.env.RATE_LIMIT_LABEL_PURCHASE_MAX = '200';
  process.env.RATE_LIMIT_ORDER_MAX          = '200';
  process.env.RATE_LIMIT_DISPUTE_MAX        = '200';

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
    `INSERT INTO users (name, email, role, stripe_account_id, ship_from_address)
     VALUES ('Test Seller', 'seller@escrow.test', 'seller', 'acct_stub_test_seller', $1) RETURNING id`,
    [JSON.stringify({ name: 'Test Seller', line1: '1 Seller Rd', city: 'Houston', state: 'TX', zip: SELLER_SHIP_ZIP, phone: '5550001111' })]
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
    weight_oz:     TEST_PARCEL.weight_oz,
    pkg_length_in: TEST_PARCEL.length_in,
    pkg_width_in:  TEST_PARCEL.width_in,
    pkg_height_in: TEST_PARCEL.height_in,
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
  const rateToken = makeRateToken(STUB_RATE_ID, LISTING_ID, SELLER_SHIP_ZIP, VALID_SHIPPING_ADDRESS, TEST_PARCEL);
  const res = await post(appServer, '/orders', buyerToken, {
    listing_id: LISTING_ID,
    shipping_address: VALID_SHIPPING_ADDRESS,
    shippo_rate_id: STUB_RATE_ID,
    rate_token: rateToken,
  });
  assertEqual(res.status, 201, `createOrder failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function captureOrder(orderId) {
  const res = await post(appServer, `/orders/${orderId}/capture`, buyerToken);
  assertEqual(res.status, 200, `captureOrder failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function purchaseLabel(orderId) {
  const res = await post(appServer, `/orders/${orderId}/purchase-label`, sellerToken);
  assertEqual(res.status, 200, `purchaseLabel failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function shipOrder(orderId) {
  // Phase 3: platform label orders transition HELD→SHIPPED via a Shippo TRANSIT webhook,
  // not by calling POST /ship directly (that now returns 409 for labeled orders).
  const labeledOrder = await purchaseLabel(orderId);
  assert(labeledOrder.tracking_number, 'purchaseLabel must return tracking_number');
  assert(labeledOrder.carrier, 'purchaseLabel must return carrier');

  // Fire the carrier TRANSIT event.  SHIPPO_WEBHOOK_TOKEN is unset in escrow tests
  // so the webhook endpoint is open (no token required in non-production dev mode).
  const whRes = await post(appServer, '/webhooks/shippo', null, {
    event: 'track_updated',
    test:  false,
    data: {
      tracking_number:  labeledOrder.tracking_number,
      carrier:          labeledOrder.carrier.toLowerCase(),
      tracking_status: {
        status:         'TRANSIT',
        status_date:    new Date(Date.now() - 500).toISOString(),
        status_details: 'In transit (test)',
        substatus:      null,
      },
    },
  });
  assert(whRes.status === 200 && whRes.body.ok,
    `TRANSIT webhook failed: ${JSON.stringify(whRes.body)}`);

  // Return the full order so tests can inspect status and events.
  const getRes = await get(appServer, `/orders/${orderId}`, sellerToken);
  assertEqual(getRes.status, 200, `GET order after ship failed: ${JSON.stringify(getRes.body)}`);
  return getRes.body;
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
    assertEqual(order.amount_cents, 9999 + STUB_SHIPPING_CENTS, 'amount_cents must be item + shipping');
    assert(order.platform_fee_cents > 0, 'platform_fee_cents must be set');
    assertEqual(order.platform_fee_cents + order.seller_payout_cents, 9999, 'fee + payout must equal item price (not amount_cents)');
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

  await test('POST /orders requires shipping_address', async () => {
    const res = await post(appServer, '/orders', buyerToken, { listing_id: LISTING_ID });
    assertEqual(res.status, 422, `expected 422, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.error, 'error message required');
  });

  await test('POST /orders rejects invalid US state', async () => {
    const res = await post(appServer, '/orders', buyerToken, {
      listing_id: LISTING_ID,
      shipping_address: { ...VALID_SHIPPING_ADDRESS, state: 'XX' },
    });
    assertEqual(res.status, 422, `expected 422, got ${res.status}`);
  });

  await test('POST /orders rejects invalid ZIP code', async () => {
    const res = await post(appServer, '/orders', buyerToken, {
      listing_id: LISTING_ID,
      shipping_address: { ...VALID_SHIPPING_ADDRESS, zip: 'ABCDE' },
    });
    assertEqual(res.status, 422, `expected 422, got ${res.status}`);
  });

  await test('POST /orders response does not include shipping_address (privacy)', async () => {
    const order = await createOrder();
    assert(!('shipping_address' in order), 'shipping_address must not be in order response');
    assert(!('shipping_address' in (order.events ? order : {})), 'shipping_address must not leak');
  });

  await test('GET /orders/:id does not include shipping_address', async () => {
    const order = await createOrder();
    const res = await get(appServer, `/orders/${order.id}`, buyerToken);
    assertEqual(res.status, 200, `expected 200, got ${res.status}`);
    assert(!('shipping_address' in res.body), 'shipping_address must not appear in GET response');
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

  await test('carrier TRANSIT webhook transitions HELD → SHIPPED (label order)', async () => {
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
// Phase 4: Label void on cancellation
// ---------------------------------------------------------------------------

async function runCancelWithVoidTests() {
  console.log('\nPhase 4 — Cancel with label void');

  await test('cancel HELD+labeled order: label voided, CANCELLED, LABEL_VOIDED event', async () => {
    const held = await driveToHeld();
    await purchaseLabel(held.id);

    const res = await post(appServer, `/orders/${held.id}/cancel`, buyerToken, { reason: 'changed mind' });
    assertEqual(res.status, 200, `cancel must succeed: ${JSON.stringify(res.body)}`);
    assertEqual(res.body.status, 'CANCELLED', 'order must be CANCELLED');

    const { rows } = await pool.query(
      'SELECT label_voided_at, label_void_refund_cents FROM orders WHERE id = $1',
      [held.id]
    );
    assert(rows[0].label_voided_at != null, 'label_voided_at must be set after void');

    const { rows: events } = await pool.query(
      `SELECT payload_json FROM order_events WHERE order_id = $1 AND event_type = 'LABEL_VOIDED'`,
      [held.id]
    );
    assert(events.length > 0, 'LABEL_VOIDED event must be recorded');
    const voidPayload = JSON.parse(events[0].payload_json);
    assertEqual(voidPayload.cancelledBy, 'buyer', 'event.cancelledBy must be buyer');
  });

  await test('cancel HELD without label: void skipped, CANCELLED, no LABEL_VOIDED event', async () => {
    const held = await driveToHeld();
    // No purchaseLabel — order has no label_id

    const res = await post(appServer, `/orders/${held.id}/cancel`, buyerToken, { reason: 'no label test' });
    assertEqual(res.status, 200, `cancel must succeed: ${JSON.stringify(res.body)}`);
    assertEqual(res.body.status, 'CANCELLED', 'order must be CANCELLED');

    const { rows } = await pool.query(
      'SELECT label_voided_at FROM orders WHERE id = $1',
      [held.id]
    );
    assertEqual(rows[0].label_voided_at, null, 'label_voided_at must remain null');

    const { rows: events } = await pool.query(
      `SELECT 1 FROM order_events WHERE order_id = $1 AND event_type = 'LABEL_VOIDED'`,
      [held.id]
    );
    assertEqual(events.length, 0, 'no LABEL_VOIDED event for non-labeled order');
  });

  await test('cancel with definitive void failure: LABEL_VOID_FAILED event, cancel still completes', async () => {
    process.env.STUB_VOID_MODE = 'definitive';
    try {
      const held = await driveToHeld();
      await purchaseLabel(held.id);

      const res = await post(appServer, `/orders/${held.id}/cancel`, buyerToken, { reason: 'test' });
      assertEqual(res.status, 200, `cancel must complete despite definitive void failure: ${JSON.stringify(res.body)}`);
      assertEqual(res.body.status, 'CANCELLED', 'order must reach CANCELLED');

      const { rows } = await pool.query(
        'SELECT label_voided_at FROM orders WHERE id = $1', [held.id]
      );
      assertEqual(rows[0].label_voided_at, null, 'label_voided_at must be null (void definitively failed)');

      const { rows: events } = await pool.query(
        `SELECT payload_json FROM order_events WHERE order_id = $1 AND event_type = 'LABEL_VOID_FAILED'`,
        [held.id]
      );
      assert(events.length > 0, 'LABEL_VOID_FAILED event must be recorded');
      const failPayload = JSON.parse(events[0].payload_json);
      assert(failPayload.definitive === true, 'event must record definitive=true');
    } finally {
      delete process.env.STUB_VOID_MODE;
    }
  });

  await test('cancel with ambiguous void: 503, order stays CANCELLING, recovery completes cancel', async () => {
    process.env.STUB_VOID_MODE = 'ambiguous';
    let orderId;
    try {
      const held = await driveToHeld();
      orderId = held.id;
      await purchaseLabel(orderId);

      // Ambiguous void → cancel returns 503, order stays CANCELLING
      const res = await post(appServer, `/orders/${orderId}/cancel`, buyerToken, { reason: 'test ambiguous' });
      assertEqual(res.status, 503, `cancel must return 503 on ambiguous void: ${JSON.stringify(res.body)}`);

      const { rows: mid } = await pool.query('SELECT status FROM orders WHERE id = $1', [orderId]);
      assertEqual(mid[0].status, 'CANCELLING', 'order must remain CANCELLING after ambiguous void');

      const { rows: ambEvents } = await pool.query(
        `SELECT 1 FROM order_events WHERE order_id = $1 AND event_type = 'LABEL_VOID_AMBIGUOUS'`,
        [orderId]
      );
      assert(ambEvents.length > 0, 'LABEL_VOID_AMBIGUOUS event must be recorded');
    } finally {
      delete process.env.STUB_VOID_MODE;
    }

    // Backdate transition_started_at so recovery sweep picks it up
    await pool.query(
      `UPDATE orders SET transition_started_at = NOW() - INTERVAL '15 minutes' WHERE id = $1`,
      [orderId]
    );

    // Recovery: STUB_VOID_MODE unset → findRefundByTransaction returns null (stub) →
    // retry voidLabel → success → write label_voided_at → Stripe refund → CANCELLED
    const { runRecovery } = require('../src/recoveryService');
    const result = await runRecovery();
    assert(
      result.recoveredOrderIds.includes(orderId),
      `order ${orderId} must appear in recoveredOrderIds; got: ${JSON.stringify(result)}`
    );

    const { rows: final } = await pool.query(
      'SELECT status, label_voided_at FROM orders WHERE id = $1', [orderId]
    );
    assertEqual(final[0].status, 'CANCELLED', 'order must be CANCELLED after recovery');
    assert(final[0].label_voided_at != null, 'label_voided_at must be set by recovery');

    const { rows: voidedEvents } = await pool.query(
      `SELECT payload_json FROM order_events WHERE order_id = $1 AND event_type = 'LABEL_VOIDED'`,
      [orderId]
    );
    assert(voidedEvents.length > 0, 'LABEL_VOIDED event must be recorded by recovery');
    const recoveryVoidPayload = JSON.parse(voidedEvents[0].payload_json);
    assertEqual(recoveryVoidPayload.triggeredBy, 'recovery', 'triggeredBy must be recovery');
  });
}

// ---------------------------------------------------------------------------
// Phase 5: Dispute eligibility (SHIPPED exceptions + window gating) + admin notes
// ---------------------------------------------------------------------------

async function runPhase5DisputeTests() {
  console.log('\nPhase 5 — Dispute eligibility and admin notes');

  // Fire a Shippo tracking webhook for an already-SHIPPED order.
  async function fireTrackingWebhook(orderId, trackingStatus) {
    const getRes = await get(appServer, `/orders/${orderId}`, sellerToken);
    const { tracking_number, carrier } = getRes.body;
    assert(tracking_number, `tracking_number must be set for order ${orderId}`);
    const whRes = await post(appServer, '/webhooks/shippo', null, {
      event: 'track_updated',
      test: false,
      data: {
        tracking_number,
        carrier: carrier.toLowerCase(),
        tracking_status: {
          status:         trackingStatus,
          status_date:    new Date().toISOString(),
          status_details: `${trackingStatus} (test)`,
          substatus:      null,
        },
      },
    });
    assertEqual(whRes.status, 200, `${trackingStatus} webhook failed: ${JSON.stringify(whRes.body)}`);
    const final = await get(appServer, `/orders/${orderId}`, sellerToken);
    return final.body;
  }

  // Drive to SHIPPED then fire a RETURNED or FAILURE event.
  async function driveToShippedWithException(exceptionStatus) {
    const held = await driveToHeld();
    await shipOrder(held.id); // HELD → SHIPPED via TRANSIT webhook
    return fireTrackingWebhook(held.id, exceptionStatus);
  }

  await test('SHIPPED+RETURNED order can be disputed (Phase 5)', async () => {
    const order = await driveToShippedWithException('RETURNED');
    assertEqual(order.status, 'SHIPPED', 'order must be SHIPPED');
    assertEqual(order.tracking_status, 'RETURNED', 'tracking_status must be RETURNED');

    const res = await post(appServer, `/orders/${order.id}/dispute`, buyerToken, {
      reason: 'Package was returned to sender before I received it',
    });
    assertEqual(res.status, 200, `dispute must succeed: ${JSON.stringify(res.body)}`);
    assertEqual(res.body.status, 'DISPUTED', 'order must be DISPUTED');
    const event = res.body.events.find((e) => e.event_type === 'DISPUTED');
    assert(event, 'DISPUTED event required');
    assertEqual(event.payload.priorStatus, 'SHIPPED', 'priorStatus must be SHIPPED in event');
  });

  await test('SHIPPED+FAILURE order can be disputed (Phase 5)', async () => {
    const order = await driveToShippedWithException('FAILURE');
    const res = await post(appServer, `/orders/${order.id}/dispute`, buyerToken, {
      reason: 'Carrier failed to deliver and item lost',
    });
    assertEqual(res.status, 200, `dispute must succeed: ${JSON.stringify(res.body)}`);
    assertEqual(res.body.status, 'DISPUTED', 'order must be DISPUTED');
    const event = res.body.events.find((e) => e.event_type === 'DISPUTED');
    assertEqual(event.payload.priorStatus, 'SHIPPED', 'priorStatus must be SHIPPED in event');
  });

  await test('SHIPPED without exception is rejected with 409 (Phase 5)', async () => {
    const held = await driveToHeld();
    await shipOrder(held.id);
    const res = await post(appServer, `/orders/${held.id}/dispute`, buyerToken, {
      reason: 'Changed my mind',
    });
    assertEqual(res.status, 409, `dispute must be rejected: ${JSON.stringify(res.body)}`);
    assert(res.body.error.includes('RETURNED or FAILURE'), 'error must explain shipping exception requirement');
  });

  await test('DELIVERED past window_expires_at rejected with 409 (Phase 5)', async () => {
    const delivered = await driveToDelivered();
    // Expire the window
    await pool.query(
      `UPDATE orders SET window_expires_at = $1 WHERE id = $2`,
      [new Date(Date.now() - 1000).toISOString(), delivered.id]
    );
    const res = await post(appServer, `/orders/${delivered.id}/dispute`, buyerToken, { reason: 'Too late claim' });
    assertEqual(res.status, 409, `dispute must be rejected after window: ${JSON.stringify(res.body)}`);
    assert(res.body.error.includes('expired'), 'error must mention expiry');
  });

  await test('DELIVERED inside window is still accepted (Phase 5 regression)', async () => {
    const delivered = await driveToDelivered();
    // window_expires_at is set in the future by default (48h from delivery)
    const res = await post(appServer, `/orders/${delivered.id}/dispute`, buyerToken, {
      reason: 'Item is completely wrong — wrong size and model',
    });
    assertEqual(res.status, 200, `dispute inside window must succeed: ${JSON.stringify(res.body)}`);
    assertEqual(res.body.status, 'DISPUTED', 'order must be DISPUTED');
    const event = res.body.events.find((e) => e.event_type === 'DISPUTED');
    assertEqual(event.payload.priorStatus, 'DELIVERED', 'priorStatus must be DELIVERED in event');
  });

  await test('admin resolve with notes: notes stored and in DISPUTE_RESOLVED event (Phase 5)', async () => {
    const delivered = await driveToDelivered();
    await disputeOrder(delivered.id, 'Item arrived cracked in two pieces');

    const adminNotes = 'Buyer provided photos confirming damage. Listing described item as new. Refunding.';
    const res = await post(appServer, `/admin/orders/${delivered.id}/resolve`, adminToken, {
      action: 'refund',
      notes: adminNotes,
    });
    assertEqual(res.status, 200, `resolve must succeed: ${JSON.stringify(res.body)}`);
    assertEqual(res.body.status, 'REFUNDED', 'order must be REFUNDED');

    const { rows } = await pool.query(
      'SELECT dispute_admin_notes FROM orders WHERE id = $1', [delivered.id]
    );
    assertEqual(rows[0].dispute_admin_notes, adminNotes, 'dispute_admin_notes must be stored in DB');

    const resolvedEvent = res.body.events.find((e) => e.event_type === 'DISPUTE_RESOLVED');
    assert(resolvedEvent, 'DISPUTE_RESOLVED event required');
    assertEqual(resolvedEvent.payload.notes, adminNotes, 'notes must appear in DISPUTE_RESOLVED event payload');
  });

  await test('admin resolve without notes: notes field is null (Phase 5)', async () => {
    const delivered = await driveToDelivered();
    await disputeOrder(delivered.id, 'Wrong item');

    const res = await post(appServer, `/admin/orders/${delivered.id}/resolve`, adminToken, {
      action: 'release',
    });
    assertEqual(res.status, 200, `resolve must succeed: ${JSON.stringify(res.body)}`);
    const { rows } = await pool.query(
      'SELECT dispute_admin_notes FROM orders WHERE id = $1', [delivered.id]
    );
    assertEqual(rows[0].dispute_admin_notes, null, 'dispute_admin_notes must be null when not provided');
  });

  await test('notifyDisputed sends buyer confirmation and admin alert emails (Phase 5)', async () => {
    const emailer = require('../src/emailer');
    const delivered = await driveToDelivered();

    // Let any delivery notifications settle, then clear the slate.
    await new Promise((r) => setTimeout(r, 80));
    emailer._clearCaptured();
    process.env.ADMIN_ALERT_EMAIL = 'admin-alert@cricket.test';

    await disputeOrder(delivered.id, 'Item never arrived at my address');

    // Wait for fire-and-forget notifications to complete.
    await new Promise((r) => setTimeout(r, 120));

    const emails = emailer._getCaptured();
    const toAddresses = emails.map((e) => e.to);
    assert(
      emails.some((e) => e.to === 'buyer@escrow.test' && e.subject.includes('Dispute received')),
      `buyer confirmation email must be sent; captured to: ${JSON.stringify(toAddresses)}`
    );
    assert(
      emails.some((e) => e.to === 'admin-alert@cricket.test'),
      `admin alert email must be sent; captured to: ${JSON.stringify(toAddresses)}`
    );

    delete process.env.ADMIN_ALERT_EMAIL;
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
    await runCancelWithVoidTests();
    await runPhase5DisputeTests();
  } finally {
    await teardown();
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();

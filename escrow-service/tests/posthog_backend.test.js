'use strict';

/**
 * PostHog backend tests.
 * Section 1: posthog.js helper isolation — quiet no-op behaviour.
 * Section 2: orderService integration — verifies capture is called correctly
 *             using a synchronous spy (no real PostHog network calls).
 *
 * Run standalone: node tests/posthog_backend.test.js
 * Prerequisites: DATABASE_URL_TEST set; migrations applied to test DB.
 */

// ── Environment setup — must precede any src/ require ─────────────────────
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.DATABASE_URL  = process.env.DATABASE_URL_TEST;
process.env.JWT_SECRET    = process.env.JWT_SECRET || 'change-me';
delete process.env.STRIPE_SECRET_KEY;   // force stub Stripe
delete process.env.POSTHOG_API_KEY;     // no real PostHog calls
process.env.EVIDENCE_DIR  = require('os').tmpdir() + '/escrow_posthog_test_' + Date.now();

const http = require('http');
const path = require('path');
const jwt  = require('jsonwebtoken');

// ── Test harness ──────────────────────────────────────────────────────────

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

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`);
}

// ── fresh posthog module (clears require cache) ───────────────────────────

function freshPosthog() {
  const key = require.resolve('../src/posthog');
  delete require.cache[key];
  return require('../src/posthog');
}

// ── Mock listing server ───────────────────────────────────────────────────

let mockListing = null;

const mockListingServer = http.createServer((req, res) => {
  if (req.method === 'GET' && /^\/listings\/\d+$/.test(req.url)) {
    if (!mockListing) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mockListing));
    }
  } else if (req.method === 'PATCH' && /\/listings\/\d+\/mark-sold$/.test(req.url)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } else if (req.method === 'PATCH' && /\/listings\/\d+\/mark-active$/.test(req.url)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});

// ── HTTP helpers ──────────────────────────────────────────────────────────

function request(server, method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const addr    = server.address();
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: '127.0.0.1',
      port: addr.port,
      path: urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
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

// ── State ─────────────────────────────────────────────────────────────────

let pool, appServer;
let buyerId, sellerId, adminId;
let buyerToken, sellerToken, adminToken;
const LISTING_ID = 997;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const VALID_ADDR = {
  name: 'Test Buyer', line1: '1 Main St', city: 'Houston', state: 'TX', zip: '77001',
};

// Spy: captures all PostHog calls made by orderService
const capturedEvents = [];

// ── Section 1: Helper isolation tests ────────────────────────────────────

async function runHelperTests() {
  console.log('\nPostHog helper — quiet no-op behaviour');

  await test('capture without POSTHOG_API_KEY is a silent no-op (no throw)', async () => {
    delete process.env.POSTHOG_API_KEY;
    const ph = freshPosthog();
    ph.capture('1', 'test_event', { foo: 'bar' });
  });

  await test('capture with null distinctId does not throw', async () => {
    delete process.env.POSTHOG_API_KEY;
    const ph = freshPosthog();
    ph.capture(null, 'test_event');
  });

  await test('capture with undefined properties does not throw', async () => {
    delete process.env.POSTHOG_API_KEY;
    const ph = freshPosthog();
    ph.capture('1', 'test_event');
  });

  await test('capture with invalid key does not propagate async rejection', async () => {
    process.env.POSTHOG_API_KEY = 'phc_invalid_key_for_test_12345';
    const ph = freshPosthog();
    // The call itself must not throw.
    ph.capture('user1', 'test_event', { order_id: 99 });
    // Give the detached async tail time to settle (flush will fail, but rejection must be caught).
    await new Promise((r) => setTimeout(r, 300));
    delete process.env.POSTHOG_API_KEY;
  });
}

// ── Section 2: Integration setup ─────────────────────────────────────────

async function setup() {
  await new Promise((r) => mockListingServer.listen(0, '127.0.0.1', r));
  const mockPort = mockListingServer.address().port;
  process.env.LISTING_SERVICE_URL          = `http://127.0.0.1:${mockPort}`;
  process.env.RATE_LIMIT_ORDER_CREATE_MAX  = '500';
  process.env.RATE_LIMIT_LABEL_PURCHASE_MAX = '500';
  process.env.RATE_LIMIT_DISPUTE_MAX       = '500';

  // Patch posthog spy BEFORE loading src/ modules.
  // orderService.js does `const posthog = require('./posthog')` at module load time.
  // Since Node.js returns the same cached object, replacing .capture here affects orderService.
  const posthogMod = freshPosthog();
  posthogMod.capture = (distinctId, event, props) => {
    capturedEvents.push({ distinctId: String(distinctId), event, props: props || {} });
  };

  pool = require('../src/db');
  const { buildApp } = require('../src/app');

  await pool.query(`
    TRUNCATE reviews, messages, order_events, orders, listings, users
    RESTART IDENTITY CASCADE
  `);

  const { rows: [buyer] } = await pool.query(
    `INSERT INTO users (name, email, role) VALUES ('Test Buyer', 'buyer@ph.test', 'buyer') RETURNING id`
  );
  const { rows: [seller] } = await pool.query(
    `INSERT INTO users (name, email, role, stripe_account_id, ship_from_address)
     VALUES ('Test Seller', 'seller@ph.test', 'seller', 'acct_stub_ph_test', $1) RETURNING id`,
    [JSON.stringify({ name: 'Seller', line1: '1 S St', city: 'Houston', state: 'TX', zip: '77001', phone: '5550001111' })]
  );
  const { rows: [admin] } = await pool.query(
    `INSERT INTO users (name, email, role) VALUES ('Test Admin', 'admin@ph.test', 'admin') RETURNING id`
  );

  buyerId  = buyer.id;
  sellerId = seller.id;
  adminId  = admin.id;

  buyerToken  = jwt.sign({ sub: String(buyerId),  role: 'buyer',  email: 'buyer@ph.test'  }, JWT_SECRET);
  sellerToken = jwt.sign({ sub: String(sellerId), role: 'seller', email: 'seller@ph.test' }, JWT_SECRET);
  adminToken  = jwt.sign({ sub: String(adminId),  role: 'admin',  email: 'admin@ph.test'  }, JWT_SECRET);

  mockListing = {
    id: LISTING_ID,
    seller_id: sellerId,
    title: 'Test Cricket Bat',
    price_cents: 10000,
    status: 'active',
    weight_oz: 64,
    pkg_length_in: 36,
    pkg_width_in:  6,
    pkg_height_in: 6,
    ship_from_address: {
      name: 'Seller', line1: '1 S St', city: 'Houston', state: 'TX', zip: '77001', phone: '5550001111',
    },
  };

  const app = buildApp();
  appServer = http.createServer(app);
  await new Promise((r) => appServer.listen(0, '127.0.0.1', r));
}

async function teardown() {
  await new Promise((r) => appServer.close(r));
  await new Promise((r) => mockListingServer.close(r));
  await pool.end();
}

// ── Integration helpers ───────────────────────────────────────────────────

async function createAndCapture() {
  const create = await post(appServer, '/orders', buyerToken,
    { listing_id: LISTING_ID, shipping_address: VALID_ADDR });
  assert(create.status === 201, `create failed: ${create.status} — ${JSON.stringify(create.body)}`);
  const orderId = create.body.id;
  const capture = await post(appServer, `/orders/${orderId}/capture`, buyerToken, {});
  assert(capture.status === 200, `capture failed: ${capture.status} — ${JSON.stringify(capture.body)}`);
  return orderId;
}

async function advanceToDelivered(orderId) {
  const ship = await post(appServer, `/orders/${orderId}/ship`, sellerToken,
    { carrier: 'USPS', tracking_number: `TRK_PH_${orderId}_${Date.now()}` });
  assert(ship.status === 200, `ship failed: ${ship.status}`);
  const deliver = await post(appServer, `/orders/${orderId}/deliver`, adminToken, {});
  assert(deliver.status === 200, `deliver failed: ${deliver.status}`);
}

// ── Section 2: Integration tests ─────────────────────────────────────────

async function runIntegrationTests() {
  console.log('\nPostHog order service integration');

  // --- purchase_completed ---

  await test('purchase_completed fires once after CREATED→HELD transition', async () => {
    const before = capturedEvents.length;
    await createAndCapture();
    const newEvents = capturedEvents.slice(before);
    const pc = newEvents.filter((e) => e.event === 'purchase_completed');
    assertEqual(pc.length, 1, `expected 1 purchase_completed, got ${pc.length}`);
    assert(pc[0].props.order_id != null, 'order_id must be present');
    assertEqual(pc[0].distinctId, String(buyerId), 'distinctId must be buyer_id');
  });

  await test('purchase_completed does not fire when capture fails (double-capture 409)', async () => {
    const orderId = await createAndCapture(); // already HELD
    const before = capturedEvents.length;
    const res = await post(appServer, `/orders/${orderId}/capture`, buyerToken, {});
    assertEqual(res.status, 409, `expected 409, got ${res.status}`);
    assertEqual(capturedEvents.length - before, 0, 'no event on 409 conflict');
  });

  // --- delivery_confirmed ---

  await test('delivery_confirmed fires once for buyer confirmation (triggeredBy=buyer_confirm)', async () => {
    const orderId = await createAndCapture();
    await advanceToDelivered(orderId);
    const before = capturedEvents.length;
    const res = await post(appServer, `/orders/${orderId}/confirm`, buyerToken, {});
    assertEqual(res.status, 200, `confirm failed: ${JSON.stringify(res.body)}`);
    const newEvents = capturedEvents.slice(before);
    const dc = newEvents.filter((e) => e.event === 'delivery_confirmed');
    assertEqual(dc.length, 1, `expected 1 delivery_confirmed, got ${dc.length}`);
    assertEqual(dc[0].distinctId, String(buyerId));
  });

  await test('delivery_confirmed does not fire for auto_release_sweep', async () => {
    const orderId = await createAndCapture();
    await advanceToDelivered(orderId);
    // Backdate window_expires_at so the sweep releases this order
    await pool.query(
      `UPDATE orders SET window_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
      [orderId]
    );
    const before = capturedEvents.length;
    const res = await post(appServer, '/admin/run-release-check', adminToken, {});
    assertEqual(res.status, 200, `release-check failed: ${res.status}`);
    const newEvents = capturedEvents.slice(before);
    const dc = newEvents.filter((e) => e.event === 'delivery_confirmed');
    assertEqual(dc.length, 0, `delivery_confirmed must not fire for auto_release_sweep; got ${dc.length}`);
  });

  await test('delivery_confirmed does not fire for admin dispute resolution (release)', async () => {
    const orderId = await createAndCapture();
    await advanceToDelivered(orderId);
    // Open dispute (dispute_opened fires — that's fine, track from here)
    const disputeRes = await post(appServer, `/orders/${orderId}/dispute`, buyerToken,
      { reason: 'Item not as described' });
    assertEqual(disputeRes.status, 200, `dispute failed: ${disputeRes.status}`);
    // Track only events from the admin resolve
    const before = capturedEvents.length;
    const resolveRes = await post(appServer, `/admin/orders/${orderId}/resolve`, adminToken,
      { action: 'release' });
    assertEqual(resolveRes.status, 200, `resolve failed: ${resolveRes.status}`);
    const newEvents = capturedEvents.slice(before);
    const dc = newEvents.filter((e) => e.event === 'delivery_confirmed');
    assertEqual(dc.length, 0, `delivery_confirmed must not fire for admin_resolve; got ${dc.length}`);
  });

  await test('delivery_confirmed does not fire on double confirm (second call 409)', async () => {
    const orderId = await createAndCapture();
    await advanceToDelivered(orderId);
    const res1 = await post(appServer, `/orders/${orderId}/confirm`, buyerToken, {});
    assertEqual(res1.status, 200);
    const before = capturedEvents.length;
    const res2 = await post(appServer, `/orders/${orderId}/confirm`, buyerToken, {});
    assertEqual(res2.status, 409);
    assertEqual(capturedEvents.length - before, 0, 'no event on conflict repeat');
  });

  // --- dispute_opened ---

  await test('dispute_opened fires once after successful dispute', async () => {
    const orderId = await createAndCapture();
    await advanceToDelivered(orderId);
    const before = capturedEvents.length;
    const res = await post(appServer, `/orders/${orderId}/dispute`, buyerToken,
      { reason: 'Item damaged in transit' });
    assertEqual(res.status, 200, `dispute failed: ${JSON.stringify(res.body)}`);
    const newEvents = capturedEvents.slice(before);
    const do_ = newEvents.filter((e) => e.event === 'dispute_opened');
    assertEqual(do_.length, 1, `expected 1 dispute_opened, got ${do_.length}`);
    assertEqual(do_[0].distinctId, String(buyerId));
  });

  await test('dispute_opened does not fire when order is in wrong state (HELD, not DELIVERED)', async () => {
    const orderId = await createAndCapture(); // order is HELD
    const before = capturedEvents.length;
    const res = await post(appServer, `/orders/${orderId}/dispute`, buyerToken,
      { reason: 'Test dispute on HELD order' });
    assert(res.status >= 400, `expected error status, got ${res.status}`);
    assertEqual(capturedEvents.length - before, 0, 'no event on failed dispute');
  });

  await test('dispute_opened does not fire on repeated dispute attempt (order already DISPUTED)', async () => {
    const orderId = await createAndCapture();
    await advanceToDelivered(orderId);
    await post(appServer, `/orders/${orderId}/dispute`, buyerToken, { reason: 'First dispute' });
    const before = capturedEvents.length;
    const res = await post(appServer, `/orders/${orderId}/dispute`, buyerToken, { reason: 'Second attempt' });
    assert(res.status >= 400, `expected error on double-dispute, got ${res.status}`);
    assertEqual(capturedEvents.length - before, 0, 'no second dispute_opened');
  });
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  await runHelperTests();

  await setup();
  await runIntegrationTests();
  await teardown();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

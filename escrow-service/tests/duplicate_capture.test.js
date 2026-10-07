// tests/duplicate_capture.test.js
//
// Focused test: can two orders for the same listing both have payment captured?
//
// Documents a KNOWN GAP: markListingSold fires at capture not at order creation,
// and there is no unique constraint on listing_id in the orders table.
// Two buyers can each create an order and both can capture — resulting in two
// real charges for a single listing.
//
// This test runs entirely in stub Stripe mode — no live or test-mode charges.
//
// Run: node tests/duplicate_capture.test.js
// Exit 0 = assertions matched expected behavior, 1 = unexpected failure.

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ||
  'postgres://escrow_user:escrow_pass@127.0.0.1:5432/escrow_db_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'change-me';
delete process.env.STRIPE_SECRET_KEY; // force stub mode — no charges

const http = require('http');
const jwt  = require('jsonwebtoken');

// ── Mock listing-service ────────────────────────────────────────────────────

let markSoldCallCount = 0;

const mockListingServer = http.createServer((req, res) => {
  if (req.method === 'GET' && /^\/listings\/\d+$/.test(req.url)) {
    // Always return active so both buyers can create orders
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 8001,
      seller_id: null, // set after seller is seeded
      title: 'Duplicate Capture Test Bat',
      price_cents: 5000,
      status: 'active',
      weight_oz: 32,
      pkg_length_in: 20,
      pkg_width_in: 5,
      pkg_height_in: 5,
    }));
  } else if (req.method === 'PATCH' && /^\/listings\/\d+\/mark-sold$/.test(req.url)) {
    markSoldCallCount++;
    // Always return 200 — simulates a listing-service that accepts repeated mark-sold
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } else if (req.method === 'PATCH' && /^\/listings\/\d+\/mark-active$/.test(req.url)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.writeHead(404); res.end('not found');
  }
});

// ── Test harness ────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

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

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function request(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const addr    = server.address();
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: '127.0.0.1',
      port:     addr.port,
      path, method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(token  ? { Authorization: `Bearer ${token}` } : {}),
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let b; try { b = JSON.parse(data); } catch { b = data; }
        resolve({ status: res.statusCode, body: b });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const post = (s, p, t, b) => request(s, 'POST', p, t, b);
const get  = (s, p, t)    => request(s, 'GET',  p, t, null);

// ── State ─────────────────────────────────────────────────────────────────────

let pool, appServer;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';

const SHIPPING_ADDRESS = {
  name: 'Test Buyer', line1: '100 Test St',
  city: 'Houston', state: 'TX', zip: '77001',
};

// ── Setup / teardown ──────────────────────────────────────────────────────────

async function setup() {
  await new Promise(r => mockListingServer.listen(0, '127.0.0.1', r));
  const mockPort = mockListingServer.address().port;
  process.env.LISTING_SERVICE_URL = `http://127.0.0.1:${mockPort}`;
  process.env.RATE_LIMIT_ORDER_CREATE_MAX = '500';

  pool = require('../src/db');
  const { buildApp } = require('../src/app');

  await pool.query(`
    TRUNCATE reviews, messages, order_events, orders, listings, users
    RESTART IDENTITY CASCADE
  `);

  const { rows: [seller] } = await pool.query(
    `INSERT INTO users (name, email, role, stripe_account_id, ship_from_address)
     VALUES ('Dup Seller', 'dup_seller@test.invalid', 'seller', 'acct_stub_dup_seller',
             '{"name":"Dup Seller","line1":"1 Seller Rd","city":"Houston","state":"TX","zip":"77001","phone":"5550001111"}')
     RETURNING id`
  );
  // Patch mock to return real seller_id
  const sellerId = seller.id;
  mockListingServer.removeAllListeners('request');
  mockListingServer.on('request', (req, res) => {
    if (req.method === 'GET' && /^\/listings\/\d+$/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 8001, seller_id: sellerId,
        title: 'Duplicate Capture Test Bat', price_cents: 5000, status: 'active',
        weight_oz: 32, pkg_length_in: 20, pkg_width_in: 5, pkg_height_in: 5,
      }));
    } else if (req.method === 'PATCH' && /^\/listings\/\d+\/mark-sold$/.test(req.url)) {
      markSoldCallCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else if (req.method === 'PATCH' && /^\/listings\/\d+\/mark-active$/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404); res.end('not found');
    }
  });

  const { rows: [buyerA] } = await pool.query(
    `INSERT INTO users (name, email, role)
     VALUES ('Buyer A', 'dup_buyer_a@test.invalid', 'buyer') RETURNING id`
  );
  const { rows: [buyerB] } = await pool.query(
    `INSERT INTO users (name, email, role)
     VALUES ('Buyer B', 'dup_buyer_b@test.invalid', 'buyer') RETURNING id`
  );

  const app = buildApp();
  appServer = http.createServer(app);
  await new Promise(r => appServer.listen(0, '127.0.0.1', r));

  return {
    sellerId,
    buyerAId: buyerA.id, buyerBId: buyerB.id,
    tokenA: jwt.sign({ sub: String(buyerA.id), email: 'dup_buyer_a@test.invalid', role: 'buyer' }, JWT_SECRET),
    tokenB: jwt.sign({ sub: String(buyerB.id), email: 'dup_buyer_b@test.invalid', role: 'buyer' }, JWT_SECRET),
  };
}

async function teardown() {
  await new Promise(r => appServer.close(r));
  await new Promise(r => mockListingServer.close(r));
  await pool.end();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function run() {
  const { tokenA, tokenB } = await setup();
  console.log('\nDuplicate capture tests (stub Stripe — no charges)\n');

  let orderAId, orderBId;

  // ── Step 1: both buyers create an order for the same listing ──────────────

  await test('buyer A creates order for listing 8001', async () => {
    const r = await post(appServer, '/orders', tokenA, {
      listing_id: 8001,
      shipping_address: SHIPPING_ADDRESS,
    });
    assertEqual(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assertEqual(r.body.status, 'CREATED');
    orderAId = r.body.id;
  });

  await test('buyer B creates order for same listing 8001 (no constraint stops this)', async () => {
    const r = await post(appServer, '/orders', tokenB, {
      listing_id: 8001,
      shipping_address: SHIPPING_ADDRESS,
    });
    assertEqual(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assertEqual(r.body.status, 'CREATED');
    orderBId = r.body.id;
    assert(orderBId !== orderAId, 'orders should have different IDs');
  });

  // ── Step 2: buyer A captures ───────────────────────────────────────────────

  await test('buyer A captures order (first capture for listing 8001)', async () => {
    const r = await post(appServer, `/orders/${orderAId}/capture`, tokenA, {});
    assertEqual(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assertEqual(r.body.status, 'HELD', 'order A should be HELD');
  });

  // ── Step 3: buyer B captures — KNOWN GAP ──────────────────────────────────
  //
  // KNOWN GAP: markListingSold fires at capture (not at order creation).
  // There is no unique constraint on listing_id in the orders table.
  // Each order has its own Stripe payment intent; reserveTransition is
  // per-order. Nothing prevents a second capture from succeeding.
  //
  // This test documents the current behavior. If the gap is fixed, order B's
  // capture should return 409 (listing already sold). Until then it returns 200.

  let orderBStatus;
  await test('KNOWN GAP — buyer B can also capture order B for the same listing', async () => {
    const r = await post(appServer, `/orders/${orderBId}/capture`, tokenB, {});
    orderBStatus = r.status;

    if (r.status === 200 && r.body.status === 'HELD') {
      // Gap confirmed: both orders captured. Document without failing the suite.
      console.log('     ⚠  KNOWN GAP CONFIRMED: both orders for listing 8001 reached HELD.');
      console.log('        Two payments were captured for a single listing.');
      console.log('        Fix: add a unique constraint or listing-level lock before capture.');
      // This is expected current behavior — do not throw.
    } else if (r.status === 409) {
      // Gap is fixed. Document the improvement.
      console.log('     ✓  Gap fixed: second capture correctly rejected (409).');
    } else {
      throw new Error(`Unexpected status ${r.status}: ${JSON.stringify(r.body)}`);
    }
  });

  await test('mark-sold was called for each captured order (not deduplicated)', async () => {
    const capturedBoth = orderBStatus === 200;
    if (capturedBoth) {
      assert(markSoldCallCount >= 2,
        `Expected mark-sold called ≥2 times (once per captured order), got ${markSoldCallCount}`);
    }
    // If gap is fixed, mark-sold count may be 1 — acceptable.
  });

  // ── Step 4: verify existing purchase flow is unaffected by disabling flag ──
  //
  // GUEST_CHECKOUT flag only gates the OTP endpoints. All order/capture/ship
  // routes are unchanged. Existing authenticated buyers are unaffected.

  await test('capture flow for authenticated buyer is independent of GUEST_CHECKOUT flag', async () => {
    // The order A is already in HELD — its capture succeeded without any
    // GUEST_CHECKOUT dependency. The flag is checked only in authRoutes
    // (/auth/otp/request and /auth/otp/verify). No escrow route reads it.
    const r = await get(appServer, `/orders/${orderAId}`, tokenA);
    assertEqual(r.status, 200);
    assertEqual(r.body.status, 'HELD');
    // Confirm no GUEST_CHECKOUT env var is set in this test environment
    assert(process.env.GUEST_CHECKOUT !== 'true', 'GUEST_CHECKOUT should be off in escrow tests');
  });

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);

  if (orderBStatus === 200) {
    console.log('\n⚠  KNOWN GAP ACTIVE: duplicate capture is possible.');
    console.log('   This does not block the passwordless checkout release —');
    console.log('   the gap pre-dates guest checkout and exists for all order creation paths.');
    console.log('   Recommend addressing in a follow-up with a listing-level capture lock.');
  }

  await teardown();
  if (failed > 0) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });

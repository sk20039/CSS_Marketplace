// tests/admin.test.js
//
// Standalone test script — no test runner required.
// Run: node tests/admin.test.js
// Exit code 0 = all passed, 1 = any failed.
//
// Tests the admin-only POST /admin/run-recovery endpoint:
//   - Unauthenticated requests are rejected (401)
//   - Authenticated non-admin users are rejected (403)
//   - Admin users can invoke recovery and receive a valid result
//   - Overlapping invocations return the in-process guard result safely
//
// Uses escrow_db_test (PostgreSQL) and the stub Stripe client.
// Introduces artificial stub latency (STRIPE_STUB_LATENCY_MS=50) so that
// two simultaneous HTTP requests genuinely overlap inside runRecovery(),
// making the in-process guard observable at the HTTP layer.

'use strict';

// ---- Must be set before any module load that touches db.js or stripeClient ----
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'change-me'; // explicit: removed || '' fallback in requireAuth
delete process.env.STRIPE_SECRET_KEY;   // force stub mode
process.env.STRIPE_STUB_LATENCY_MS = '50'; // artificial delay so overlapping requests genuinely race

const http = require('http');
const jwt  = require('jsonwebtoken');

const { buildApp }     = require('../src/app');
const pool             = require('../src/db');
const { stripeClient } = require('../src/stripeClient');

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

const JWT_SECRET = process.env.JWT_SECRET || 'change-me';

function makeToken(payload) {
  return jwt.sign(payload, JWT_SECRET);
}

const TOKENS = {
  admin:  makeToken({ sub: '10', email: 'admin@test.test',  role: 'admin'  }),
  buyer:  makeToken({ sub: '11', email: 'buyer@test.test',  role: 'buyer'  }),
  seller: makeToken({ sub: '12', email: 'seller@test.test', role: 'seller' }),
};

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function post(server, urlPath, token) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const options = {
      hostname: '127.0.0.1',
      port: addr.port,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let body;
        try { body = JSON.parse(data); } catch { body = data; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

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
// DB setup
// ---------------------------------------------------------------------------

let BUYER_ID, SELLER_ID, LISTING_ID;
const TEST_ACCT = 'acct_test_release_recovery';

async function setupDb() {
  await pool.query(`
    TRUNCATE reviews, messages, order_events, orders, listings, users
    RESTART IDENTITY CASCADE
  `);

  const { rows: [buyer] } = await pool.query(
    `INSERT INTO users (name, email, role) VALUES ('Demo Buyer', 'buyer@demo.test', 'buyer') RETURNING id`
  );
  const { rows: [seller] } = await pool.query(
    `INSERT INTO users (name, email, role, stripe_account_id)
     VALUES ('Demo Seller', 'seller@demo.test', 'seller', $1) RETURNING id`,
    [TEST_ACCT]
  );
  const { rows: [listing] } = await pool.query(
    `INSERT INTO listings (seller_id, title, price_cents) VALUES ($1, 'Demo Item', 5000) RETURNING id`,
    [seller.id]
  );

  BUYER_ID  = buyer.id;
  SELLER_ID = seller.id;
  LISTING_ID = listing.id;
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server;

function startServer() {
  return new Promise((resolve) => {
    const app = buildApp();
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function stopServer() {
  return new Promise((resolve) => server.close(resolve));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runAdminRecoveryTests() {
  console.log('\nPOST /admin/run-recovery — authentication and authorization');

  await test('unauthenticated request (no Authorization header) is rejected with 401', async () => {
    const res = await post(server, '/admin/run-recovery', null);
    assertEqual(res.status, 401, `expected 401, got ${res.status}`);
    assert(res.body.error, 'response must include an error field');
  });

  await test('request with a malformed token is rejected with 401', async () => {
    const res = await post(server, '/admin/run-recovery', 'not.a.valid.token');
    assertEqual(res.status, 401, `expected 401, got ${res.status}`);
  });

  await test('authenticated buyer is rejected with 403', async () => {
    const res = await post(server, '/admin/run-recovery', TOKENS.buyer);
    assertEqual(res.status, 403, `expected 403, got ${res.status}`);
    assert(res.body.error, 'response must include an error field');
  });

  await test('authenticated seller is rejected with 403', async () => {
    const res = await post(server, '/admin/run-recovery', TOKENS.seller);
    assertEqual(res.status, 403, `expected 403, got ${res.status}`);
  });

  await test('admin receives 200 with a valid recovery result shape', async () => {
    const res = await post(server, '/admin/run-recovery', TOKENS.admin);
    assertEqual(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    const b = res.body;
    if (b.skipped) {
      assert(b.skipped === true, 'skipped must be boolean true');
    } else {
      assert('checkedAt'          in b, 'result must include checkedAt');
      assert('candidateCount'     in b, 'result must include candidateCount');
      assert(Array.isArray(b.recoveredOrderIds), 'recoveredOrderIds must be an array');
      assert(Array.isArray(b.ambiguous),          'ambiguous must be an array');
      assert(Array.isArray(b.failed),             'failed must be an array');
    }
  });

  await test('admin can invoke recovery multiple times and each response is 200', async () => {
    const r1 = await post(server, '/admin/run-recovery', TOKENS.admin);
    const r2 = await post(server, '/admin/run-recovery', TOKENS.admin);
    assertEqual(r1.status, 200, `first call: expected 200, got ${r1.status}`);
    assertEqual(r2.status, 200, `second call: expected 200, got ${r2.status}`);
  });

  console.log('\nPOST /admin/run-recovery — in-process overlap guard');

  await test('two simultaneous admin requests return 200 — one runs, other returns guard result safely', async () => {
    const pi = await stripeClient.createPaymentIntent({ amountCents: 5000, currency: 'usd', metadata: {} });
    const staleTs = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const now     = new Date().toISOString();

    await pool.query(
      `INSERT INTO orders (
         listing_id, buyer_id, seller_id, amount_cents, platform_fee_cents, seller_payout_cents,
         status, stripe_payment_intent_id, prior_status, transition_started_at,
         recovery_claimed_at, recovery_attempts, created_at, updated_at
       ) VALUES ($1,$2,$3,5000,150,4850,'CAPTURING',$4,'CREATED',$5,NULL,0,$6,$7)`,
      [LISTING_ID, BUYER_ID, SELLER_ID, pi.id, staleTs, now, now]
    );

    const [r1, r2] = await Promise.all([
      post(server, '/admin/run-recovery', TOKENS.admin),
      post(server, '/admin/run-recovery', TOKENS.admin),
    ]);

    assertEqual(r1.status, 200, `request 1: expected 200, got ${r1.status}`);
    assertEqual(r2.status, 200, `request 2: expected 200, got ${r2.status}`);

    const bodies = [r1.body, r2.body];

    assert(
      bodies.some((b) => !b.skipped && 'candidateCount' in b),
      'at least one of the two requests must have performed a real sweep'
    );

    assert(
      bodies.some((b) => b.skipped === true),
      'at least one of the two requests must have returned the in-process guard result {skipped:true}'
    );
  });

  // -------------------------------------------------------------------------
  // RELEASING reconciliation — stub transfer-group lookup + fallback
  // -------------------------------------------------------------------------

  console.log('\nPOST /admin/run-recovery — RELEASING reconciliation (stub)');

  // Helper: capture a stub PI and insert a stale RELEASING order backed by it.
  async function makeReleasingOrder() {
    const pi = await stripeClient.createPaymentIntent({ amountCents: 500, currency: 'usd', metadata: {} });
    const captured = await stripeClient.capturePaymentIntent(pi.id, {});
    const staleTs = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const { rows: [row] } = await pool.query(
      `INSERT INTO orders (
         listing_id, buyer_id, seller_id, amount_cents, platform_fee_cents, seller_payout_cents,
         status, stripe_payment_intent_id, stripe_charge_id, prior_status, transition_started_at,
         recovery_claimed_at, recovery_attempts, created_at, updated_at
       ) VALUES ($1,$2,$3,500,15,485,'RELEASING',$4,$5,'DELIVERED',$6,NULL,0,$7,$8)
       RETURNING id`,
      [LISTING_ID, BUYER_ID, SELLER_ID, pi.id, captured.chargeId, staleTs, now, now]
    );
    return { orderId: row.id, chargeId: captured.chargeId };
  }

  await test('RELEASING: transfer found by transfer_group → finalized, no new transfer created', async () => {
    const { orderId, chargeId } = await makeReleasingOrder();
    const tg = `order_${orderId}`;
    const existing = {
      id: `tr_group_${orderId}`,
      transferGroup: tg,
      sourceTransactionId: chargeId,
      amountCents: 485,
      currency: 'usd',
      destination: TEST_ACCT,
      metadata: { orderId: String(orderId), operationType: 'release' },
      status: 'paid',
    };
    stripeClient._transfers.push(existing);
    const countAfterSetup = stripeClient._transfers.length;

    const res = await post(server, '/admin/run-recovery', TOKENS.admin);
    assertEqual(res.status, 200, `expected 200, got ${res.status}`);
    assert(res.body.recoveredOrderIds.includes(orderId), `order ${orderId} must appear in recoveredOrderIds`);
    assertEqual(stripeClient._transfers.length, countAfterSetup, 'no new Stripe transfer must be created');

    const { rows: [row] } = await pool.query('SELECT status, stripe_transfer_id FROM orders WHERE id = $1', [orderId]);
    assertEqual(row.status, 'RELEASED', 'order must be RELEASED');
    assertEqual(row.stripe_transfer_id, existing.id, 'transfer id must match the pre-existing transfer');
  });

  await test('RELEASING: older transfer (no transfer_group) found via destination fallback → finalized', async () => {
    const { orderId, chargeId } = await makeReleasingOrder();
    const oldTransfer = {
      id: `tr_old_${orderId}`,
      transferGroup: null,
      sourceTransactionId: chargeId,
      amountCents: 485,
      currency: 'usd',
      destination: TEST_ACCT,
      metadata: { orderId: String(orderId), operationType: 'release' },
      status: 'paid',
    };
    stripeClient._transfers.push(oldTransfer);
    const countAfterSetup = stripeClient._transfers.length;

    const res = await post(server, '/admin/run-recovery', TOKENS.admin);
    assertEqual(res.status, 200, `expected 200, got ${res.status}`);
    assert(res.body.recoveredOrderIds.includes(orderId), `order ${orderId} must appear in recoveredOrderIds`);
    assertEqual(stripeClient._transfers.length, countAfterSetup, 'no new Stripe transfer must be created');

    const { rows: [row] } = await pool.query('SELECT status, stripe_transfer_id FROM orders WHERE id = $1', [orderId]);
    assertEqual(row.status, 'RELEASED', 'order must be RELEASED');
    assertEqual(row.stripe_transfer_id, oldTransfer.id, 'transfer id must match the old-style transfer');
  });

  await test('RELEASING: multiple matching transfers → ambiguous, order stays RELEASING', async () => {
    const { orderId, chargeId } = await makeReleasingOrder();
    const tg = `order_${orderId}`;
    for (let i = 0; i < 2; i++) {
      stripeClient._transfers.push({
        id: `tr_dup${i}_${orderId}`,
        transferGroup: tg,
        sourceTransactionId: chargeId,
        amountCents: 485,
        currency: 'usd',
        destination: TEST_ACCT,
        metadata: { orderId: String(orderId), operationType: 'release' },
        status: 'paid',
      });
    }

    const res = await post(server, '/admin/run-recovery', TOKENS.admin);
    assertEqual(res.status, 200, `expected 200, got ${res.status}`);
    assert(
      res.body.ambiguous.some((a) => a.orderId === orderId),
      `order ${orderId} must appear in ambiguous`
    );

    const { rows: [row] } = await pool.query('SELECT status FROM orders WHERE id = $1', [orderId]);
    assertEqual(row.status, 'RELEASING', 'order must remain RELEASING when ambiguous');
  });

  await test('RELEASING: no existing transfer → new transfer issued via idempotent createTransfer', async () => {
    const { orderId } = await makeReleasingOrder();
    const tg = `order_${orderId}`;
    const countBefore = stripeClient._transfers.filter((t) => t.transferGroup === tg).length;
    assertEqual(countBefore, 0, 'must start with no transfers for this order group');

    const res = await post(server, '/admin/run-recovery', TOKENS.admin);
    assertEqual(res.status, 200, `expected 200, got ${res.status}`);
    assert(res.body.recoveredOrderIds.includes(orderId), `order ${orderId} must appear in recoveredOrderIds`);

    const created = stripeClient._transfers.filter((t) => t.transferGroup === tg);
    assertEqual(created.length, 1, 'exactly one transfer must be created');
    assertEqual(created[0].amountCents, 485, 'transfer amount must be seller payout');
    assertEqual(created[0].destination, TEST_ACCT, 'transfer must go to seller account');
    assertEqual(created[0].metadata.orderId, String(orderId), 'transfer metadata must carry orderId');
    assertEqual(created[0].metadata.operationType, 'release', 'transfer metadata must carry operationType');

    const { rows: [row] } = await pool.query('SELECT status, stripe_transfer_id FROM orders WHERE id = $1', [orderId]);
    assertEqual(row.status, 'RELEASED', 'order must be RELEASED');
    assertEqual(row.stripe_transfer_id, created[0].id, 'order must record the new transfer id');
  });

  console.log('\nPOST /admin/run-release-check — confirm existing endpoint unchanged');

  await test('unauthenticated request to run-release-check is rejected with 401', async () => {
    const res = await post(server, '/admin/run-release-check', null);
    assertEqual(res.status, 401, `expected 401, got ${res.status}`);
  });

  await test('admin can still invoke run-release-check after adding run-recovery', async () => {
    const res = await post(server, '/admin/run-release-check', TOKENS.admin);
    assertEqual(res.status, 200, `expected 200, got ${res.status}`);
    assert('candidateCount' in res.body, 'release-check result must include candidateCount');
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  console.log('=== Admin Endpoint Tests ===');

  await setupDb();
  await startServer();

  try {
    await runAdminRecoveryTests();
  } finally {
    await stopServer();
    await pool.end();
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();

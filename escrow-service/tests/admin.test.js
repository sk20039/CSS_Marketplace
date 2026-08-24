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
// Uses a temporary SQLite database and the stub Stripe client.
// Introduces artificial stub latency (STRIPE_STUB_LATENCY_MS=50) so that
// two simultaneous HTTP requests genuinely overlap inside runRecovery(),
// making the in-process guard observable at the HTTP layer.

'use strict';

// ---- Must be set before any module load that touches db.js or stripeClient ----
const path = require('path');
const os   = require('os');
const fs   = require('fs');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.sqlite3');
delete process.env.STRIPE_SECRET_KEY;   // force stub mode
process.env.STRIPE_STUB_LATENCY_MS = '50'; // artificial delay so overlapping requests genuinely race

const http = require('http');
const jwt  = require('jsonwebtoken');

const { buildApp } = require('../src/app');
const db            = require('../src/db');
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
    // Either a normal result or a skipped guard result — both are valid
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
    // The in-process guard (recoveryInProgress flag) is only observable under HTTP
    // concurrency when the first sweep is genuinely awaiting an async operation.
    // We ensure this by inserting a stale CAPTURING order backed by a real stub PI.
    // With STRIPE_STUB_LATENCY_MS=50, the first sweep suspends for 50ms at
    // stripeClient.getPaymentIntent(). During that window, the event loop
    // processes the second HTTP request, which sees recoveryInProgress=true.
    const pi = await stripeClient.createPaymentIntent({ amountCents: 5000, currency: 'usd', metadata: {} });
    const buyer  = db.prepare("SELECT id FROM users WHERE email = 'buyer@demo.test'").get();
    const seller = db.prepare("SELECT id FROM users WHERE email = 'seller@demo.test'").get();
    const listing = db.prepare('SELECT id FROM listings LIMIT 1').get();
    const staleTs = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const now     = new Date().toISOString();
    db.prepare(`
      INSERT INTO orders (
        listing_id, buyer_id, seller_id, amount_cents, platform_fee_cents, seller_payout_cents,
        status, stripe_payment_intent_id, prior_status, transition_started_at,
        recovery_claimed_at, recovery_attempts, created_at, updated_at
      ) VALUES (
        ?, ?, ?, 5000, 150, 4850,
        'CAPTURING', ?, 'CREATED', ?,
        NULL, 0, ?, ?
      )
    `).run(listing.id, buyer.id, seller.id, pi.id, staleTs, now, now);

    // Fire both requests simultaneously. The first will claim the candidate and
    // enter the 50ms Stripe latency window. The second will see the guard flag.
    const [r1, r2] = await Promise.all([
      post(server, '/admin/run-recovery', TOKENS.admin),
      post(server, '/admin/run-recovery', TOKENS.admin),
    ]);

    assertEqual(r1.status, 200, `request 1: expected 200, got ${r1.status}`);
    assertEqual(r2.status, 200, `request 2: expected 200, got ${r2.status}`);

    const bodies = [r1.body, r2.body];

    // At least one must have performed a real sweep
    assert(
      bodies.some((b) => !b.skipped && 'candidateCount' in b),
      'at least one of the two requests must have performed a real sweep'
    );

    // At least one must have been skipped — confirms the guard result flows through to HTTP 200
    assert(
      bodies.some((b) => b.skipped === true),
      'at least one of the two requests must have returned the in-process guard result {skipped:true}'
    );
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

  await startServer();

  try {
    await runAdminRecoveryTests();
  } finally {
    await stopServer();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();

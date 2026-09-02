// tests/security.test.js
//
// Standalone test — no test runner required.
// Run: node tests/security.test.js
// Exit code 0 = all passed, 1 = any failed.
//
// Covers:
//   - Rate limits on order creation, dispute filing, order messages,
//     admin dispute resolution, admin recovery — allowed requests succeed,
//     excess requests return 429, limits are independent per endpoint.
//   - Message body validation: empty → 400, >2,000 chars → 400,
//     exactly 2,000 chars → 201, whitespace-only → 400.
//   - Health endpoints are never rate-limited.
//   - Trusted proxy (trust proxy: 1): two clients with different
//     X-Forwarded-For IPs receive separate limit buckets; a client that has
//     exhausted its limit cannot bypass it by injecting a fake IP prefix into
//     the XFF header — Express reads only the entry set by the last trusted
//     hop (Railway's proxy), not client-supplied prefixes.
//   - No Stripe calls: STRIPE_SECRET_KEY is deleted (stub mode only).
//
// Rate limits are configured via env vars so this test can use small
// values (TEST_RATE_LIMIT = 3) without affecting production defaults.
//
// Prerequisites: DATABASE_URL_TEST pointing at escrow_db_test with
// migrations applied (same requirement as escrow.test.js).

'use strict';

// ---- Must be set before any src/ module is required ----
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
process.env.JWT_SECRET   = process.env.JWT_SECRET || 'change-me';
delete process.env.STRIPE_SECRET_KEY; // force stub mode — no real Stripe calls

// Set all rate limits to 3 for this test process.
// buildApp() reads these at call time, so each new server gets limit=3.
const TEST_LIMIT = '3';
process.env.RATE_LIMIT_ORDER_CREATE_MAX  = TEST_LIMIT;
process.env.RATE_LIMIT_DISPUTE_MAX       = TEST_LIMIT;
process.env.RATE_LIMIT_MESSAGE_MAX       = TEST_LIMIT;
process.env.RATE_LIMIT_ADMIN_RESOLVE_MAX = TEST_LIMIT;
process.env.RATE_LIMIT_ADMIN_RECOVERY_MAX = TEST_LIMIT;

const http = require('http');
const jwt  = require('jsonwebtoken');
const { makeRateToken } = require('../src/shippoClient');

// Stub shipping constants (must match STUB_RATES in shippoClient.js)
const STUB_RATE_ID        = 'stub_rate_usps_first_class';
const SELLER_SHIP_ZIP     = '77001';
const TEST_PARCEL         = { weight_oz: 64, length_in: 36, width_in: 6, height_in: 6 };

// ---- Mock listing-service (needed for message validation tests) ----

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
  } else if (req.method === 'PATCH' && /^\/listings\/\d+\/mark-sold$/.test(req.url)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } else if (req.method === 'PATCH' && /^\/listings\/\d+\/mark-active$/.test(req.url)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});

// ---- Lazy-loaded src modules (after env vars are set) ----
let buildApp, pool;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';

// ---- Test harness ----

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  \u2713  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  \u2717  ${name}`);
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

// ---- HTTP helpers ----

// extraHeaders: optional object of additional HTTP headers to include.
// Used in proxy tests to set X-Forwarded-For to a specific client IP.
function request(server, method, urlPath, token, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const addr    = server.address();
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const options = {
      hostname: '127.0.0.1',
      port:     addr.port,
      path:     urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(token  ? { Authorization: `Bearer ${token}` } : {}),
        ...(extraHeaders || {}),
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

const get  = (s, p, t, xh)    => request(s, 'GET',  p, t, undefined, xh);
const post = (s, p, t, b, xh) => request(s, 'POST', p, t, b, xh);

// ---- Server lifecycle helpers ----

function startServer() {
  return new Promise((resolve) => {
    const app    = buildApp();
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

// ---- Token factory ----

function makeToken(id, role) {
  return jwt.sign({ sub: String(id), email: `${role}@sec.test`, role }, JWT_SECRET);
}

// ============================================================
// Phase 1: Rate limit tests
// Each test group starts a fresh server (fresh in-memory counters).
// Requests are sent WITHOUT auth — the rate limiter fires before
// requireAuth, so unauthenticated requests still count and get 429.
// "Allowed" means status !== 429; "excess" means status === 429.
// ============================================================

async function runRateLimitTests() {
  console.log('\nRate limiting — order creation (limit=' + TEST_LIMIT + '/15 min)');

  {
    const server = await startServer();
    try {
      await test('first 3 order creation requests are not rate-limited (return 401, not 429)', async () => {
        for (let i = 0; i < 3; i++) {
          const res = await post(server, '/orders', null, { listing_id: 1 });
          assert(res.status !== 429, `request ${i + 1} should not be rate-limited, got ${res.status}`);
        }
      });

      await test('4th order creation request returns 429', async () => {
        const res = await post(server, '/orders', null, { listing_id: 1 });
        assertEqual(res.status, 429, `expected 429, got ${res.status}`);
        assert(res.body.error, 'response must include error field');
      });
    } finally {
      await stopServer(server);
    }
  }

  console.log('\nRate limiting — dispute filing (limit=' + TEST_LIMIT + '/15 min)');

  {
    const server = await startServer();
    try {
      await test('first 3 dispute requests are not rate-limited', async () => {
        for (let i = 0; i < 3; i++) {
          const res = await post(server, '/orders/999/dispute', null, { reason: 'test' });
          assert(res.status !== 429, `request ${i + 1} should not be rate-limited, got ${res.status}`);
        }
      });

      await test('4th dispute request returns 429', async () => {
        const res = await post(server, '/orders/999/dispute', null, { reason: 'test' });
        assertEqual(res.status, 429, `expected 429, got ${res.status}`);
        assert(res.body.error, 'response must include error field');
      });
    } finally {
      await stopServer(server);
    }
  }

  console.log('\nRate limiting — order messages (limit=' + TEST_LIMIT + '/15 min)');

  {
    const server = await startServer();
    try {
      await test('first 3 message requests are not rate-limited', async () => {
        for (let i = 0; i < 3; i++) {
          const res = await post(server, '/orders/999/messages', null, { body: 'hi' });
          assert(res.status !== 429, `request ${i + 1} should not be rate-limited, got ${res.status}`);
        }
      });

      await test('4th message request returns 429', async () => {
        const res = await post(server, '/orders/999/messages', null, { body: 'hi' });
        assertEqual(res.status, 429, `expected 429, got ${res.status}`);
        assert(res.body.error, 'response must include error field');
      });
    } finally {
      await stopServer(server);
    }
  }

  console.log('\nRate limiting — admin dispute resolution (limit=' + TEST_LIMIT + '/15 min)');

  {
    const server = await startServer();
    try {
      await test('first 3 admin resolve requests are not rate-limited', async () => {
        for (let i = 0; i < 3; i++) {
          const res = await post(server, '/admin/orders/999/resolve', null, { action: 'refund' });
          assert(res.status !== 429, `request ${i + 1} should not be rate-limited, got ${res.status}`);
        }
      });

      await test('4th admin resolve request returns 429', async () => {
        const res = await post(server, '/admin/orders/999/resolve', null, { action: 'refund' });
        assertEqual(res.status, 429, `expected 429, got ${res.status}`);
        assert(res.body.error, 'response must include error field');
      });
    } finally {
      await stopServer(server);
    }
  }

  console.log('\nRate limiting — admin recovery (limit=' + TEST_LIMIT + '/15 min)');

  {
    const server = await startServer();
    try {
      await test('first 3 admin recovery requests are not rate-limited', async () => {
        for (let i = 0; i < 3; i++) {
          const res = await post(server, '/admin/run-recovery', null);
          assert(res.status !== 429, `request ${i + 1} should not be rate-limited, got ${res.status}`);
        }
      });

      await test('4th admin recovery request returns 429', async () => {
        const res = await post(server, '/admin/run-recovery', null);
        assertEqual(res.status, 429, `expected 429, got ${res.status}`);
        assert(res.body.error, 'response must include error field');
      });
    } finally {
      await stopServer(server);
    }
  }
}

// ============================================================
// Phase 2: Limit independence
// Exhaust one endpoint's limit, confirm a different endpoint
// is still under its own independent limit.
// ============================================================

async function runIndependenceTests() {
  console.log('\nRate limit independence');

  {
    const server = await startServer();
    try {
      await test('exhausting dispute limit does not affect order creation limit', async () => {
        // Exhaust the dispute limiter (fire 4 requests → 4th is 429)
        for (let i = 0; i < 3; i++) {
          await post(server, '/orders/1/dispute', null, { reason: 'x' });
        }
        const exceeded = await post(server, '/orders/1/dispute', null, { reason: 'x' });
        assertEqual(exceeded.status, 429, 'dispute limit must be exhausted');

        // Order creation limiter should be untouched (0 requests sent to it)
        const orderRes = await post(server, '/orders', null, { listing_id: 1 });
        assert(orderRes.status !== 429,
          `order creation must not be rate-limited after exhausting dispute limit, got ${orderRes.status}`);
      });

      await test('exhausting message limit does not affect admin recovery limit', async () => {
        // Exhaust message limiter
        for (let i = 0; i < 3; i++) {
          await post(server, '/orders/1/messages', null, { body: 'hi' });
        }
        const exceeded = await post(server, '/orders/1/messages', null, { body: 'hi' });
        assertEqual(exceeded.status, 429, 'message limit must be exhausted');

        // Admin recovery limiter untouched
        const recRes = await post(server, '/admin/run-recovery', null);
        assert(recRes.status !== 429,
          `admin recovery must not be rate-limited after exhausting message limit, got ${recRes.status}`);
      });
    } finally {
      await stopServer(server);
    }
  }
}

// ============================================================
// Phase 3: Message body validation
// Needs full DB + mock listing-service + auth token.
// Uses limit=3, but validation tests only need 4 message requests.
// We use a fresh server and send the validation requests first,
// before hitting the rate limit.
// ============================================================

async function runMessageValidationTests() {
  console.log('\nMessage body validation');

  // Bump message limit to 10 for this server so validation tests don't
  // accidentally hit the rate limit instead of the validation check.
  process.env.RATE_LIMIT_MESSAGE_MAX = '10';
  const server = await startServer();
  process.env.RATE_LIMIT_MESSAGE_MAX = TEST_LIMIT; // restore for subsequent servers

  let buyerId, sellerId;
  let buyerToken, sellerToken;
  let heldOrderId;

  try {
    // Seed DB
    await pool.query(`
      TRUNCATE reviews, messages, order_events, orders, listings, users
      RESTART IDENTITY CASCADE
    `);
    const { rows: [buyer] } = await pool.query(
      `INSERT INTO users (name, email, role) VALUES ('Sec Buyer', 'sec_buyer@test', 'buyer') RETURNING id`
    );
    const { rows: [seller] } = await pool.query(
      `INSERT INTO users (name, email, role, stripe_account_id, ship_from_address)
       VALUES ('Sec Seller', 'sec_seller@test', 'seller', 'acct_stub_sec', $1) RETURNING id`,
      [JSON.stringify({ name: 'Sec Seller', line1: '1 Seller Rd', city: 'Houston', state: 'TX', zip: SELLER_SHIP_ZIP, phone: '5550001111' })]
    );
    buyerId  = buyer.id;
    sellerId = seller.id;
    buyerToken  = makeToken(buyerId, 'buyer');
    sellerToken = makeToken(sellerId, 'seller');

    // Configure mock listing
    mockListing = {
      id: 888,
      seller_id: sellerId,
      title: 'Security Test Bat',
      price_cents: 5000,
      status: 'active',
      weight_oz:     TEST_PARCEL.weight_oz,
      pkg_length_in: TEST_PARCEL.length_in,
      pkg_width_in:  TEST_PARCEL.width_in,
      pkg_height_in: TEST_PARCEL.height_in,
    };

    // Drive order to HELD state via API (stub Stripe, no real calls)
    const secAddr = { name: 'Sec Buyer', line1: '1 Test St', city: 'Austin', state: 'TX', zip: '78701' };
    const rateToken = makeRateToken(STUB_RATE_ID, 888, SELLER_SHIP_ZIP, secAddr, TEST_PARCEL);
    const created = await post(server, '/orders', buyerToken, {
      listing_id: 888,
      shipping_address: secAddr,
      shippo_rate_id: STUB_RATE_ID,
      rate_token: rateToken,
    });
    assertEqual(created.status, 201, `createOrder failed: ${JSON.stringify(created.body)}`);
    const captured = await post(server, `/orders/${created.body.id}/capture`, buyerToken);
    assertEqual(captured.status, 200, `capture failed: ${JSON.stringify(captured.body)}`);
    heldOrderId = created.body.id;

    await test('empty message body returns 400', async () => {
      const res = await post(server, `/orders/${heldOrderId}/messages`, buyerToken, { body: '' });
      assertEqual(res.status, 400, `expected 400, got ${res.status}`);
      assert(res.body.error, 'response must include error field');
    });

    await test('whitespace-only message body returns 400', async () => {
      const res = await post(server, `/orders/${heldOrderId}/messages`, buyerToken, { body: '   ' });
      assertEqual(res.status, 400, `expected 400, got ${res.status}`);
    });

    await test('message body of 2,001 characters returns 400', async () => {
      const oversized = 'a'.repeat(2001);
      const res = await post(server, `/orders/${heldOrderId}/messages`, buyerToken, { body: oversized });
      assertEqual(res.status, 400, `expected 400, got ${res.status}`);
      assert(res.body.error, 'response must include error field');
    });

    await test('message body of exactly 2,000 characters succeeds with 201', async () => {
      const exact = 'a'.repeat(2000);
      const res = await post(server, `/orders/${heldOrderId}/messages`, buyerToken, { body: exact });
      assertEqual(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
      assertEqual(res.body.body.length, 2000, 'stored body must be 2,000 chars');
    });

  } finally {
    await stopServer(server);
  }
}

// ============================================================
// Phase 4: Health checks are never rate-limited
// ============================================================

async function runHealthTests() {
  console.log('\nHealth checks unaffected by rate limiting');

  const server = await startServer();
  try {
    await test('GET /health/live returns 200 regardless of other traffic', async () => {
      // Send more requests than the rate limit to verify health is exempt
      for (let i = 0; i < 6; i++) {
        const res = await get(server, '/health/live', null);
        assertEqual(res.status, 200, `/health/live request ${i + 1} must return 200, got ${res.status}`);
        assert(res.body.ok === true, 'ok must be true');
      }
    });

    await test('GET /health/ready returns 200 regardless of other traffic', async () => {
      for (let i = 0; i < 6; i++) {
        const res = await get(server, '/health/ready', null);
        assertEqual(res.status, 200, `/health/ready request ${i + 1} must return 200, got ${res.status}`);
      }
    });

    await test('health endpoints not affected after order creation limit is exhausted', async () => {
      // Exhaust order creation limiter on this server
      for (let i = 0; i < 4; i++) {
        await post(server, '/orders', null, { listing_id: 1 });
      }
      // Verify health is still 200
      const live  = await get(server, '/health/live',  null);
      const ready = await get(server, '/health/ready', null);
      assertEqual(live.status,  200, `health/live must still be 200, got ${live.status}`);
      assertEqual(ready.status, 200, `health/ready must still be 200, got ${ready.status}`);
    });
  } finally {
    await stopServer(server);
  }
}

// ============================================================
// Phase 6: Trusted proxy — per-IP isolation and spoof prevention
//
// trust proxy: 1 tells Express to trust exactly one XFF hop (Railway).
// Express uses proxy-addr internally:
//
//   addrs = [remoteAddr, ...xffEntriesRightToLeft]
//   walk left-to-right while address is within the trusted hop count;
//   return the first non-trusted address.
//
// Single XFF "10.0.0.1" + remoteAddr "127.0.0.1" (1 trusted hop):
//   addrs = [127.0.0.1, 10.0.0.1]  →  req.ip = 10.0.0.1  ✓
//
// Spoofed XFF "evil, 10.0.0.1" + remoteAddr "127.0.0.1":
//   addrs = [127.0.0.1, 10.0.0.1, evil]
//   127.0.0.1 trusted (hop 1), 10.0.0.1 not trusted → req.ip = 10.0.0.1  ✓
//   The "evil" prefix is never reached; the fake IP is ignored.
//
// In production Railway sets the rightmost XFF entry before forwarding;
// client-supplied prefixes become irrelevant. In tests the test process
// plays the role of Railway by setting the XFF header directly.
// ============================================================

async function runProxyTests() {
  console.log('\nTrusted proxy — per-IP isolation and spoof prevention');

  {
    const server = await startServer();
    try {
      await test('two clients with different X-Forwarded-For IPs have separate limit buckets', async () => {
        // Exhaust the order-creation limit for client A (10.0.0.1).
        for (let i = 0; i < 3; i++) {
          const res = await post(server, '/orders', null, { listing_id: 1 }, { 'X-Forwarded-For': '10.0.0.1' });
          assert(res.status !== 429, `client A request ${i + 1} should not be 429, got ${res.status}`);
        }
        const exceeded = await post(server, '/orders', null, { listing_id: 1 }, { 'X-Forwarded-For': '10.0.0.1' });
        assertEqual(exceeded.status, 429, `client A 4th request must be 429, got ${exceeded.status}`);

        // Client B (10.0.0.2) has its own bucket and must not be affected.
        const clientB = await post(server, '/orders', null, { listing_id: 1 }, { 'X-Forwarded-For': '10.0.0.2' });
        assert(clientB.status !== 429,
          `client B must not be rate-limited by client A exhaustion, got ${clientB.status}`);
      });

      await test('client cannot bypass exhausted limit by injecting a fake IP prefix in X-Forwarded-For', async () => {
        // Exhaust dispute limit for 10.0.0.3.
        for (let i = 0; i < 3; i++) {
          await post(server, '/orders/999/dispute', null, { reason: 'test' }, { 'X-Forwarded-For': '10.0.0.3' });
        }
        const exceeded = await post(server, '/orders/999/dispute', null, { reason: 'test' }, { 'X-Forwarded-For': '10.0.0.3' });
        assertEqual(exceeded.status, 429, 'dispute limit for 10.0.0.3 must be exhausted');

        // Spoof attempt: client prefixes a fake IP to its real IP.
        // This simulates what Railway would forward if the client sent
        // "X-Forwarded-For: 9.9.9.9" and Railway appended "10.0.0.3".
        // With trust proxy: 1, Express reads the rightmost non-proxy entry
        // (10.0.0.3) and ignores the fake prefix (9.9.9.9).
        const spoofed = await post(server, '/orders/999/dispute', null, { reason: 'test' },
          { 'X-Forwarded-For': '9.9.9.9, 10.0.0.3' });
        assertEqual(spoofed.status, 429,
          `spoofed XFF must not bypass the exhausted limit for 10.0.0.3, got ${spoofed.status}`);
      });
    } finally {
      await stopServer(server);
    }
  }
}

// ============================================================
// Phase 5: Confirm stub mode (no Stripe calls)
// ============================================================

async function runStubModeTest() {
  console.log('\nNo Stripe calls (stub mode)');

  await test('Stripe client operates in stub mode throughout all tests', async () => {
    // STRIPE_SECRET_KEY was deleted at the top of this file.
    // Requiring the client now must return the stub.
    const { stripeClient } = require('../src/stripeClient');
    assertEqual(stripeClient.mode, 'stub', 'Stripe client must be in stub mode');
  });
}

// ============================================================
// Main
// ============================================================

(async () => {
  console.log('=== Security Tests ===');

  // Start mock listing server and configure LISTING_SERVICE_URL before
  // loading src/ modules.
  await new Promise((resolve) => mockListingServer.listen(0, '127.0.0.1', resolve));
  process.env.LISTING_SERVICE_URL = `http://127.0.0.1:${mockListingServer.address().port}`;

  // Load src/ modules (after env vars and mock server are ready)
  pool     = require('../src/db');
  buildApp = require('../src/app').buildApp;

  try {
    await runRateLimitTests();
    await runIndependenceTests();
    await runMessageValidationTests();
    await runHealthTests();
    await runProxyTests();
    await runStubModeTest();
  } finally {
    await new Promise((resolve) => mockListingServer.close(resolve));
    await pool.end();
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();

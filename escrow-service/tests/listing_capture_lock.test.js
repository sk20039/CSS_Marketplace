// tests/listing_capture_lock.test.js
//
// Verifies the one_active_order_per_listing unique partial index fix.
// Requires migration 1791720000000_listing_capture_lock to be applied to escrow_db_test.
//
// Run: node tests/listing_capture_lock.test.js
// Exit 0 = all pass, 1 = any fail.
//
// No live charges — stub Stripe mode only.
//
// Coverage:
//   1. Sequential second capture is rejected 409 after first is HELD
//   2. Concurrent capture: exactly one 200, exactly one 409 (no double-charge)
//   3. After revert (Stripe failure), the order can be retried
//   4. A CANCELLED order does not block a new order for the same listing
//   5. Index exists in pg_indexes

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ||
  'postgres://escrow_user:escrow_pass@127.0.0.1:5432/escrow_db_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'change-me';
delete process.env.STRIPE_SECRET_KEY; // stub mode — no charges

const http = require('http');
const jwt  = require('jsonwebtoken');

// ── Mock listing-service ─────────────────────────────────────────────────────

// Each test uses a unique listing_id drawn from this counter to avoid
// cross-test contamination (a HELD order for one test's listing_id would
// block subsequent tests that reuse the same id).
let listingIdCounter = 7100;
function nextListingId() { return ++listingIdCounter; }

let sellerId = null; // set after DB seed

const mockServer = http.createServer((req, res) => {
  if (req.method === 'GET' && /^\/listings\/\d+$/.test(req.url)) {
    const id = parseInt(req.url.split('/')[2], 10);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id, seller_id: sellerId,
      title: 'Capture Lock Test Bat', price_cents: 4500, status: 'active',
      weight_oz: 32, pkg_length_in: 20, pkg_width_in: 5, pkg_height_in: 5,
    }));
  } else if (req.method === 'PATCH' && /mark-sold/.test(req.url)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } else if (req.method === 'PATCH' && /mark-active/.test(req.url)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.writeHead(404); res.end('not found');
  }
});

// ── Harness ──────────────────────────────────────────────────────────────────

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
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEqual(a, b, m) {
  if (a !== b) throw new Error(m || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function req(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const addr    = server.address();
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: '127.0.0.1', port: addr.port, path, method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(token  ? { Authorization: `Bearer ${token}` } : {}),
      },
    };
    const r = http.request(opts, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        let b; try { b = JSON.parse(d); } catch { b = d; }
        resolve({ status: res.statusCode, body: b });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const post = (s, p, t, b) => req(s, 'POST', p, t, b);
const get  = (s, p, t)    => req(s, 'GET',  p, t, null);

const ADDR = { name: 'Lock Buyer', line1: '1 Lock St', city: 'Houston', state: 'TX', zip: '77001' };
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';

// ── State ─────────────────────────────────────────────────────────────────────

let pool, appServer;

async function setup() {
  await new Promise(r => mockServer.listen(0, '127.0.0.1', r));
  process.env.LISTING_SERVICE_URL = `http://127.0.0.1:${mockServer.address().port}`;
  process.env.RATE_LIMIT_ORDER_CREATE_MAX = '500';

  pool = require('../src/db');
  const { buildApp } = require('../src/app');

  await pool.query(`
    TRUNCATE reviews, messages, order_events, orders, listings, users
    RESTART IDENTITY CASCADE
  `);

  const { rows: [s] } = await pool.query(
    `INSERT INTO users (name, email, role, stripe_account_id, ship_from_address)
     VALUES ('Lock Seller','lock_seller@test.invalid','seller','acct_stub_lock',
             '{"name":"Lock Seller","line1":"1 Sell Rd","city":"Houston","state":"TX","zip":"77001","phone":"5550001111"}')
     RETURNING id`
  );
  sellerId = s.id;

  const appInst = buildApp();
  appServer = http.createServer(appInst);
  await new Promise(r => appServer.listen(0, '127.0.0.1', r));
}

async function teardown() {
  await new Promise(r => appServer.close(r));
  await new Promise(r => mockServer.close(r));
  await pool.end();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function newBuyer(tag) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (name, email, role)
     VALUES ($1, $2, 'buyer') RETURNING id`,
    [`Buyer ${tag}`, `lock_buyer_${tag}_${Date.now()}@test.invalid`]
  );
  return {
    id: u.id,
    token: jwt.sign({ sub: String(u.id), email: `lock_buyer_${tag}@test.invalid`, role: 'buyer' }, JWT_SECRET),
  };
}

async function createOrder(token, listingId) {
  const r = await post(appServer, '/orders', token, { listing_id: listingId, shipping_address: ADDR });
  assert(r.status === 201, `createOrder expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.id;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function run() {
  await setup();
  console.log('\nListing capture lock tests (stub Stripe — no charges)\n');

  // ── 0. Index exists ────────────────────────────────────────────────────────
  await test('one_active_order_per_listing index exists in pg_indexes', async () => {
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'orders' AND indexname = 'one_active_order_per_listing'`
    );
    assert(rows.length === 1, 'index not found — run migration 1791720000000_listing_capture_lock first');
  });

  // ── 1. Sequential: second capture blocked after first is HELD ─────────────
  await test('sequential: second capture returns 409 after first order is HELD', async () => {
    const lid = nextListingId();
    const a = await newBuyer('seq_a');
    const b = await newBuyer('seq_b');
    const idA = await createOrder(a.token, lid);
    const idB = await createOrder(b.token, lid);

    const r1 = await post(appServer, `/orders/${idA}/capture`, a.token, {});
    assertEqual(r1.status, 200, `first capture should be 200, got ${r1.status}`);
    assertEqual(r1.body.status, 'HELD');

    const r2 = await post(appServer, `/orders/${idB}/capture`, b.token, {});
    assertEqual(r2.status, 409, `second capture should be 409, got ${r2.status}: ${JSON.stringify(r2.body)}`);
  });

  // ── 2. Concurrent: exactly one wins ───────────────────────────────────────
  await test('concurrent: exactly one of two simultaneous captures succeeds', async () => {
    // Fresh buyers; listing mock still returns status=active so both orders create
    const lid = nextListingId();
    const c = await newBuyer('con_c');
    const d = await newBuyer('con_d');
    const idC = await createOrder(c.token, lid);
    const idD = await createOrder(d.token, lid);

    // Fire both at the same time
    const [rC, rD] = await Promise.all([
      post(appServer, `/orders/${idC}/capture`, c.token, {}),
      post(appServer, `/orders/${idD}/capture`, d.token, {}),
    ]);

    const statuses = [rC.status, rD.status].sort();
    const bodies   = [rC.body?.status, rD.body?.status];

    assert(
      (rC.status === 200 || rD.status === 200),
      `expected one 200, got ${rC.status} and ${rD.status}`
    );
    assert(
      (rC.status === 409 || rD.status === 409),
      `expected one 409, got ${rC.status} and ${rD.status}`
    );
    assert(
      bodies.filter(s => s === 'HELD').length === 1,
      `expected exactly one HELD, got ${JSON.stringify(bodies)}`
    );
    console.log(`     statuses: ${rC.status} / ${rD.status} — exactly one 200 ✓`);
  });

  // ── 3. Retry: a reverted order can capture after a transient failure ───────
  // Simulate: order reaches CAPTURING, then Stripe fails, order reverts to CREATED.
  // The index is not violated (CREATED is excluded from the partial index).
  // A subsequent capture of the same order must succeed.
  await test('retry: order reverted to CREATED can capture after transient Stripe failure', async () => {
    const lid = nextListingId();
    const e = await newBuyer('retry_e');
    const idE = await createOrder(e.token, lid);

    // Manually force the order to CAPTURING then back to CREATED (simulates revert)
    await pool.query(
      `UPDATE orders SET status='CAPTURING', prior_status='CREATED',
       transition_started_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [idE]
    );
    await pool.query(
      `UPDATE orders SET status='CREATED', updated_at=NOW() WHERE id=$1`,
      [idE]
    );

    // Should succeed now (CAPTURING was transient; index entry was removed on revert)
    const r = await post(appServer, `/orders/${idE}/capture`, e.token, {});
    assertEqual(r.status, 200, `retry capture should be 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assertEqual(r.body.status, 'HELD');
  });

  // ── 4. New order allowed after prior order for same listing is CANCELLED ───
  await test('new order can capture after previous order is CANCELLED', async () => {
    const lid = nextListingId();
    const f = await newBuyer('cancel_f');
    const g = await newBuyer('cancel_g');
    const idF = await createOrder(f.token, lid);

    // Capture order F
    const rF = await post(appServer, `/orders/${idF}/capture`, f.token, {});
    assertEqual(rF.status, 200, `F capture expected 200, got ${rF.status}`);

    // Cancel order F (HELD → CANCELLING → CANCELLED)
    const rCancel = await post(appServer, `/orders/${idF}/cancel`, f.token, {});
    assertEqual(rCancel.status, 200, `cancel expected 200, got ${rCancel.status}`);
    assertEqual(rCancel.body.status, 'CANCELLED');

    // Now buyer G can create and capture a new order for the same listing
    const idG = await createOrder(g.token, lid);
    const rG  = await post(appServer, `/orders/${idG}/capture`, g.token, {});
    assertEqual(rG.status, 200, `G capture after cancel expected 200, got ${rG.status}: ${JSON.stringify(rG.body)}`);
    assertEqual(rG.body.status, 'HELD');
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  await teardown();
  if (failed > 0) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });

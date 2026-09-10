// tests/webhook.test.js
//
// Comprehensive tests for POST /webhooks/shippo and handleTrackingWebhook.
//
// Prerequisites:
//   DATABASE_URL_TEST must be set and migrations applied to the test DB:
//     DATABASE_URL=<test_url> node_modules/.bin/node-pg-migrate -m migrations up
//
// Run: node tests/webhook.test.js
// Exit code: 0 = all passed, 1 = any failed.
//
// Coverage:
//   HTTP layer  — URL token auth (valid / invalid / missing)
//   Business logic:
//     PRE_TRANSIT  — tracking update only
//     TRANSIT + HELD + label     → SHIPPED
//     TRANSIT + HELD + no label  → no state change
//     DELIVERED + SHIPPED        → DELIVERED
//     DELIVERED + HELD + label   → HELD → DELIVERED (no TRANSIT scan)
//     RETURNED / FAILURE         → tracking update only
//     Duplicate TRANSIT          → idempotent
//     Duplicate DELIVERED        → idempotent
//     Stale TRANSIT after DELIVERED → no regression
//     Stale PRE_TRANSIT after TRANSIT → tracking_status not regressed
//     DISPUTED  → tracking update only; dispute state preserved
//     Carrier case normalisation (USPS in DB, usps in webhook)
//   Backend protection:
//     Seller cannot manually ship a platform label order → 409
//     Seller CAN manually ship a non-label order → 200
//     Buyer never receives label_url → redacted from GET /orders/:id

'use strict';

// ── ENV setup (must precede all src/ requires) ───────────────────────────────
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
process.env.JWT_SECRET    = process.env.JWT_SECRET || 'change-me';
delete process.env.STRIPE_SECRET_KEY; // force stub Stripe

const TEST_WEBHOOK_TOKEN = 'test-webhook-token-for-unit-tests-32chars!';
process.env.SHIPPO_WEBHOOK_TOKEN = TEST_WEBHOOK_TOKEN;

const http = require('http');
const jwt  = require('jsonwebtoken');

const { buildApp }             = require('../src/app');
const pool                     = require('../src/db');
const { handleTrackingWebhook } = require('../src/orderService');

// ── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function run(name, fn) {
  try {
    await fn();
    passed++;
    process.stdout.write(`  [PASS] ${name}\n`);
  } catch (err) {
    failed++;
    process.stdout.write(`  [FAIL] ${name}: ${err.message}\n`);
    if (process.env.VERBOSE) process.stderr.write((err.stack || '') + '\n');
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label || 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

let server;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
// Fixed test user IDs that won't collide with production data.
const BUYER_ID  = 9901;
const SELLER_ID = 9902;

function makeToken(userId, role) {
  return jwt.sign({ sub: userId, role }, JWT_SECRET);
}

function httpRequest(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const bodyBuf = body
      ? (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)))
      : null;
    const opts = {
      method,
      hostname: '127.0.0.1',
      port: server.address().port,
      path,
      headers: {
        'content-type': 'application/json',
        ...headers,
        ...(bodyBuf ? { 'content-length': String(bodyBuf.length) } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function postWebhook(payload, token) {
  // token === undefined → omit query param entirely
  // token === null      → omit query param (missing token test)
  // token === ''        → ?token=  (empty string test)
  const qs = (token !== undefined && token !== null) ? `?token=${encodeURIComponent(token)}` : '';
  const rawBody = Buffer.from(JSON.stringify(payload));
  return httpRequest('POST', `/webhooks/shippo${qs}`, rawBody, {
    'content-type': 'application/json',
  });
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function ensureTestEntities() {
  // Idempotent inserts for users and listing used across all tests.
  await pool.query(`
    INSERT INTO users (id, name, email, role)
    OVERRIDING SYSTEM VALUE
    VALUES (9901, 'WH Buyer',  'wh-buyer-9901@test.invalid',  'buyer'),
           (9902, 'WH Seller', 'wh-seller-9902@test.invalid', 'seller')
    ON CONFLICT (id) DO NOTHING
  `);
  await pool.query(`
    INSERT INTO listings (id, seller_id, title, price_cents)
    OVERRIDING SYSTEM VALUE
    VALUES (9901, 9902, 'Webhook Test Bat', 5000)
    ON CONFLICT (id) DO NOTHING
  `);
}

async function insertOrder(opts = {}) {
  const {
    status                = 'HELD',
    label_id              = null,
    tracking_number       = null,
    carrier               = null,
    tracking_status       = null,
    last_tracking_event_at = null,
    shipped_at            = null,
    delivered_at          = null,
    window_expires_at     = null,
  } = opts;

  const { rows } = await pool.query(
    `INSERT INTO orders (
       listing_id, buyer_id, seller_id,
       amount_cents, item_price_cents, shipping_cents,
       platform_fee_cents, seller_payout_cents,
       status, stripe_payment_intent_id,
       label_id, label_url,
       tracking_number, carrier,
       tracking_status, last_tracking_event_at,
       shipped_at, delivered_at, window_expires_at,
       created_at, updated_at
     ) VALUES (
       9901, 9901, 9902,
       5000, 4500, 500,
       360, 4140,
       $1, 'pi_stub_wh_test',
       $2, $3,
       $4, $5,
       $6, $7,
       $8, $9, $10,
       NOW(), NOW()
     ) RETURNING id`,
    [
      status,
      label_id,
      label_id ? 'https://example.com/stub-label.pdf' : null,
      tracking_number,
      carrier,
      tracking_status,
      last_tracking_event_at,
      shipped_at,
      delivered_at,
      window_expires_at,
    ]
  );
  return Number(rows[0].id);
}

async function getOrderDb(id) {
  const { rows } = await pool.query(
    `SELECT status, tracking_status, last_tracking_event_at,
            shipped_at, delivered_at, window_expires_at, label_url
     FROM orders WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

// ── Webhook payload builder ───────────────────────────────────────────────────

function makeWebhookPayload({ trackingNumber, carrier, status, statusDate }) {
  return {
    event: 'track_updated',
    test:  false,
    data: {
      tracking_number: trackingNumber,
      carrier,
      tracking_status: {
        status,
        status_date:    statusDate || new Date(Date.now() - 500).toISOString(),
        status_details: `Webhook test: ${status}`,
        substatus:      null,
      },
    },
  };
}

// ── Run tests ─────────────────────────────────────────────────────────────────

async function runTests() {
  process.stdout.write('\n=== Shippo Webhook Tests ===\n\n');

  await ensureTestEntities();

  // ── HTTP authentication ─────────────────────────────────────────────────────
  process.stdout.write('-- Authentication --\n');

  await run('valid token → 200', async () => {
    const res = await postWebhook(
      makeWebhookPayload({ trackingNumber: 'AUTH001', carrier: 'usps', status: 'PRE_TRANSIT' }),
      TEST_WEBHOOK_TOKEN
    );
    assertEqual(res.status, 200, 'HTTP status');
    assert(res.body.ok === true, `body.ok should be true, got: ${JSON.stringify(res.body)}`);
  });

  await run('missing token → 401', async () => {
    const res = await postWebhook(
      makeWebhookPayload({ trackingNumber: 'AUTH002', carrier: 'usps', status: 'PRE_TRANSIT' }),
      null  // no token query param
    );
    assertEqual(res.status, 401, 'HTTP status should be 401');
  });

  await run('wrong token → 401', async () => {
    const res = await postWebhook(
      makeWebhookPayload({ trackingNumber: 'AUTH003', carrier: 'usps', status: 'PRE_TRANSIT' }),
      'wrong-token-value'
    );
    assertEqual(res.status, 401, 'HTTP status should be 401');
  });

  await run('non-track_updated event → 200 skipped', async () => {
    const res = await postWebhook(
      { event: 'transaction_created', test: true, data: {} },
      TEST_WEBHOOK_TOKEN
    );
    assertEqual(res.status, 200, 'HTTP status');
    assertEqual(res.body.skipped, true, 'body.skipped should be true');
  });

  await run('invalid JSON body → 400', async () => {
    const qs = `?token=${encodeURIComponent(TEST_WEBHOOK_TOKEN)}`;
    const res = await httpRequest('POST', `/webhooks/shippo${qs}`,
      Buffer.from('not-valid-json'), { 'content-type': 'application/json' });
    assertEqual(res.status, 400, 'HTTP status should be 400');
  });

  // ── PRE_TRANSIT ─────────────────────────────────────────────────────────────
  process.stdout.write('\n-- Tracking status updates --\n');

  await run('PRE_TRANSIT → tracking_status updated, order.status unchanged', async () => {
    const orderId = await insertOrder({
      status: 'HELD', label_id: 'lbl_pre_1', tracking_number: 'WHPRE001', carrier: 'USPS',
    });
    const statusDate = new Date(Date.now() - 2000).toISOString();
    const result = await handleTrackingWebhook({
      tracking_number:  'WHPRE001',
      carrier:          'usps',
      tracking_status:  { status: 'PRE_TRANSIT', status_date: statusDate },
    });
    const row = await getOrderDb(orderId);
    assertEqual(row.status,          'HELD',        'order.status unchanged');
    assertEqual(row.tracking_status, 'PRE_TRANSIT', 'tracking_status updated');
    assertEqual(result.action,       'processed',   'action = processed');
    assertEqual(result.stateTransition, 'none',     'no state transition');
  });

  // ── TRANSIT ─────────────────────────────────────────────────────────────────

  await run('TRANSIT + HELD + label → SHIPPED, shipped_at set', async () => {
    const orderId = await insertOrder({
      status: 'HELD', label_id: 'lbl_trn_1', tracking_number: 'WHTRN001', carrier: 'USPS',
    });
    const statusDate = new Date(Date.now() - 2000).toISOString();
    const result = await handleTrackingWebhook({
      tracking_number: 'WHTRN001', carrier: 'usps',
      tracking_status: { status: 'TRANSIT', status_date: statusDate },
    });
    const row = await getOrderDb(orderId);
    assertEqual(row.status,           'SHIPPED',         'order → SHIPPED');
    assert(row.shipped_at !== null,                       'shipped_at set');
    assertEqual(row.tracking_status,  'TRANSIT',          'tracking_status = TRANSIT');
    assert(result.stateTransition === 'HELD\u2192SHIPPED', 'stateTransition correct');
  });

  await run('TRANSIT + HELD + no label → tracking update only (no state change)', async () => {
    const orderId = await insertOrder({
      status: 'HELD', label_id: null, tracking_number: 'WHTRN002', carrier: 'USPS',
    });
    const statusDate = new Date(Date.now() - 2000).toISOString();
    await handleTrackingWebhook({
      tracking_number: 'WHTRN002', carrier: 'usps',
      tracking_status: { status: 'TRANSIT', status_date: statusDate },
    });
    const row = await getOrderDb(orderId);
    assertEqual(row.status,          'HELD',    'order stays HELD (no label)');
    assertEqual(row.tracking_status, 'TRANSIT', 'tracking_status updated');
  });

  // ── DELIVERED (normal path) ─────────────────────────────────────────────────

  await run('DELIVERED + SHIPPED → DELIVERED, delivered_at and window_expires_at set', async () => {
    const orderId = await insertOrder({
      status: 'SHIPPED', label_id: 'lbl_del_1', tracking_number: 'WHDEL001', carrier: 'USPS',
      shipped_at: new Date(Date.now() - 86400000).toISOString(),
    });
    const statusDate = new Date(Date.now() - 2000).toISOString();
    const result = await handleTrackingWebhook({
      tracking_number: 'WHDEL001', carrier: 'usps',
      tracking_status: { status: 'DELIVERED', status_date: statusDate },
    });
    const row = await getOrderDb(orderId);
    assertEqual(row.status,           'DELIVERED',               'order → DELIVERED');
    assert(row.delivered_at    !== null,                         'delivered_at set');
    assert(row.window_expires_at !== null,                       'window_expires_at set');
    assert(result.stateTransition === 'SHIPPED\u2192DELIVERED',  'stateTransition correct');
  });

  // ── DELIVERED (skip-scan path) ──────────────────────────────────────────────

  await run('DELIVERED + HELD + label (no TRANSIT scan) → HELD→DELIVERED, shipped_at+delivered_at set', async () => {
    const orderId = await insertOrder({
      status: 'HELD', label_id: 'lbl_heldel_1', tracking_number: 'WHHELDEL001', carrier: 'USPS',
    });
    const statusDate = new Date(Date.now() - 2000).toISOString();
    const result = await handleTrackingWebhook({
      tracking_number: 'WHHELDEL001', carrier: 'usps',
      tracking_status: { status: 'DELIVERED', status_date: statusDate },
    });
    const row = await getOrderDb(orderId);
    assertEqual(row.status,             'DELIVERED',              'order → DELIVERED directly from HELD');
    assert(row.shipped_at    !== null,                            'shipped_at coalesced to now');
    assert(row.delivered_at  !== null,                            'delivered_at set');
    assert(row.window_expires_at !== null,                        'window_expires_at set');
    assert(result.stateTransition === 'HELD\u2192DELIVERED',      'stateTransition = HELD→DELIVERED');
  });

  // ── RETURNED / FAILURE ──────────────────────────────────────────────────────

  await run('RETURNED → tracking_status updated, order stays SHIPPED', async () => {
    const orderId = await insertOrder({
      status: 'SHIPPED', label_id: 'lbl_ret_1', tracking_number: 'WHRET001', carrier: 'USPS',
      shipped_at: new Date().toISOString(),
    });
    await handleTrackingWebhook({
      tracking_number: 'WHRET001', carrier: 'usps',
      tracking_status: { status: 'RETURNED', status_date: new Date(Date.now() - 2000).toISOString() },
    });
    const row = await getOrderDb(orderId);
    assertEqual(row.status,          'SHIPPED',   'order stays SHIPPED');
    assertEqual(row.tracking_status, 'RETURNED',  'tracking_status = RETURNED');
  });

  await run('FAILURE → tracking_status updated, order stays SHIPPED', async () => {
    const orderId = await insertOrder({
      status: 'SHIPPED', label_id: 'lbl_fail_1', tracking_number: 'WHFAIL001', carrier: 'USPS',
      shipped_at: new Date().toISOString(),
    });
    await handleTrackingWebhook({
      tracking_number: 'WHFAIL001', carrier: 'usps',
      tracking_status: { status: 'FAILURE', status_date: new Date(Date.now() - 2000).toISOString() },
    });
    const row = await getOrderDb(orderId);
    assertEqual(row.status,          'SHIPPED',  'order stays SHIPPED');
    assertEqual(row.tracking_status, 'FAILURE',  'tracking_status = FAILURE');
  });

  // ── Idempotency ─────────────────────────────────────────────────────────────
  process.stdout.write('\n-- Idempotency --\n');

  await run('duplicate TRANSIT (same status_date) → second call is stale, no double state change', async () => {
    const orderId = await insertOrder({
      status: 'HELD', label_id: 'lbl_duptrn_1', tracking_number: 'WHDUPTRN001', carrier: 'USPS',
    });
    const statusDate = new Date(Date.now() - 2000).toISOString();

    // First call: should transition HELD → SHIPPED.
    await handleTrackingWebhook({
      tracking_number: 'WHDUPTRN001', carrier: 'usps',
      tracking_status: { status: 'TRANSIT', status_date: statusDate },
    });
    const rowAfterFirst = await getOrderDb(orderId);
    assertEqual(rowAfterFirst.status, 'SHIPPED', 'first call: SHIPPED');

    // Second call with identical status_date: should be stale.
    const result2 = await handleTrackingWebhook({
      tracking_number: 'WHDUPTRN001', carrier: 'usps',
      tracking_status: { status: 'TRANSIT', status_date: statusDate },
    });
    const rowAfterSecond = await getOrderDb(orderId);
    assertEqual(rowAfterSecond.status, 'SHIPPED', 'second call: still SHIPPED');
    assertEqual(result2.action, 'stale', 'second call action = stale');
  });

  await run('duplicate DELIVERED (same status_date) → second call is stale', async () => {
    const orderId = await insertOrder({
      status: 'SHIPPED', label_id: 'lbl_dupdel_1', tracking_number: 'WHDUPDEL001', carrier: 'USPS',
      shipped_at: new Date(Date.now() - 86400000).toISOString(),
    });
    const statusDate = new Date(Date.now() - 2000).toISOString();

    await handleTrackingWebhook({
      tracking_number: 'WHDUPDEL001', carrier: 'usps',
      tracking_status: { status: 'DELIVERED', status_date: statusDate },
    });
    assertEqual((await getOrderDb(orderId)).status, 'DELIVERED', 'first call: DELIVERED');

    const result2 = await handleTrackingWebhook({
      tracking_number: 'WHDUPDEL001', carrier: 'usps',
      tracking_status: { status: 'DELIVERED', status_date: statusDate },
    });
    assertEqual((await getOrderDb(orderId)).status, 'DELIVERED', 'second call: still DELIVERED');
    assertEqual(result2.action, 'stale', 'second call action = stale');
  });

  await run('stale TRANSIT arriving after DELIVERED → order and tracking_status do not regress', async () => {
    const newerDate = new Date(Date.now() - 500).toISOString();
    const orderId = await insertOrder({
      status: 'DELIVERED', label_id: 'lbl_staletrn_1', tracking_number: 'WHSTALETRN001',
      carrier: 'USPS', tracking_status: 'DELIVERED', last_tracking_event_at: newerDate,
      shipped_at:   new Date(Date.now() - 86400000).toISOString(),
      delivered_at: new Date(Date.now() - 3600000).toISOString(),
      window_expires_at: new Date(Date.now() + 86400000 * 2).toISOString(),
    });
    const olderDate = new Date(Date.now() - 7200000).toISOString(); // older than newerDate

    const result = await handleTrackingWebhook({
      tracking_number: 'WHSTALETRN001', carrier: 'usps',
      tracking_status: { status: 'TRANSIT', status_date: olderDate },
    });
    const row = await getOrderDb(orderId);
    assertEqual(row.status,          'DELIVERED', 'order.status not regressed');
    assertEqual(row.tracking_status, 'DELIVERED', 'tracking_status not regressed to TRANSIT');
    assertEqual(result.action,       'stale',     'result.action = stale');
  });

  await run('stale PRE_TRANSIT after TRANSIT → tracking_status stays TRANSIT', async () => {
    const newerDate = new Date(Date.now() - 500).toISOString();
    const orderId = await insertOrder({
      status: 'SHIPPED', label_id: 'lbl_stalepre_1', tracking_number: 'WHSTALEPRE001',
      carrier: 'USPS', tracking_status: 'TRANSIT', last_tracking_event_at: newerDate,
      shipped_at: new Date().toISOString(),
    });
    const olderDate = new Date(Date.now() - 7200000).toISOString();

    const result = await handleTrackingWebhook({
      tracking_number: 'WHSTALEPRE001', carrier: 'usps',
      tracking_status: { status: 'PRE_TRANSIT', status_date: olderDate },
    });
    const row = await getOrderDb(orderId);
    assertEqual(row.tracking_status, 'TRANSIT', 'tracking_status stays TRANSIT (not regressed)');
    assertEqual(row.status,          'SHIPPED',  'order stays SHIPPED');
    assertEqual(result.action,       'stale',    'result.action = stale');
  });

  // ── Protected states ────────────────────────────────────────────────────────
  process.stdout.write('\n-- Protected states --\n');

  await run('DISPUTED + TRANSIT → tracking_status updated, order stays DISPUTED', async () => {
    const orderId = await insertOrder({
      status: 'DISPUTED', label_id: 'lbl_disp_1', tracking_number: 'WHDISPUTED001', carrier: 'USPS',
    });
    const result = await handleTrackingWebhook({
      tracking_number: 'WHDISPUTED001', carrier: 'usps',
      tracking_status: { status: 'TRANSIT', status_date: new Date(Date.now() - 2000).toISOString() },
    });
    const row = await getOrderDb(orderId);
    assertEqual(row.status,          'DISPUTED', 'order stays DISPUTED');
    assertEqual(row.tracking_status, 'TRANSIT',  'tracking_status updated');
    assertEqual(result.action,       'tracking_only', 'action = tracking_only');
  });

  await run('RELEASED + TRANSIT → tracking_status updated, order stays RELEASED', async () => {
    const orderId = await insertOrder({
      status: 'RELEASED', label_id: 'lbl_reled_1', tracking_number: 'WHREL001', carrier: 'USPS',
    });
    const result = await handleTrackingWebhook({
      tracking_number: 'WHREL001', carrier: 'usps',
      tracking_status: { status: 'TRANSIT', status_date: new Date(Date.now() - 2000).toISOString() },
    });
    const row = await getOrderDb(orderId);
    assertEqual(row.status, 'RELEASED', 'RELEASED stays RELEASED');
    assertEqual(result.action, 'tracking_only', 'action = tracking_only');
  });

  // ── Carrier case normalisation ───────────────────────────────────────────────
  process.stdout.write('\n-- Carrier case normalisation --\n');

  await run('DB carrier=USPS (uppercase) matches webhook carrier=usps (lowercase)', async () => {
    const orderId = await insertOrder({
      status: 'HELD', label_id: 'lbl_case_1', tracking_number: 'WHCASE001', carrier: 'USPS',
    });
    await handleTrackingWebhook({
      tracking_number: 'WHCASE001', carrier: 'usps',
      tracking_status: { status: 'TRANSIT', status_date: new Date(Date.now() - 2000).toISOString() },
    });
    const row = await getOrderDb(orderId);
    assertEqual(row.status, 'SHIPPED', 'USPS (DB) matched usps (webhook)');
  });

  await run('DB carrier=FedEx matches webhook carrier=fedex', async () => {
    const orderId = await insertOrder({
      status: 'HELD', label_id: 'lbl_case_2', tracking_number: 'WHCASE002', carrier: 'FedEx',
    });
    await handleTrackingWebhook({
      tracking_number: 'WHCASE002', carrier: 'fedex',
      tracking_status: { status: 'TRANSIT', status_date: new Date(Date.now() - 2000).toISOString() },
    });
    const row = await getOrderDb(orderId);
    assertEqual(row.status, 'SHIPPED', 'FedEx (DB) matched fedex (webhook)');
  });

  await run('DB carrier=ups matches webhook carrier=UPS (uppercase from some carriers)', async () => {
    const orderId = await insertOrder({
      status: 'HELD', label_id: 'lbl_case_3', tracking_number: 'WHCASE003', carrier: 'ups',
    });
    await handleTrackingWebhook({
      tracking_number: 'WHCASE003', carrier: 'UPS',
      tracking_status: { status: 'TRANSIT', status_date: new Date(Date.now() - 2000).toISOString() },
    });
    const row = await getOrderDb(orderId);
    assertEqual(row.status, 'SHIPPED', 'ups (DB) matched UPS (webhook)');
  });

  // ── Backend protection ──────────────────────────────────────────────────────
  process.stdout.write('\n-- Backend protection --\n');

  await run('seller cannot manually ship a platform label order via POST /orders/:id/ship → 409', async () => {
    const orderId = await insertOrder({
      status: 'HELD', label_id: 'lbl_noship_1', tracking_number: 'WHNOMANUAL001', carrier: 'USPS',
    });
    const token = makeToken(SELLER_ID, 'seller');
    const res = await httpRequest('POST', `/orders/${orderId}/ship`, {}, {
      authorization: `Bearer ${token}`,
    });
    assertEqual(res.status, 409, 'expected 409 for platform label order');
    assert(
      res.body.error && res.body.error.includes('platform shipping label'),
      `error should mention platform label; got: ${res.body.error}`
    );
    const row = await getOrderDb(orderId);
    assertEqual(row.status, 'HELD', 'order must remain HELD');
  });

  await run('seller CAN manually ship a non-label order via POST /orders/:id/ship → 200', async () => {
    const orderId = await insertOrder({
      status: 'HELD', label_id: null, tracking_number: null, carrier: null,
    });
    const token = makeToken(SELLER_ID, 'seller');
    const res = await httpRequest('POST', `/orders/${orderId}/ship`, {}, {
      authorization: `Bearer ${token}`,
    });
    assertEqual(res.status, 200, 'non-label order can be manually shipped');
    const row = await getOrderDb(orderId);
    assertEqual(row.status, 'SHIPPED', 'order → SHIPPED');
  });

  // ── Buyer label_url redaction ────────────────────────────────────────────────
  process.stdout.write('\n-- Buyer label_url redaction --\n');

  await run('buyer never receives label_url in GET /orders/:id', async () => {
    const orderId = await insertOrder({
      status: 'HELD', label_id: 'lbl_buyer_1', tracking_number: 'WHBUYER001', carrier: 'USPS',
    });
    const token = makeToken(BUYER_ID, 'buyer');
    const res = await httpRequest('GET', `/orders/${orderId}`, null, {
      authorization: `Bearer ${token}`,
    });
    assertEqual(res.status, 200, 'request succeeds');
    assert(
      !('label_url' in res.body),
      `buyer response must not contain label_url; keys: ${Object.keys(res.body).join(', ')}`
    );
    // Tracking number should be visible to buyer
    assert('tracking_number' in res.body, 'buyer should see tracking_number');
  });

  await run('seller receives label_url in GET /orders/:id', async () => {
    const orderId = await insertOrder({
      status: 'HELD', label_id: 'lbl_seller_1', tracking_number: 'WHSELLER001', carrier: 'USPS',
    });
    const token = makeToken(SELLER_ID, 'seller');
    const res = await httpRequest('GET', `/orders/${orderId}`, null, {
      authorization: `Bearer ${token}`,
    });
    assertEqual(res.status, 200, 'request succeeds');
    assert('label_url' in res.body, 'seller response should contain label_url');
  });

  // ── Phase 4: RETURNED / FAILURE tracking exceptions ────────────────────────
  process.stdout.write('\n-- Phase 4: Shipping exceptions --\n');

  await run('RETURNED webhook on SHIPPED order: tracking_status updated, order stays SHIPPED', async () => {
    const orderId = await insertOrder({
      status: 'SHIPPED', label_id: 'lbl_ret_ex_1', tracking_number: 'WHRETEX001', carrier: 'USPS',
      shipped_at: new Date(Date.now() - 86400000).toISOString(),
    });
    const result = await handleTrackingWebhook({
      tracking_number: 'WHRETEX001', carrier: 'usps',
      tracking_status: { status: 'RETURNED', status_date: new Date(Date.now() - 1000).toISOString() },
    });
    const row = await getOrderDb(orderId);
    assertEqual(row.status,             'SHIPPED',   'order must stay SHIPPED');
    assertEqual(row.tracking_status,    'RETURNED',  'tracking_status must be RETURNED');
    assertEqual(result.action,          'processed', 'action must be processed');
    assertEqual(result.stateTransition, 'none',      'no state transition');
  });

  await run('FAILURE webhook on SHIPPED order: tracking_status updated, order stays SHIPPED', async () => {
    const orderId = await insertOrder({
      status: 'SHIPPED', label_id: 'lbl_fail_ex_1', tracking_number: 'WHFAILEX001', carrier: 'USPS',
      shipped_at: new Date(Date.now() - 86400000).toISOString(),
    });
    const result = await handleTrackingWebhook({
      tracking_number: 'WHFAILEX001', carrier: 'usps',
      tracking_status: { status: 'FAILURE', status_date: new Date(Date.now() - 1000).toISOString() },
    });
    const row = await getOrderDb(orderId);
    assertEqual(row.status,             'SHIPPED',   'order must stay SHIPPED');
    assertEqual(row.tracking_status,    'FAILURE',   'tracking_status must be FAILURE');
    assertEqual(result.action,          'processed', 'action must be processed');
    assertEqual(result.stateTransition, 'none',      'no state transition');
  });

  await run('auto-release guard: DELIVERED+RETURNED order is skipped by sweep', async () => {
    // Insert a DELIVERED order with RETURNED tracking and an expired window.
    const orderId = await insertOrder({
      status:           'DELIVERED',
      label_id:         'lbl_guard_1',
      tracking_number:  'WHGUARD001',
      carrier:          'USPS',
      tracking_status:  'RETURNED',
      shipped_at:       new Date(Date.now() - 86400000 * 3).toISOString(),
      delivered_at:     new Date(Date.now() - 86400000).toISOString(),
      window_expires_at: new Date(Date.now() - 3600000).toISOString(), // expired 1 hour ago
    });

    const { runReleaseCheck } = require('../src/orderService');
    const sweepResult = await runReleaseCheck();

    // The order must NOT appear in the released list.
    assert(
      !sweepResult.releasedOrderIds.includes(orderId),
      `Order ${orderId} with RETURNED tracking must not be auto-released`
    );

    const row = await getOrderDb(orderId);
    assertEqual(row.status, 'DELIVERED', 'order must remain DELIVERED (not auto-released)');
  });

  await run('auto-release guard: DELIVERED+FAILURE order is skipped by sweep', async () => {
    const orderId = await insertOrder({
      status:           'DELIVERED',
      label_id:         'lbl_guard_2',
      tracking_number:  'WHGUARD002',
      carrier:          'USPS',
      tracking_status:  'FAILURE',
      shipped_at:       new Date(Date.now() - 86400000 * 3).toISOString(),
      delivered_at:     new Date(Date.now() - 86400000).toISOString(),
      window_expires_at: new Date(Date.now() - 3600000).toISOString(),
    });

    const { runReleaseCheck } = require('../src/orderService');
    const sweepResult = await runReleaseCheck();

    assert(
      !sweepResult.releasedOrderIds.includes(orderId),
      `Order ${orderId} with FAILURE tracking must not be auto-released`
    );
    const row = await getOrderDb(orderId);
    assertEqual(row.status, 'DELIVERED', 'order must remain DELIVERED (not auto-released)');
  });

  await run('auto-release sweep: DELIVERED+null tracking IS released (normal path)', async () => {
    const orderId = await insertOrder({
      status:           'DELIVERED',
      label_id:         'lbl_guard_3',
      tracking_number:  'WHGUARD003',
      carrier:          'USPS',
      tracking_status:  null,  // no exception
      shipped_at:       new Date(Date.now() - 86400000 * 3).toISOString(),
      delivered_at:     new Date(Date.now() - 86400000).toISOString(),
      window_expires_at: new Date(Date.now() - 3600000).toISOString(),
    });
    // performRelease requires both stripe_charge_id and seller.stripe_account_id.
    await pool.query(
      `UPDATE orders SET stripe_charge_id = 'ch_stub_guard_3' WHERE id = $1`,
      [orderId]
    );
    await pool.query(
      `UPDATE users SET stripe_account_id = 'acct_stub_wh_test' WHERE id = $1`,
      [SELLER_ID]
    );

    const { runReleaseCheck } = require('../src/orderService');
    const sweepResult = await runReleaseCheck();

    const row = await getOrderDb(orderId);
    assertEqual(row.status, 'RELEASED', 'DELIVERED+null tracking must be auto-released');
  });

  // ── Summary ──────────────────────────────────────────────────────────────────
  const total = passed + failed;
  process.stdout.write('\n' + '='.repeat(55) + '\n');
  process.stdout.write('WEBHOOK TEST SUMMARY\n');
  process.stdout.write('='.repeat(55) + '\n');
  process.stdout.write(`Result: ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${total} passed)\n`);
  process.stdout.write('='.repeat(55) + '\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const app = buildApp();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    await runTests();
  } finally {
    server.close();
    await pool.end();
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

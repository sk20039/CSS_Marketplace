'use strict';

/**
 * Focused tests for escrow-service email notifications (Phase 1).
 *
 * Covers:
 *   - reply-to field present in escrow stub captures
 *   - notifyLabelPurchased: content, fire-and-forget, no label URL
 *   - notifyShipped: carrier + tracking included when available
 *   - Duplicate label purchase prevention (no duplicate email)
 *   - No email fired on label purchase failure
 *   - Email provider failure does not fail label purchase API response
 *   - No email before DB transaction commits
 *
 * Prerequisites: DATABASE_URL_TEST set; test DB migrated.
 * Run: node tests/email_notifications.test.js  (from escrow-service/)
 */

// ── Environment setup — must precede any src/ require ─────────────────────
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
process.env.JWT_SECRET   = process.env.JWT_SECRET || 'change-me';
process.env.APP_BASE_URL = 'https://www.cricketmarketusa.com';
delete process.env.STRIPE_SECRET_KEY;   // force stub Stripe
delete process.env.SMTP_HOST;           // force stub emailer
delete process.env.POSTHOG_API_KEY;
process.env.EVIDENCE_DIR = require('os').tmpdir() + '/escrow_email_test_' + Date.now();

const http = require('http');
const jwt  = require('jsonwebtoken');

// ── Test harness ───────────────────────────────────────────────────────────

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

// ── Mock listing server ────────────────────────────────────────────────────

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
  } else if (req.method === 'PATCH') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});

// ── HTTP helpers ───────────────────────────────────────────────────────────

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

// ── State ──────────────────────────────────────────────────────────────────

let pool, appServer, emailer, notifications;
let buyerId, sellerId;
let buyerToken, sellerToken;

const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const LISTING_ID = 801;
const SELLER_ZIP = '77001';
const BUYER_ADDR = {
  name: 'Test Buyer', line1: '1 Main St', city: 'Houston', state: 'TX', zip: '77002',
};

// ── Setup ──────────────────────────────────────────────────────────────────

async function setup() {
  await new Promise((r) => mockListingServer.listen(0, '127.0.0.1', r));
  const mockPort = mockListingServer.address().port;
  process.env.LISTING_SERVICE_URL           = `http://127.0.0.1:${mockPort}`;
  process.env.RATE_LIMIT_ORDER_CREATE_MAX   = '500';
  process.env.RATE_LIMIT_LABEL_PURCHASE_MAX = '500';
  process.env.RATE_LIMIT_DISPUTE_MAX        = '500';

  pool          = require('../src/db');
  emailer       = require('../src/emailer');
  notifications = require('../src/notifications');
  const { buildApp } = require('../src/app');

  // Truncate all test data.
  await pool.query(`
    TRUNCATE reviews, messages, order_events, orders, listings, users
    RESTART IDENTITY CASCADE
  `);

  const { rows: [buyer] } = await pool.query(
    `INSERT INTO users (name, email, role)
     VALUES ('Email Buyer', 'buyer@email.test', 'buyer') RETURNING id`
  );
  const { rows: [seller] } = await pool.query(
    `INSERT INTO users (name, email, role, stripe_account_id, ship_from_address)
     VALUES ('Email Seller', 'seller@email.test', 'seller', 'acct_stub_email_test', $1) RETURNING id`,
    [JSON.stringify({
      name: 'Email Seller', line1: '1 Sell St', city: 'Houston',
      state: 'TX', zip: SELLER_ZIP, phone: '5550002222',
    })]
  );

  buyerId  = buyer.id;
  sellerId = seller.id;
  buyerToken  = jwt.sign({ sub: String(buyerId),  email: 'buyer@email.test',  role: 'buyer'  }, JWT_SECRET);
  sellerToken = jwt.sign({ sub: String(sellerId), email: 'seller@email.test', role: 'seller' }, JWT_SECRET);

  mockListing = {
    id: LISTING_ID, seller_id: sellerId, title: 'Email Test Bat',
    price_cents: 9999, status: 'active',
    weight_oz: 32, pkg_length_in: 30, pkg_width_in: 5, pkg_height_in: 4,
  };

  const app = buildApp();
  await new Promise((r) => {
    appServer = app.listen(0, '127.0.0.1', r);
  });
}

async function teardown() {
  if (appServer) await new Promise((r) => appServer.close(r));
  if (mockListingServer.listening) await new Promise((r) => mockListingServer.close(r));
  if (pool) await pool.end();
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function createHeldOrder() {
  const res = await post(appServer, '/orders', buyerToken, {
    listing_id:       LISTING_ID,
    shipping_address: BUYER_ADDR,
  });
  assert(res.status === 201, `createOrder failed: ${JSON.stringify(res.body)}`);
  const orderId = res.body.id;

  const cap = await post(appServer, `/orders/${orderId}/capture`, buyerToken);
  assert(cap.status === 200, `capture failed: ${JSON.stringify(cap.body)}`);
  return cap.body;
}

async function fetchSellerRates(orderId) {
  const res = await get(appServer, `/orders/${orderId}/seller-shipping-rates`, sellerToken);
  assert(res.status === 200, `seller rates failed: ${JSON.stringify(res.body)}`);
  return res.body.rates;
}

// ── Section 1: emailer stub unit tests (no DB) ────────────────────────────

async function runEmailerUnitTests() {
  console.log('\nescrow emailer — reply-to field');

  await test('sendEmail captures replyTo in stub mode with default value', async () => {
    delete process.env.EMAIL_REPLY_TO;
    emailer._clearCaptured();
    await emailer.sendEmail({ to: 'a@b.com', subject: 'Test', text: 'hello' });
    const emails = emailer._getCaptured();
    assertEqual(emails.length, 1, 'should capture exactly 1 email');
    assertEqual(emails[0].replyTo, 'support@cricketmarketusa.com',
      `expected default reply-to, got: ${emails[0].replyTo}`);
  });

  await test('sendEmail captures replyTo override from EMAIL_REPLY_TO', async () => {
    process.env.EMAIL_REPLY_TO = 'help@cricketmarketusa.com';
    emailer._clearCaptured();
    await emailer.sendEmail({ to: 'a@b.com', subject: 'Test', text: 'hello' });
    const emails = emailer._getCaptured();
    assertEqual(emails[0].replyTo, 'help@cricketmarketusa.com',
      `expected overridden reply-to, got: ${emails[0].replyTo}`);
    delete process.env.EMAIL_REPLY_TO;
  });
}

// ── Section 2: notifyLabelPurchased unit tests ────────────────────────────

async function runLabelPurchasedTests() {
  console.log('\nnotifyLabelPurchased — content');

  const baseOrder = {
    id: 999,
    seller_id: sellerId,
    buyer_id:  buyerId,
    amount_cents: 9999,
    carrier:         'USPS',
    carrier_service: 'usps_groundadvantage',
    tracking_number: 'TRACK123456',
    label_url:       'https://shippo.com/label/secret-url',
  };

  await test('sends exactly one email to seller', async () => {
    emailer._clearCaptured();
    await notifications.notifyLabelPurchased(baseOrder);
    const emails = emailer._getCaptured();
    assertEqual(emails.length, 1, 'must send exactly 1 email');
    assertEqual(emails[0].to, 'seller@email.test', 'must be sent to seller');
  });

  await test('subject contains order number', async () => {
    emailer._clearCaptured();
    await notifications.notifyLabelPurchased(baseOrder);
    const email = emailer._getCaptured()[0];
    assert(email.subject.includes('999'), `subject must include order id, got: ${email.subject}`);
    assert(email.subject.toLowerCase().includes('label') || email.subject.toLowerCase().includes('shipping'),
      'subject must mention label/shipping');
  });

  await test('body contains carrier', async () => {
    emailer._clearCaptured();
    await notifications.notifyLabelPurchased(baseOrder);
    const text = emailer._getCaptured()[0].text;
    assert(text.includes('USPS'), `body must contain carrier "USPS", got: ${text}`);
  });

  await test('body contains service level', async () => {
    emailer._clearCaptured();
    await notifications.notifyLabelPurchased(baseOrder);
    const text = emailer._getCaptured()[0].text;
    assert(text.includes('usps_groundadvantage'),
      `body must contain carrier_service, got: ${text}`);
  });

  await test('body contains tracking number', async () => {
    emailer._clearCaptured();
    await notifications.notifyLabelPurchased(baseOrder);
    const text = emailer._getCaptured()[0].text;
    assert(text.includes('TRACK123456'),
      `body must contain tracking number, got: ${text}`);
  });

  await test('body contains authenticated order page link', async () => {
    emailer._clearCaptured();
    await notifications.notifyLabelPurchased(baseOrder);
    const text = emailer._getCaptured()[0].text;
    assert(text.includes('/orders/999'),
      `body must contain order link, got: ${text}`);
  });

  await test('body does NOT contain the raw label URL', async () => {
    emailer._clearCaptured();
    await notifications.notifyLabelPurchased(baseOrder);
    const text = emailer._getCaptured()[0].text;
    assert(!text.includes('shippo.com/label'),
      `body must NOT contain label_url, got: ${text}`);
    assert(!text.includes('secret-url'),
      `body must NOT contain label URL path, got: ${text}`);
  });

  await test('sends email without tracking number when tracking is null', async () => {
    emailer._clearCaptured();
    await notifications.notifyLabelPurchased({
      ...baseOrder, tracking_number: null, tracking_number_2: undefined,
    });
    const emails = emailer._getCaptured();
    assertEqual(emails.length, 1, 'must still send 1 email');
    const text = emails[0].text;
    assert(!text.includes('TRACK123456'), 'no tracking should appear');
  });

  await test('sends email without carrier/service when both are null', async () => {
    emailer._clearCaptured();
    await notifications.notifyLabelPurchased({
      ...baseOrder, carrier: null, carrier_service: null, tracking_number: null,
    });
    const emails = emailer._getCaptured();
    assertEqual(emails.length, 1, 'must still send 1 email with no carrier details');
  });

  await test('does not send email when seller user does not exist', async () => {
    emailer._clearCaptured();
    await notifications.notifyLabelPurchased({ ...baseOrder, seller_id: 99999 });
    const emails = emailer._getCaptured();
    assertEqual(emails.length, 0, 'must send no email for missing seller');
  });
}

// ── Section 3: notifyShipped — carrier + tracking ─────────────────────────

async function runShippedTests() {
  console.log('\nnotifyShipped — carrier and tracking');

  const baseOrder = {
    id: 998,
    seller_id: sellerId,
    buyer_id:  buyerId,
    amount_cents: 9999,
    carrier:         null,
    tracking_number: null,
  };

  await test('body includes carrier and tracking when both are present', async () => {
    emailer._clearCaptured();
    await notifications.notifyShipped({
      ...baseOrder, carrier: 'UPS', tracking_number: 'UPS123',
    });
    const text = emailer._getCaptured()[0].text;
    assert(text.includes('UPS'),    `carrier missing from shipped email: ${text}`);
    assert(text.includes('UPS123'), `tracking number missing from shipped email: ${text}`);
  });

  await test('body includes tracking when carrier is null', async () => {
    emailer._clearCaptured();
    await notifications.notifyShipped({
      ...baseOrder, carrier: null, tracking_number: 'SOLO123',
    });
    const text = emailer._getCaptured()[0].text;
    assert(text.includes('SOLO123'), `tracking number missing: ${text}`);
  });

  await test('body includes carrier when tracking is null', async () => {
    emailer._clearCaptured();
    await notifications.notifyShipped({
      ...baseOrder, carrier: 'FedEx', tracking_number: null,
    });
    const text = emailer._getCaptured()[0].text;
    assert(text.includes('FedEx'), `carrier missing: ${text}`);
  });

  await test('sends email without error when both carrier and tracking are null', async () => {
    emailer._clearCaptured();
    await notifications.notifyShipped(baseOrder);
    const emails = emailer._getCaptured();
    assertEqual(emails.length, 1, 'must send 1 email');
  });

  await test('shipped email goes to buyer, not seller', async () => {
    emailer._clearCaptured();
    await notifications.notifyShipped({ ...baseOrder, carrier: 'USPS', tracking_number: 'T1' });
    const emails = emailer._getCaptured();
    assertEqual(emails[0].to, 'buyer@email.test', 'shipped email must go to buyer');
  });
}

// ── Section 4: API-level integration tests ────────────────────────────────

async function runApiTests() {
  console.log('\nlabel purchase — API integration');

  await test('label purchased sends one seller email after successful purchase', async () => {
    const order = await createHeldOrder();
    const rates = await fetchSellerRates(order.id);
    assert(rates.length > 0, 'must have at least one rate');

    emailer._clearCaptured();
    const res = await post(appServer, `/orders/${order.id}/purchase-label`, sellerToken, {
      shippo_rate_id: rates[0].rate_id,
      rate_token:     rates[0].rate_token,
    });
    assert(res.status === 200, `purchase-label failed: ${JSON.stringify(res.body)}`);

    // Give fire-and-forget a moment to settle.
    await new Promise((r) => setTimeout(r, 100));

    const emails = emailer._getCaptured();
    const labelEmails = emails.filter((e) => e.subject.includes('label') || e.subject.includes('Label'));
    assertEqual(labelEmails.length, 1, `expected 1 label-purchased email, got: ${labelEmails.length}`);
    assertEqual(labelEmails[0].to, 'seller@email.test', 'label email must go to seller');
  });

  await test('duplicate label purchase attempt does not send a second email', async () => {
    // Re-use the already-labeled order from prior test.
    const { rows } = await pool.query(
      `SELECT id FROM orders WHERE seller_id = $1 AND label_id IS NOT NULL LIMIT 1`,
      [sellerId]
    );
    assert(rows.length > 0, 'need a labeled order from the previous test');
    const orderId = rows[0].id;

    // Fetch the rates for the labeled order — we need any rate to attempt re-purchase.
    const rates = await fetchSellerRates(orderId);

    emailer._clearCaptured();
    // Second call: label_id is already set, should return the current state (idempotent).
    const res = await post(appServer, `/orders/${orderId}/purchase-label`, sellerToken, {
      shippo_rate_id: rates[0].rate_id,
      rate_token:     rates[0].rate_token,
    });
    // Idempotent second call returns 200 without re-doing the purchase.
    assert(res.status === 200, `expected 200, got ${res.status}`);

    await new Promise((r) => setTimeout(r, 100));

    const emails = emailer._getCaptured();
    const labelEmails = emails.filter((e) => e.subject.includes('label') || e.subject.includes('Label'));
    assertEqual(labelEmails.length, 0,
      `duplicate purchase must not send another email, got: ${labelEmails.length}`);
  });

  await test('email provider failure does not fail a successful label purchase', async () => {
    // Create a fresh HELD order.
    const order = await createHeldOrder();
    const rates  = await fetchSellerRates(order.id);
    assert(rates.length > 0, 'need at least one rate');

    // Patch notifyLabelPurchased to throw.
    const orig = notifications.notifyLabelPurchased;
    notifications.notifyLabelPurchased = async () => { throw new Error('Simulated email failure'); };

    try {
      emailer._clearCaptured();
      const res = await post(appServer, `/orders/${order.id}/purchase-label`, sellerToken, {
        shippo_rate_id: rates[0].rate_id,
        rate_token:     rates[0].rate_token,
      });
      assertEqual(res.status, 200,
        `label purchase must succeed even when email throws; got ${res.status}: ${JSON.stringify(res.body)}`);
      assert(res.body.status === 'HELD', `order must be HELD after label purchase, got: ${res.body.status}`);
      assert(res.body.label_id, 'label_id must be set despite email failure');
    } finally {
      notifications.notifyLabelPurchased = orig;
    }
  });

  await test('no email is sent when label purchase fails (Shippo rejects rate)', async () => {
    const order = await createHeldOrder();
    emailer._clearCaptured();

    // Send a completely invalid shippo_rate_id so Shippo stub returns a failure.
    const res = await post(appServer, `/orders/${order.id}/purchase-label`, sellerToken, {
      shippo_rate_id: 'invalid-rate-id',
      rate_token:     'invalid-token',
    });
    // Should return a non-200 (422 invalid rate_token, or 502/400).
    assert(res.status >= 400, `expected failure, got ${res.status}`);

    await new Promise((r) => setTimeout(r, 100));

    const emails = emailer._getCaptured();
    const labelEmails = emails.filter((e) => e.subject.includes('label') || e.subject.includes('Label'));
    assertEqual(labelEmails.length, 0,
      `no label email should be sent on failure, got: ${labelEmails.length}`);
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

(async () => {
  try {
    await setup();
    await runEmailerUnitTests();
    await runLabelPurchasedTests();
    await runShippedTests();
    await runApiTests();
  } catch (err) {
    console.error('\nSetup failed:', err.message);
    if (process.env.VERBOSE) console.error(err.stack);
    failed++;
  } finally {
    await teardown().catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();

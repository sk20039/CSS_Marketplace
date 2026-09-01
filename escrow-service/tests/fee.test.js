// tests/fee.test.js
//
// Platform fee math tests — unit tests for computeFee() and integration
// tests verifying that fee amounts appear correctly in the full order lifecycle.
//
// Fee rules (defaults):
//   PLATFORM_FEE_BPS = 800  (8%)
//   MIN_PLATFORM_FEE_CENTS = 200  ($2.00)
//   Fee = max(8% of amount, $2.00), capped at order amount (seller payout >= 0).
//
// Run standalone: node tests/fee.test.js
// Or via npm test (included in the test suite chain).

'use strict';

// ── Environment setup (must precede any src/ require) ──────────────────────
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'change-me';
delete process.env.STRIPE_SECRET_KEY; // force stub mode
// Use default fee values (800 bps, 200 cents min) — do not override from env
delete process.env.PLATFORM_FEE_BPS;
delete process.env.MIN_PLATFORM_FEE_CENTS;

const http = require('http');
const jwt  = require('jsonwebtoken');

// ── Test harness ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    if (process.env.VERBOSE) console.error(err.stack);
    failed++;
  }
}

async function testAsync(name, fn) {
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

// ── Mock listing server (must start before orderService is required) ───────

let mockListing = null;
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

// ── HTTP helpers ──────────────────────────────────────────────────────────

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

const post = (s, p, t, b) => request(s, 'POST', p, t, b);

// ── State ─────────────────────────────────────────────────────────────────

const LISTING_ID = 998;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';

const VALID_SHIPPING_ADDRESS = {
  name: 'Fee Buyer',
  line1: '456 Cricket Ln',
  city: 'Houston',
  state: 'TX',
  zip: '77002',
};

let pool, appServer, computeFee;
let buyerId, sellerId, adminId;
let buyerToken, sellerToken, adminToken;

// ── Setup / teardown ──────────────────────────────────────────────────────

async function setup() {
  // Start mock listing server FIRST so LISTING_SERVICE_URL is set before src/ loads
  await new Promise((resolve) => mockListingServer.listen(0, '127.0.0.1', resolve));
  const mockPort = mockListingServer.address().port;
  process.env.LISTING_SERVICE_URL = `http://127.0.0.1:${mockPort}`;

  // NOW load src/ modules (LISTING_SERVICE_URL is captured at require time)
  pool = require('../src/db');
  computeFee = require('../src/orderService').computeFee;
  const { buildApp } = require('../src/app');

  await pool.query(`
    TRUNCATE reviews, messages, order_events, orders, listings, users
    RESTART IDENTITY CASCADE
  `);

  const { rows: [buyer] } = await pool.query(
    `INSERT INTO users (name, email, role) VALUES ('Fee Buyer', 'feebuyer@fee.test', 'buyer') RETURNING id`
  );
  const { rows: [seller] } = await pool.query(
    `INSERT INTO users (name, email, role, stripe_account_id)
     VALUES ('Fee Seller', 'feeseller@fee.test', 'seller', 'acct_fee_test_seller') RETURNING id`
  );
  const { rows: [admin] } = await pool.query(
    `INSERT INTO users (name, email, role) VALUES ('Fee Admin', 'feeadmin@fee.test', 'admin') RETURNING id`
  );

  buyerId  = buyer.id;
  sellerId = seller.id;
  adminId  = admin.id;

  buyerToken  = jwt.sign({ sub: String(buyerId),  email: 'feebuyer@fee.test',  role: 'buyer'  }, JWT_SECRET);
  sellerToken = jwt.sign({ sub: String(sellerId), email: 'feeseller@fee.test', role: 'seller' }, JWT_SECRET);
  adminToken  = jwt.sign({ sub: String(adminId),  email: 'feeadmin@fee.test',  role: 'admin'  }, JWT_SECRET);

  mockMarkSoldOk   = true;
  mockMarkActiveOk = true;

  const app = buildApp();
  appServer = http.createServer(app);
  await new Promise((resolve) => appServer.listen(0, '127.0.0.1', resolve));
}

async function teardown() {
  await new Promise((resolve) => appServer.close(resolve));
  await new Promise((resolve) => mockListingServer.close(resolve));
  await pool.end();
}

// ── Order helpers ─────────────────────────────────────────────────────────

async function createOrderWithPrice(priceCents) {
  mockListing = {
    id: LISTING_ID,
    seller_id: sellerId,
    title: 'Fee Test Item',
    price_cents: priceCents,
    status: 'active',
  };
  const res = await post(appServer, '/orders', buyerToken, {
    listing_id: LISTING_ID,
    shipping_address: VALID_SHIPPING_ADDRESS,
  });
  if (res.status !== 201) throw new Error(`createOrder failed (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body;
}

async function captureOrder(orderId) {
  const res = await post(appServer, `/orders/${orderId}/capture`, buyerToken);
  if (res.status !== 200) throw new Error(`capture failed (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body;
}

async function driveToHeld(priceCents) {
  const order = await createOrderWithPrice(priceCents);
  return captureOrder(order.id);
}

async function driveToDelivered(priceCents) {
  const held = await driveToHeld(priceCents);
  const shipped = await post(appServer, `/orders/${held.id}/ship`, sellerToken);
  if (shipped.status !== 200) throw new Error(`ship failed`);
  const delivered = await post(appServer, `/orders/${held.id}/deliver`, sellerToken);
  if (delivered.status !== 200) throw new Error(`deliver failed`);
  return delivered.body;
}

// ── Section 1: computeFee unit tests ─────────────────────────────────────

function runUnitTests() {
  console.log('\n=== Fee Math — Unit Tests ===');
  console.log('\nAmount cases (8% fee, $2.00 minimum)');

  // $1.00 (100 cents): raw 8% = 8¢ → min $2.00 = 200¢ → capped at order amount 100¢
  test('$1.00: fee capped at order amount (100¢); payout = $0.00', () => {
    const { platformFeeCents, sellerPayoutCents } = computeFee(100);
    assertEqual(platformFeeCents,  100, 'fee must be capped to 100 cents');
    assertEqual(sellerPayoutCents,   0, 'payout must be 0 when fee equals order amount');
  });

  // $10.00 (1000 cents): raw 8% = 80¢ < $2.00 min → fee = $2.00
  test('$10.00: minimum fee applies; fee = $2.00, payout = $8.00', () => {
    const { platformFeeCents, sellerPayoutCents } = computeFee(1000);
    assertEqual(platformFeeCents,  200, 'fee must be minimum 200 cents');
    assertEqual(sellerPayoutCents, 800, 'payout must be 800 cents');
  });

  // $20.00 (2000 cents): raw 8% = $1.60 < $2.00 min → fee = $2.00
  test('$20.00: minimum fee applies; fee = $2.00, payout = $18.00', () => {
    const { platformFeeCents, sellerPayoutCents } = computeFee(2000);
    assertEqual(platformFeeCents,  200,  'fee must be minimum 200 cents');
    assertEqual(sellerPayoutCents, 1800, 'payout must be 1800 cents');
  });

  // $25.00 (2500 cents): raw 8% = $2.00 exactly = min → fee = $2.00
  test('$25.00: 8% exactly equals $2.00 minimum (breakeven); fee = $2.00, payout = $23.00', () => {
    const { platformFeeCents, sellerPayoutCents } = computeFee(2500);
    assertEqual(platformFeeCents,  200,  'fee must be exactly 200 cents at breakeven');
    assertEqual(sellerPayoutCents, 2300, 'payout must be 2300 cents');
  });

  // $50.00 (5000 cents): raw 8% = $4.00 > min → fee = $4.00
  test('$50.00: 8% rate applies; fee = $4.00, payout = $46.00', () => {
    const { platformFeeCents, sellerPayoutCents } = computeFee(5000);
    assertEqual(platformFeeCents,  400,  'fee must be 400 cents (8% of 5000)');
    assertEqual(sellerPayoutCents, 4600, 'payout must be 4600 cents');
  });

  // $100.00 (10000 cents): raw 8% = $8.00 → fee = $8.00
  test('$100.00: 8% rate applies; fee = $8.00, payout = $92.00', () => {
    const { platformFeeCents, sellerPayoutCents } = computeFee(10000);
    assertEqual(platformFeeCents,  800,  'fee must be 800 cents (8% of 10000)');
    assertEqual(sellerPayoutCents, 9200, 'payout must be 9200 cents');
  });

  // $200.00 (20000 cents): raw 8% = $16.00 → fee = $16.00, payout = $184.00
  // Shipping-aware scenario: if shipping=$18 then amount_cents=$218, but fee/payout are on item only.
  test('$200.00: 8% rate applies; fee = $16.00, payout = $184.00', () => {
    const { platformFeeCents, sellerPayoutCents } = computeFee(20000);
    assertEqual(platformFeeCents,  1600,  'fee must be 1600 cents (8% of 20000)');
    assertEqual(sellerPayoutCents, 18400, 'payout must be 18400 cents');
  });

  console.log('\nInvariants');

  test('fee + payout always equals item price across a wide range', () => {
    const amounts = [1, 50, 99, 100, 101, 150, 199, 200, 201, 249, 250, 251,
                     500, 999, 1000, 2499, 2500, 2501, 5000, 9999, 10000, 99999];
    for (const cents of amounts) {
      const { platformFeeCents, sellerPayoutCents } = computeFee(cents);
      if (platformFeeCents + sellerPayoutCents !== cents) {
        throw new Error(
          `fee(${platformFeeCents}) + payout(${sellerPayoutCents}) !== amount(${cents})`
        );
      }
    }
  });

  test('seller payout is never negative for any amount', () => {
    for (const cents of [1, 10, 50, 99, 100, 101, 150, 199, 200, 201, 250, 500, 1000]) {
      const { sellerPayoutCents } = computeFee(cents);
      if (sellerPayoutCents < 0) {
        throw new Error(`sellerPayoutCents(${sellerPayoutCents}) < 0 for amount=${cents}`);
      }
    }
  });

  test('platform fee never exceeds the order amount', () => {
    for (const cents of [1, 50, 99, 100, 101, 199, 200, 201, 250, 500, 1000, 2500, 10000]) {
      const { platformFeeCents } = computeFee(cents);
      if (platformFeeCents > cents) {
        throw new Error(`platformFeeCents(${platformFeeCents}) > amount(${cents})`);
      }
    }
  });

  console.log('\nRounding');

  // $24.99 (2499¢): 2499 * 800 / 10000 = 199.92 → round = 200¢ = min → fee = 200¢
  test('$24.99: raw 8% rounds to 200¢ (== minimum); fee = $2.00, payout = $22.99', () => {
    const { platformFeeCents, sellerPayoutCents } = computeFee(2499);
    assertEqual(platformFeeCents,  200,  'fee must be 200 cents');
    assertEqual(sellerPayoutCents, 2299, 'payout must be 2299 cents');
  });

  // $62.56 (6256¢): 6256 * 800 / 10000 = 500.48 → round = 500¢
  test('$62.56: 8% rounds down (500.48 → 500¢); fee = $5.00, payout = $57.56', () => {
    const { platformFeeCents, sellerPayoutCents } = computeFee(6256);
    assertEqual(platformFeeCents,  500,  'fee must round down to 500 cents');
    assertEqual(sellerPayoutCents, 5756, 'payout must be 5756 cents');
  });

  // $62.57 (6257¢): 6257 * 800 / 10000 = 500.56 → round = 501¢
  test('$62.57: 8% rounds up (500.56 → 501¢); fee = $5.01, payout = $57.56', () => {
    const { platformFeeCents, sellerPayoutCents } = computeFee(6257);
    assertEqual(platformFeeCents,  501,  'fee must round up to 501 cents');
    assertEqual(sellerPayoutCents, 5756, 'payout must be 5756 cents');
  });

  // $33.33 (3333¢): 3333 * 800 / 10000 = 266.64 → round = 267¢
  test('$33.33: 8% rounds up (266.64 → 267¢); fee = $2.67, payout = $30.66', () => {
    const { platformFeeCents, sellerPayoutCents } = computeFee(3333);
    assertEqual(platformFeeCents,  267,  'fee must be 267 cents');
    assertEqual(sellerPayoutCents, 3066, 'payout must be 3066 cents');
  });
}

// ── Section 2: Integration tests ──────────────────────────────────────────

async function runFeeAmountTests() {
  console.log('\n\n=== Fee Math — Integration Tests ===');
  console.log('\nFee amounts in API responses');

  const cases = [
    { priceCents: 100,   expectedFee: 100,  expectedPayout: 0,    label: '$1.00 (fee capped)' },
    { priceCents: 1000,  expectedFee: 200,  expectedPayout: 800,  label: '$10.00 (min applies)' },
    { priceCents: 2000,  expectedFee: 200,  expectedPayout: 1800, label: '$20.00 (min applies)' },
    { priceCents: 2500,  expectedFee: 200,  expectedPayout: 2300, label: '$25.00 (breakeven)' },
    { priceCents: 5000,  expectedFee: 400,  expectedPayout: 4600, label: '$50.00 (8% rate)' },
    { priceCents: 10000, expectedFee: 800,  expectedPayout: 9200, label: '$100.00 (8% rate)' },
  ];

  for (const { priceCents, expectedFee, expectedPayout, label } of cases) {
    await testAsync(`Order at ${label}: fee=${expectedFee}¢, payout=${expectedPayout}¢`, async () => {
      const order = await createOrderWithPrice(priceCents);
      assertEqual(order.item_price_cents,    priceCents,     'item_price_cents must match listing price');
      assertEqual(order.shipping_cents,      0,              'shipping_cents must be 0 (Phase 2)');
      assertEqual(order.amount_cents,        priceCents,     'amount_cents must equal item_price_cents when shipping=0');
      assertEqual(order.platform_fee_cents,  expectedFee,    'platform_fee_cents must match expected');
      assertEqual(order.seller_payout_cents, expectedPayout, 'seller_payout_cents must match expected');
      assertEqual(
        order.platform_fee_cents + order.seller_payout_cents,
        order.item_price_cents,
        'fee + payout must equal item_price_cents'
      );
    });
  }
}

async function runCancellationTests() {
  console.log('\nCancellation: buyer refund = amount − fee');

  // $100 order: fee = $8.00 (8%), buyer refund = $92.00
  await testAsync('$100.00 cancellation: refund = $92.00, platform keeps $8.00', async () => {
    const held = await driveToHeld(10000);
    const res = await post(appServer, `/orders/${held.id}/cancel`, buyerToken, { reason: 'changed mind' });
    assertEqual(res.status, 200, `cancel failed: ${JSON.stringify(res.body)}`);
    assertEqual(res.body.status, 'CANCELLED');
    assertEqual(res.body.cancellation_cause, 'buyer_change_of_mind', 'cancellation_cause must be buyer_change_of_mind');
    const event = res.body.events.find((e) => e.event_type === 'CANCELLED');
    assert(event, 'CANCELLED event required');
    assertEqual(event.payload.refundAmountCents,    9200, 'refundAmountCents must be 9200');
    assertEqual(event.payload.platformFeeKeptCents,  800, 'platformFeeKeptCents must be 800');
    assert(res.body.stripe_refund_id, 'stripe_refund_id must be set');
  });

  // $20 order: fee = $2.00 (minimum), buyer refund = $18.00
  await testAsync('$20.00 cancellation: minimum fee $2.00 kept, refund = $18.00', async () => {
    const held = await driveToHeld(2000);
    const res = await post(appServer, `/orders/${held.id}/cancel`, buyerToken, { reason: 'oops' });
    assertEqual(res.status, 200, `cancel failed: ${JSON.stringify(res.body)}`);
    const event = res.body.events.find((e) => e.event_type === 'CANCELLED');
    assertEqual(event.payload.refundAmountCents,    1800, 'refundAmountCents must be 1800');
    assertEqual(event.payload.platformFeeKeptCents,  200, 'platformFeeKeptCents must be 200');
  });

  // $1.00 order: fee = $1.00 (capped), buyer refund = $0 (no Stripe refund needed)
  await testAsync('$1.00 cancellation: fee covers full amount, refund = $0.00, no Stripe call', async () => {
    const held = await driveToHeld(100);
    const res = await post(appServer, `/orders/${held.id}/cancel`, buyerToken, { reason: 'tiny order' });
    assertEqual(res.status, 200, `cancel failed: ${JSON.stringify(res.body)}`);
    const event = res.body.events.find((e) => e.event_type === 'CANCELLED');
    assertEqual(event.payload.refundAmountCents,    0,   'refundAmountCents must be 0');
    assertEqual(event.payload.platformFeeKeptCents, 100, 'platformFeeKeptCents must be 100');
    // stripe_refund_id is null because no Stripe call was needed
    assert(res.body.stripe_refund_id == null, 'stripe_refund_id must be null for $0 refund');
  });
}

async function runDisputeRefundTests() {
  console.log('\nBuyer dispute refund: buyer receives full amount');

  // $50 order: buyer wins → full $50.00 refunded, platform absorbs fee
  await testAsync('$50.00 dispute refund: full amount returned to buyer', async () => {
    const delivered = await driveToDelivered(5000);
    const disputeRes = await post(appServer, `/orders/${delivered.id}/dispute`, buyerToken, { reason: 'Item never arrived' });
    assertEqual(disputeRes.status, 200);

    const resolveRes = await post(appServer, `/admin/orders/${delivered.id}/resolve`, adminToken, { action: 'refund' });
    assertEqual(resolveRes.status, 200, `resolve failed: ${JSON.stringify(resolveRes.body)}`);
    assertEqual(resolveRes.body.status, 'REFUNDED');
    assert(resolveRes.body.stripe_refund_id, 'stripe_refund_id must be set');
    assert(resolveRes.body.events.some((e) => e.event_type === 'REFUNDED'), 'REFUNDED event required');
    // amount_cents is the full buyer charge — refund covers the whole amount
    assertEqual(resolveRes.body.amount_cents, 5000, 'order amount_cents must be 5000');
  });
}

async function runSellerReleaseTests() {
  console.log('\nSeller release: seller payout = amount − fee');

  // $100 order: seller receives $92.00 (amount - 8% fee)
  await testAsync('$100.00 release: seller_payout_cents = 9200 used for Stripe transfer', async () => {
    const delivered = await driveToDelivered(10000);
    const confirmed = await post(appServer, `/orders/${delivered.id}/confirm`, buyerToken);
    assertEqual(confirmed.status, 200, `confirm failed: ${JSON.stringify(confirmed.body)}`);
    assertEqual(confirmed.body.status, 'RELEASED');
    assert(confirmed.body.stripe_transfer_id, 'stripe_transfer_id must be set');
    const event = confirmed.body.events.find((e) => e.event_type === 'RELEASED');
    assertEqual(event.payload.sellerPayoutCents, 9200, 'sellerPayoutCents in event must be 9200');
    assertEqual(event.payload.platformFeeCents,   800, 'platformFeeCents in event must be 800');
  });

  // $25 order: seller receives $23.00 (8% = $2.00 at breakeven)
  await testAsync('$25.00 release: seller_payout_cents = 2300 (breakeven)', async () => {
    const delivered = await driveToDelivered(2500);
    const confirmed = await post(appServer, `/orders/${delivered.id}/confirm`, buyerToken);
    assertEqual(confirmed.status, 200);
    const event = confirmed.body.events.find((e) => e.event_type === 'RELEASED');
    assertEqual(event.payload.sellerPayoutCents, 2300, 'sellerPayoutCents must be 2300');
    assertEqual(event.payload.platformFeeCents,   200, 'platformFeeCents must be 200');
  });
}

// ── Main ──────────────────────────────────────────────────────────────────

(async () => {
  try {
    await setup();

    // Unit tests (computeFee is now loaded)
    runUnitTests();

    // Integration tests
    await runFeeAmountTests();
    await runCancellationTests();
    await runDisputeRefundTests();
    await runSellerReleaseTests();
  } finally {
    await teardown();
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();

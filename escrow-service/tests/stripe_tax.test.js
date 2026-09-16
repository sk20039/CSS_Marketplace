// tests/stripe_tax.test.js
//
// Focused integration tests for the Stripe Tax integration.
// Run: node tests/stripe_tax.test.js
// Exit code 0 = all passed, 1 = any failed.
//
// Uses the stub Stripe client (no real Stripe calls).
// Monkey-patches stripeClient methods to simulate non-zero tax and failures.
//
// Prerequisites:
//   DATABASE_URL_TEST set (escrow_db_test with migrations applied including stripe_tax).

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
process.env.JWT_SECRET   = process.env.JWT_SECRET || 'change-me';
delete process.env.STRIPE_SECRET_KEY; // force stub mode
process.env.EVIDENCE_DIR = require('os').tmpdir() + '/escrow_tax_test_' + Date.now();

const http = require('http');
const jwt  = require('jsonwebtoken');

const SELLER_SHIP_ZIP = '77001';

// Simulated TX tax: 8.25% of $100 item = $8.25 = 825 cents (rounded)
const TX_TAX_CENTS = 825;

// ---------------------------------------------------------------------------
// Mock listing-service
// ---------------------------------------------------------------------------

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
    const addr    = server.address();
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: '127.0.0.1',
      port:     addr.port,
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

const LISTING_ID = 997;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';

const VALID_SHIPPING_ADDRESS = {
  name:  'Tax Buyer',
  line1: '1000 Main St',
  city:  'Houston',
  state: 'TX',
  zip:   '77002',
};

let pool, appServer, stripeClient, runTaxReconciliation;
let buyerId, sellerId, adminId;
let buyerToken, sellerToken, adminToken;

// ---------------------------------------------------------------------------
// Patch helpers (restore is called in finally blocks)
// ---------------------------------------------------------------------------

function patchCalculateTax(taxAmount) {
  const saved = stripeClient.calculateTax.bind(stripeClient);
  stripeClient.calculateTax = async () => ({
    id:                  `txc_test_${Date.now()}`,
    tax_amount_exclusive: taxAmount,
  });
  return () => { stripeClient.calculateTax = saved; };
}

function patchFinalizeToFail() {
  const saved = stripeClient.finalizeTaxTransaction;
  stripeClient.finalizeTaxTransaction = async () => {
    throw new Error('Simulated Stripe finalization outage');
  };
  return () => { stripeClient.finalizeTaxTransaction = saved; };
}

function patchReverseToFail() {
  const saved = stripeClient.reverseTaxTransaction;
  stripeClient.reverseTaxTransaction = async () => {
    throw new Error('Simulated Stripe reversal outage');
  };
  return () => { stripeClient.reverseTaxTransaction = saved; };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

async function setup() {
  await new Promise((resolve) => mockListingServer.listen(0, '127.0.0.1', resolve));
  process.env.LISTING_SERVICE_URL = `http://127.0.0.1:${mockListingServer.address().port}`;

  pool               = require('../src/db');
  stripeClient       = require('../src/stripeClient').stripeClient;
  const orderService = require('../src/orderService');
  runTaxReconciliation = orderService.runTaxReconciliation;
  const { buildApp } = require('../src/app');

  await pool.query(`
    TRUNCATE reviews, messages, order_events, orders, listings, users
    RESTART IDENTITY CASCADE
  `);

  const { rows: [buyer] } = await pool.query(
    `INSERT INTO users (name, email, role)
     VALUES ('Tax Buyer', 'taxbuyer@tax.test', 'buyer') RETURNING id`
  );
  const { rows: [seller] } = await pool.query(
    `INSERT INTO users (name, email, role, stripe_account_id, ship_from_address)
     VALUES ('Tax Seller', 'taxseller@tax.test', 'seller', 'acct_tax_test_seller', $1) RETURNING id`,
    [JSON.stringify({ name: 'Tax Seller', line1: '123 Tax Rd', city: 'Houston', state: 'TX', zip: SELLER_SHIP_ZIP, phone: '5550001111' })]
  );
  const { rows: [admin] } = await pool.query(
    `INSERT INTO users (name, email, role) VALUES ('Tax Admin', 'taxadmin@tax.test', 'admin') RETURNING id`
  );

  buyerId  = buyer.id;
  sellerId = seller.id;
  adminId  = admin.id;

  buyerToken  = jwt.sign({ sub: String(buyerId),  email: 'taxbuyer@tax.test',  role: 'buyer'  }, JWT_SECRET);
  sellerToken = jwt.sign({ sub: String(sellerId), email: 'taxseller@tax.test', role: 'seller' }, JWT_SECRET);
  adminToken  = jwt.sign({ sub: String(adminId),  email: 'taxadmin@tax.test',  role: 'admin'  }, JWT_SECRET);

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
// Order helpers
// ---------------------------------------------------------------------------

function setMockListing(priceCents) {
  mockListing = {
    id:          LISTING_ID,
    seller_id:   sellerId,
    title:       'Tax Test Item',
    price_cents: priceCents,
    status:      'active',
  };
}

async function createOrderWithPrice(priceCents) {
  setMockListing(priceCents);
  const res = await post(appServer, '/orders', buyerToken, {
    listing_id:       LISTING_ID,
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
  // No purchase-label here: tax tests exercise tax math, not label purchasing.
  // Without a label_id the seller can call /ship directly (same as fee.test.js).
  const shipped = await post(appServer, `/orders/${held.id}/ship`, sellerToken);
  if (shipped.status !== 200) throw new Error(`ship failed: ${JSON.stringify(shipped.body)}`);
  const delivered = await post(appServer, `/orders/${held.id}/deliver`, adminToken);
  if (delivered.status !== 200) throw new Error(`deliver failed`);
  return delivered.body;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  console.log('\n=== Stripe Tax Integration Tests ===\n');

  // ── 1. Zero tax (default stub behavior) ─────────────────────────────────
  console.log('Tax calculation');

  await test('zero tax result: tax_cents=0, amount_cents = item only', async () => {
    const order = await createOrderWithPrice(10000);
    assertEqual(order.tax_cents,    0,     'tax_cents must be 0 in stub mode');
    assert(order.tax_calculation_id,       'tax_calculation_id must be set');
    assertEqual(order.amount_cents, 10000, 'amount_cents = item_price_cents when tax=0 and shipping=0');
  });

  // ── 2. Non-zero Texas tax ────────────────────────────────────────────────
  await test('Texas taxable order: tax_cents stored, amount includes tax', async () => {
    const restore = patchCalculateTax(TX_TAX_CENTS);
    try {
      const order = await createOrderWithPrice(10000);
      assertEqual(order.tax_cents,      TX_TAX_CENTS,                'tax_cents must match Stripe Tax result');
      assertEqual(order.amount_cents,   10000 + TX_TAX_CENTS,        'amount_cents = item + tax (no shipping for buyers)');
    } finally {
      restore();
    }
  });

  // ── 3. item + shipping + tax = PI total ──────────────────────────────────
  await test('item + tax equals PaymentIntent (order.amount_cents)', async () => {
    const restore = patchCalculateTax(TX_TAX_CENTS);
    try {
      const order = await createOrderWithPrice(5000);
      const expectedTotal = 5000 + TX_TAX_CENTS;
      assertEqual(order.amount_cents, expectedTotal, 'amount_cents must be item + tax (shipping=0)');
      assertEqual(order.item_price_cents + order.shipping_cents + order.tax_cents, order.amount_cents,
        'item_price_cents + shipping_cents + tax_cents must equal amount_cents');
    } finally {
      restore();
    }
  });

  // ── 4. Platform fee stays item-price-only when tax is non-zero ───────────
  console.log('\nFee isolation');

  await test('8% platform fee is on item price only, not item+tax', async () => {
    const restore = patchCalculateTax(TX_TAX_CENTS);
    try {
      const ITEM_PRICE = 10000; // $100 → 8% = $8.00 = 800 cents
      const order = await createOrderWithPrice(ITEM_PRICE);
      assertEqual(order.platform_fee_cents,  800,  'fee must be 8% of item_price_cents = 800');
      assertEqual(order.seller_payout_cents, 9200, 'payout must be item_price_cents - fee = 9200');
      assertEqual(
        order.platform_fee_cents + order.seller_payout_cents,
        order.item_price_cents,
        'fee + payout must equal item_price_cents, not amount_cents'
      );
    } finally {
      restore();
    }
  });

  // ── 5. Seller payout unchanged by tax ────────────────────────────────────
  await test('seller_payout_cents is unchanged by tax; transfer uses pre-tax payout', async () => {
    const restore = patchCalculateTax(TX_TAX_CENTS);
    try {
      const delivered  = await driveToDelivered(10000);
      const confirmed  = await post(appServer, `/orders/${delivered.id}/confirm`, buyerToken);
      assertEqual(confirmed.status, 200, `confirm failed: ${JSON.stringify(confirmed.body)}`);
      assertEqual(confirmed.body.status, 'RELEASED');
      const event = confirmed.body.events.find((e) => e.event_type === 'RELEASED');
      assert(event, 'RELEASED event required');
      // Payout = item - fee = 10000 - 800 = 9200 (tax is not in the payout base)
      assertEqual(event.payload.sellerPayoutCents, 9200, 'sellerPayoutCents must be 9200 (item - fee only)');
      assertEqual(event.payload.platformFeeCents,   800, 'platformFeeCents must be 800');
    } finally {
      restore();
    }
  });

  // ── 6. Full dispute refund includes tax ──────────────────────────────────
  console.log('\nRefund paths');

  await test('dispute refund: refund amount = item + tax (full amount_cents, no shipping)', async () => {
    const restore = patchCalculateTax(TX_TAX_CENTS);
    try {
      const delivered  = await driveToDelivered(10000);
      const orderId    = delivered.id;
      const expectedTotal = 10000 + TX_TAX_CENTS; // no shipping (free shipping model)
      assertEqual(delivered.amount_cents, expectedTotal, 'amount_cents must be item + tax (no shipping)');

      await post(appServer, `/orders/${orderId}/dispute`, buyerToken, { reason: 'Item never arrived' });
      const resolved = await post(appServer, `/admin/orders/${orderId}/resolve`, adminToken, { action: 'refund' });
      assertEqual(resolved.status, 200, `resolve failed: ${JSON.stringify(resolved.body)}`);
      assertEqual(resolved.body.status, 'REFUNDED');

      // Stripe refund is called with order.amount_cents which includes tax.
      // Verify by checking the stub's internal refund record.
      const refunds = stripeClient._refunds;
      const lastRefund = refunds[refunds.length - 1];
      assertEqual(lastRefund.amountCents, expectedTotal,
        'Stripe refund amount must equal amount_cents (item + tax, no shipping)');
    } finally {
      restore();
    }
  });

  // ── 7. Cancellation refund includes tax; platform retains fee only ────────
  await test('cancellation: refund = amount_cents - platform_fee (includes full tax)', async () => {
    const restore = patchCalculateTax(TX_TAX_CENTS);
    try {
      const held = await driveToHeld(10000);
      const expectedAmount = 10000 + TX_TAX_CENTS; // amount_cents (no shipping, free shipping model)
      const expectedFee    = 800; // 8% of item only
      const expectedRefund = expectedAmount - expectedFee;

      const cancelled = await post(appServer, `/orders/${held.id}/cancel`, buyerToken, { reason: 'changed mind' });
      assertEqual(cancelled.status, 200, `cancel failed: ${JSON.stringify(cancelled.body)}`);
      assertEqual(cancelled.body.status, 'CANCELLED');

      const event = cancelled.body.events.find((e) => e.event_type === 'CANCELLED');
      assert(event, 'CANCELLED event required');
      assertEqual(event.payload.refundAmountCents,    expectedRefund, `refund must be amount-fee = ${expectedRefund}`);
      assertEqual(event.payload.platformFeeKeptCents, expectedFee,   'platform keeps fee only (not tax)');

      // Verify Stripe stub received correct refund amount
      const refunds = stripeClient._refunds;
      const lastRefund = refunds[refunds.length - 1];
      assertEqual(lastRefund.amountCents, expectedRefund,
        'Stripe refund amount must equal amount_cents - platform_fee');
    } finally {
      restore();
    }
  });

  // ── 8. Successful tax transaction finalization ───────────────────────────
  console.log('\nTax transaction lifecycle');

  await test('successful finalization: stripe_tax_transaction_id set after capture', async () => {
    const restore = patchCalculateTax(TX_TAX_CENTS);
    try {
      const order    = await createOrderWithPrice(10000);
      const captured = await captureOrder(order.id);

      assert(captured.stripe_tax_transaction_id,
        'stripe_tax_transaction_id must be set after successful finalization');
      assert(captured.events.some((e) => e.event_type === 'TAX_TRANSACTION_FINALIZED'),
        'TAX_TRANSACTION_FINALIZED event must be present');
      assert(!captured.events.some((e) => e.event_type === 'TAX_TRANSACTION_FINALIZE_FAILED'),
        'no failure event expected on success');
    } finally {
      restore();
    }
  });

  // ── 9. Failed finalization recovered by reconciliation without duplication
  await test('failed finalization: recovered by reconciliation sweep, no duplication', async () => {
    const restoreCalc     = patchCalculateTax(TX_TAX_CENTS);
    const restoreFinalize = patchFinalizeToFail();
    let orderId;
    try {
      const order    = await createOrderWithPrice(10000);
      orderId        = order.id;
      const captured = await captureOrder(orderId);

      // captured IS the order object (captureOrder helper asserts HTTP 200)
      assert(!captured.stripe_tax_transaction_id,
        'stripe_tax_transaction_id must be NULL when finalization failed');
      assert(captured.events.some((e) => e.event_type === 'TAX_TRANSACTION_FINALIZE_FAILED'),
        'TAX_TRANSACTION_FINALIZE_FAILED event must be present');
    } finally {
      restoreCalc();
      restoreFinalize();
    }

    // Run reconciliation — should finalize
    const result1 = await runTaxReconciliation();
    assert(result1.finalizedIds.some((id) => id === orderId),
      'reconciliation must include the pending order');

    // Verify DB state
    const { rows } = await pool.query(
      'SELECT stripe_tax_transaction_id FROM orders WHERE id = $1', [orderId]
    );
    assert(rows[0].stripe_tax_transaction_id, 'stripe_tax_transaction_id must be set after reconciliation');

    // Verify only one TAX_TRANSACTION_FINALIZED event
    const { rows: events1 } = await pool.query(
      `SELECT id FROM order_events WHERE order_id = $1 AND event_type = 'TAX_TRANSACTION_FINALIZED'`,
      [orderId]
    );
    assertEqual(events1.length, 1, 'exactly one TAX_TRANSACTION_FINALIZED event after first reconciliation');

    // Run reconciliation again — should NOT re-finalize (order no longer in sweep)
    const result2 = await runTaxReconciliation();
    assert(!result2.finalizedIds.some((id) => id === orderId),
      'second reconciliation must not re-process already-finalized order');

    // Event count must still be 1
    const { rows: events2 } = await pool.query(
      `SELECT id FROM order_events WHERE order_id = $1 AND event_type = 'TAX_TRANSACTION_FINALIZED'`,
      [orderId]
    );
    assertEqual(events2.length, 1, 'no duplicate TAX_TRANSACTION_FINALIZED event after second reconciliation');
  });

  // ── 10. Successful tax reversal ──────────────────────────────────────────
  await test('successful reversal: stripe_tax_reversal_id set after dispute refund', async () => {
    const restore = patchCalculateTax(TX_TAX_CENTS);
    try {
      const delivered = await driveToDelivered(10000);
      await post(appServer, `/orders/${delivered.id}/dispute`, buyerToken, { reason: 'Item is broken' });
      const resolved = await post(appServer, `/admin/orders/${delivered.id}/resolve`, adminToken, { action: 'refund' });

      assertEqual(resolved.status, 200);
      assert(resolved.body.stripe_tax_reversal_id,
        'stripe_tax_reversal_id must be set after successful reversal');
      assert(resolved.body.events.some((e) => e.event_type === 'TAX_TRANSACTION_REVERSED'),
        'TAX_TRANSACTION_REVERSED event must be present');
    } finally {
      restore();
    }
  });

  // ── 11. Failed reversal recovered by reconciliation without duplication ──
  await test('failed reversal: recovered by reconciliation sweep, no duplication', async () => {
    const restoreCalc    = patchCalculateTax(TX_TAX_CENTS);
    let orderId;
    let captured;

    // Create and capture first (finalization must succeed before we test reversal recovery)
    try {
      const order = await createOrderWithPrice(10000);
      orderId     = order.id;
      captured    = await captureOrder(orderId);
      assert(captured.stripe_tax_transaction_id, 'need finalized tax transaction for reversal test');
    } finally {
      restoreCalc();
    }

    // Drive to HELD (already there after capture) then cancel with reversal patched to fail
    const restoreReverse = patchReverseToFail();
    try {
      const cancelled = await post(appServer, `/orders/${orderId}/cancel`, buyerToken, { reason: 'reversal failure test' });
      assertEqual(cancelled.status, 200, `cancel failed: ${JSON.stringify(cancelled.body)}`);
      assertEqual(cancelled.body.status, 'CANCELLED');

      assert(!cancelled.body.stripe_tax_reversal_id,
        'stripe_tax_reversal_id must be NULL when reversal failed');
      assert(cancelled.body.events.some((e) => e.event_type === 'TAX_TRANSACTION_REVERSAL_FAILED'),
        'TAX_TRANSACTION_REVERSAL_FAILED event must be present');
    } finally {
      restoreReverse();
    }

    // Run reconciliation — should reverse
    const result1 = await runTaxReconciliation();
    assert(result1.reversedIds.some((id) => id === orderId),
      'reconciliation must include the pending reversal order');

    // Verify DB
    const { rows } = await pool.query(
      'SELECT stripe_tax_reversal_id FROM orders WHERE id = $1', [orderId]
    );
    assert(rows[0].stripe_tax_reversal_id, 'stripe_tax_reversal_id must be set after reconciliation');

    // Verify single event
    const { rows: events1 } = await pool.query(
      `SELECT id FROM order_events WHERE order_id = $1 AND event_type = 'TAX_TRANSACTION_REVERSED'`,
      [orderId]
    );
    assertEqual(events1.length, 1, 'exactly one TAX_TRANSACTION_REVERSED event after first reconciliation');

    // Second reconciliation must not re-process
    const result2 = await runTaxReconciliation();
    assert(!result2.reversedIds.some((id) => id === orderId),
      'second reconciliation must not re-process already-reversed order');

    const { rows: events2 } = await pool.query(
      `SELECT id FROM order_events WHERE order_id = $1 AND event_type = 'TAX_TRANSACTION_REVERSED'`,
      [orderId]
    );
    assertEqual(events2.length, 1, 'no duplicate TAX_TRANSACTION_REVERSED event after second reconciliation');
  });

  // ── 12. Existing orders with tax_cents = 0 remain compatible ─────────────
  console.log('\nBackwards compatibility');

  await test('existing order (tax_calculation_id=NULL) processes through full lifecycle', async () => {
    // Create an order normally (stub gives 0 tax + fake calculation_id)
    const order = await createOrderWithPrice(10000);

    // Simulate pre-feature order by nulling tax columns (as if order was inserted before migration)
    await pool.query(
      'UPDATE orders SET tax_cents = 0, tax_calculation_id = NULL WHERE id = $1',
      [order.id]
    );

    // Capture — should succeed; tax finalization is skipped (no calculation_id)
    const captured = await captureOrder(order.id);
    assertEqual(captured.status, 'HELD');
    assert(!captured.events.some((e) => e.event_type === 'TAX_TRANSACTION_FINALIZED'),
      'no TAX_TRANSACTION_FINALIZED event when tax_calculation_id is NULL');
    assert(!captured.events.some((e) => e.event_type === 'TAX_TRANSACTION_FINALIZE_FAILED'),
      'no failure event for pre-feature order');

    // Cancel — should succeed; reversal is skipped (no stripe_tax_transaction_id)
    const cancelled = await post(appServer, `/orders/${captured.id}/cancel`, buyerToken, { reason: 'compat test' });
    assertEqual(cancelled.status, 200);
    assertEqual(cancelled.body.status, 'CANCELLED');
    assert(!cancelled.body.events.some((e) => e.event_type === 'TAX_TRANSACTION_REVERSED'),
      'no TAX_TRANSACTION_REVERSED event when stripe_tax_transaction_id is NULL');

    // Reconciliation sweep: pre-feature order must not appear in any sweep results
    const reconResult = await runTaxReconciliation();
    assert(!reconResult.finalizedIds.some((id) => id === order.id),
      'pre-feature order must not appear in finalization sweep');
    assert(!reconResult.reversedIds.some((id) => id === order.id),
      'pre-feature order must not appear in reversal sweep');
  });

  await test('existing order (tax_cents=0) full release lifecycle works', async () => {
    const order = await createOrderWithPrice(5000);
    await pool.query(
      'UPDATE orders SET tax_cents = 0, tax_calculation_id = NULL WHERE id = $1',
      [order.id]
    );

    // Drive to DELIVERED: capture → ship → deliver → confirm
    const held = await captureOrder(order.id);
    assertEqual(held.status, 'HELD');

    const shipped = await post(appServer, `/orders/${order.id}/ship`, sellerToken);
    assertEqual(shipped.status, 200, `ship failed: ${JSON.stringify(shipped.body)}`);

    const delivered = await post(appServer, `/orders/${order.id}/deliver`, adminToken);
    assertEqual(delivered.status, 200);

    const confirmed = await post(appServer, `/orders/${order.id}/confirm`, buyerToken);
    assertEqual(confirmed.status, 200);
    assertEqual(confirmed.body.status, 'RELEASED');
    assert(!confirmed.body.events.some((e) => e.event_type === 'TAX_TRANSACTION_REVERSED'),
      'no tax reversal on release (no stripe_tax_transaction_id)');
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  try {
    await setup();
    await runTests();
  } finally {
    await teardown();
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();

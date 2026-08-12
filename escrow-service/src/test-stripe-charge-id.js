// Test: stripe_charge_id is persisted after capture and used as source_transaction
// during seller release. Runs entirely in stub mode — no real Stripe key required.
//
// Usage (from repo root):
//   node escrow-service/src/test-stripe-charge-id.js
//
// Uses an isolated test DB so it does not touch production data.

'use strict';

const path = require('path');

// Set test DB path BEFORE any module is required so all singletons use it.
process.env.DB_PATH = path.join(__dirname, '..', 'data', 'test-charge-id.sqlite3');

const db = require('./db');
const { stripeClient } = require('./stripeClient');
const orderService = require('./orderService');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

async function run() {
  console.log('\n=== Test: stripe_charge_id persistence and seller transfer ===\n');

  // --- Setup: isolated test users and listing (high IDs avoid collisions with seed data) ---
  db.prepare(
    'INSERT OR IGNORE INTO users (id, name, email, role, stripe_account_id) VALUES (9001, ?, ?, ?, ?)'
  ).run('Test Seller', 'testseller@charge-test.local', 'seller', 'acct_test_seller_9001');

  db.prepare(
    'INSERT OR IGNORE INTO users (id, name, email, role) VALUES (9002, ?, ?, ?)'
  ).run('Test Buyer', 'testbuyer@charge-test.local', 'buyer');

  db.prepare(
    'INSERT OR IGNORE INTO listings (id, seller_id, title, price_cents) VALUES (9001, 9001, ?, ?)'
  ).run('Test Bat', 10000);

  // --- Create a stub PaymentIntent so capturePaymentIntent can look it up ---
  const intent = await stripeClient.createPaymentIntent({ amountCents: 10000, currency: 'usd' });
  console.log(`Stub PI created: ${intent.id}`);

  // --- Insert order directly (bypasses fetchAuthoritativeListing HTTP call) ---
  const ts = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO orders
      (listing_id, buyer_id, seller_id, amount_cents, platform_fee_cents, seller_payout_cents,
       status, stripe_payment_intent_id, stripe_client_secret, created_at, updated_at)
    VALUES (9001, 9002, 9001, 10000, 300, 9700, 'CREATED', ?, ?, ?, ?)
  `).run(intent.id, intent.client_secret || null, ts, ts);
  const orderId = result.lastInsertRowid;
  console.log(`Test order created: id=${orderId}\n`);

  // ----------------------------------------------------------------
  // [1] captureOrder must store stripe_charge_id
  // ----------------------------------------------------------------
  console.log('[1] captureOrder');
  await orderService.captureOrder(orderId);
  const afterCapture = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);

  assert(afterCapture.status === 'HELD', 'status becomes HELD');
  assert(!!afterCapture.stripe_charge_id, 'stripe_charge_id is non-null after capture');
  assert(
    afterCapture.stripe_charge_id !== afterCapture.stripe_payment_intent_id,
    `stripe_charge_id (${afterCapture.stripe_charge_id}) differs from stripe_payment_intent_id`
  );
  assert(
    afterCapture.stripe_charge_id.startsWith('ch_'),
    `stripe_charge_id starts with ch_ (got: ${afterCapture.stripe_charge_id})`
  );

  // ----------------------------------------------------------------
  // [2] shipOrder → deliverOrder
  // ----------------------------------------------------------------
  console.log('\n[2] shipOrder and deliverOrder');
  orderService.shipOrder(orderId);
  orderService.deliverOrder(orderId);
  const afterDeliver = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
  assert(afterDeliver.status === 'DELIVERED', 'status is DELIVERED before confirm');

  // ----------------------------------------------------------------
  // [3] confirmOrder triggers performRelease using stripe_charge_id
  // ----------------------------------------------------------------
  console.log('\n[3] confirmOrder (triggers performRelease)');
  const released = await orderService.confirmOrder(orderId);

  assert(released.status === 'RELEASED', 'order reaches RELEASED status');

  const releasedEvent = released.events.find(e => e.event_type === 'RELEASED');
  assert(!!releasedEvent, 'RELEASED event recorded in timeline');
  assert(
    releasedEvent && releasedEvent.payload.sellerPayoutCents === 9700,
    `seller payout is 9700 cents (10000 - 300 fee), got: ${releasedEvent && releasedEvent.payload.sellerPayoutCents}`
  );
  assert(
    releasedEvent && releasedEvent.payload.platformFeeCents === 300,
    `platform fee retained is 300 cents, got: ${releasedEvent && releasedEvent.payload.platformFeeCents}`
  );

  // ----------------------------------------------------------------
  // [4] Old-order fallback: an order without stripe_charge_id should still
  //     release (falling back to stripe_payment_intent_id) rather than crash.
  // ----------------------------------------------------------------
  console.log('\n[4] Fallback: release works for pre-migration order (no stripe_charge_id)');
  const intent2 = await stripeClient.createPaymentIntent({ amountCents: 5000, currency: 'usd' });
  const ts2 = new Date().toISOString();
  const r2 = db.prepare(`
    INSERT INTO orders
      (listing_id, buyer_id, seller_id, amount_cents, platform_fee_cents, seller_payout_cents,
       status, stripe_payment_intent_id, created_at, updated_at)
    VALUES (9001, 9002, 9001, 5000, 150, 4850, 'CREATED', ?, ?, ?)
  `).run(intent2.id, ts2, ts2);
  const orderId2 = r2.lastInsertRowid;

  // Capture via stub but manually clear stripe_charge_id to simulate a pre-migration row
  await orderService.captureOrder(orderId2);
  db.prepare('UPDATE orders SET stripe_charge_id = NULL WHERE id = ?').run(orderId2);
  orderService.shipOrder(orderId2);
  orderService.deliverOrder(orderId2);

  let fallbackError = null;
  try {
    await orderService.confirmOrder(orderId2);
  } catch (err) {
    fallbackError = err;
  }
  const afterFallback = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId2);
  assert(!fallbackError, `no error thrown for pre-migration order (got: ${fallbackError && fallbackError.message})`);
  assert(afterFallback.status === 'RELEASED', 'pre-migration order reaches RELEASED via fallback');

  // ----------------------------------------------------------------
  // Cleanup
  // ----------------------------------------------------------------
  for (const oid of [orderId, orderId2]) {
    db.prepare('DELETE FROM order_events WHERE order_id = ?').run(oid);
    db.prepare('DELETE FROM orders WHERE id = ?').run(oid);
  }
  db.prepare('DELETE FROM listings WHERE id = 9001').run();
  db.prepare('DELETE FROM users WHERE id IN (9001, 9002)').run();

  // ----------------------------------------------------------------
  // Summary
  // ----------------------------------------------------------------
  console.log(`\n${'='.repeat(52)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('SOME TESTS FAILED');
    process.exit(1);
  } else {
    console.log('ALL TESTS PASSED');
  }
}

run().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});

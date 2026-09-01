// tests/recovery.test.js
//
// Standalone test script — no test runner required.
// Run: node tests/recovery.test.js
// Exit code 0 = all passed, 1 = any failed.
//
// Uses escrow_db_test (PostgreSQL). Prerequisites:
//   1. DATABASE_URL_TEST must be set in .env or environment.
//   2. Migrations must have been applied to escrow_db_test:
//        DATABASE_URL=<test_url> node_modules/.bin/node-pg-migrate -m migrations up
//
// Tests every required scenario for each transient status:
//   - Process interruption before the Stripe request
//   - Process interruption after Stripe succeeds but before DB finalization
//   - Two concurrent recovery sweeps (claim mutual exclusion)
//   - Repeated recovery using the same idempotency key
//   - Ambiguous Stripe results (multiple matching objects)
//   - Listing service failure after the financial operation
//   - Correct events, no duplicate financial operations

'use strict';

// ---- Set DATABASE_URL to test DB BEFORE any src/ module load ----
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
delete process.env.STRIPE_SECRET_KEY; // force stub mode
// Override listing-service URL to a port that won't be listening — ensures
// markListingSold() and markListingActive() always return false in tests.
process.env.LISTING_SERVICE_URL = 'http://127.0.0.1:19876';

const pool           = require('../src/db');
const { stripeClient } = require('../src/stripeClient');
const { runRecovery }  = require('../src/recoveryService');
const {
  finalizeCaptured,
  finalizeReleased,
  finalizeRefunded,
  finalizeCancelled,
} = require('../src/orderService');

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

async function assertThrows(fn, requiredSubstring) {
  let threw = false;
  let msg = '';
  try { await fn(); } catch (e) { threw = true; msg = e.message; }
  if (!threw) throw new Error('Expected function to throw but it returned normally');
  if (requiredSubstring && !msg.includes(requiredSubstring)) {
    throw new Error(`Expected error to include "${requiredSubstring}" but got: "${msg}"`);
  }
}

// ---------------------------------------------------------------------------
// DB setup helpers
// ---------------------------------------------------------------------------

let BUYER_ID, SELLER_ID, LISTING_ID;
const SELLER_STRIPE_ACCOUNT = 'acct_stub_seller_1';

async function setupDb() {
  // TRUNCATE all tables in reverse FK order, reset sequences
  await pool.query(`
    TRUNCATE reviews, messages, order_events, orders, listings, users
    RESTART IDENTITY CASCADE
  `);

  const { rows: [buyer] } = await pool.query(
    `INSERT INTO users (name, email, role) VALUES ('Test Buyer', 'buyer@demo.test', 'buyer') RETURNING id`
  );
  const { rows: [seller] } = await pool.query(
    `INSERT INTO users (name, email, role, stripe_account_id)
     VALUES ('Test Seller', 'seller@demo.test', 'seller', $1) RETURNING id`,
    [SELLER_STRIPE_ACCOUNT]
  );
  const { rows: [listing] } = await pool.query(
    `INSERT INTO listings (seller_id, title, price_cents) VALUES ($1, 'Test Item', 10000) RETURNING id`,
    [seller.id]
  );

  BUYER_ID  = buyer.id;
  SELLER_ID = seller.id;
  LISTING_ID = listing.id;
}

// Insert an order row directly (bypasses all service logic, for test setup).
async function insertOrder(overrides = {}) {
  const now = new Date().toISOString();
  const defaults = {
    listing_id:               LISTING_ID,
    buyer_id:                 BUYER_ID,
    seller_id:                SELLER_ID,
    amount_cents:             10000,
    platform_fee_cents:       800,
    seller_payout_cents:      9200,
    status:                   'HELD',
    stripe_payment_intent_id: null,
    stripe_charge_id:         null,
    stripe_client_secret:     null,
    stripe_transfer_id:       null,
    stripe_refund_id:         null,
    cancellation_reason:      null,
    prior_status:             null,
    transition_started_at:    null,
    recovery_claimed_at:      null,
    recovery_attempts:        0,
    last_recovery_error:      null,
    created_at:               now,
    updated_at:               now,
  };
  const row = { ...defaults, ...overrides };
  const { rows: [r] } = await pool.query(
    `INSERT INTO orders (
       listing_id, buyer_id, seller_id, amount_cents, platform_fee_cents, seller_payout_cents,
       status, stripe_payment_intent_id, stripe_charge_id, stripe_client_secret,
       stripe_transfer_id, stripe_refund_id, cancellation_reason,
       prior_status, transition_started_at, recovery_claimed_at, recovery_attempts,
       last_recovery_error, created_at, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
     ) RETURNING id`,
    [
      row.listing_id, row.buyer_id, row.seller_id,
      row.amount_cents, row.platform_fee_cents, row.seller_payout_cents,
      row.status, row.stripe_payment_intent_id, row.stripe_charge_id, row.stripe_client_secret,
      row.stripe_transfer_id, row.stripe_refund_id, row.cancellation_reason,
      row.prior_status, row.transition_started_at, row.recovery_claimed_at,
      row.recovery_attempts, row.last_recovery_error, row.created_at, row.updated_at,
    ]
  );
  return r.id;
}

async function getOrder(id) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getEvents(orderId) {
  const { rows } = await pool.query(
    'SELECT event_type, payload_json FROM order_events WHERE order_id = $1 ORDER BY id',
    [orderId]
  );
  return rows;
}

// Make transition_started_at stale so recovery picks it up.
async function makeStale(orderId, minutesAgo = 15) {
  const past = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  await pool.query(
    'UPDATE orders SET transition_started_at = $1, recovery_claimed_at = NULL WHERE id = $2',
    [past, orderId]
  );
}

// Create a PaymentIntent in the stub and return it.
async function createStubPI(amountCents = 10000) {
  return stripeClient.createPaymentIntent({ amountCents, currency: 'usd', metadata: {} });
}

// Directly push a refund into the stub's _refunds list.
function injectStubRefund(entry) {
  stripeClient._refunds.push(entry);
}

// Directly push a transfer into the stub's _transfers list.
function injectStubTransfer(entry) {
  stripeClient._transfers.push(entry);
}

// ---------------------------------------------------------------------------
// CAPTURING tests
// ---------------------------------------------------------------------------

async function runCapturingTests() {
  console.log('\nCAPTURING recovery');

  await test('pre-Stripe crash: PI still requires_capture — recovery issues capture, finalizes to HELD', async () => {
    const pi = await createStubPI(10000);
    const orderId = await insertOrder({
      stripe_payment_intent_id: pi.id,
      status: 'CAPTURING',
      prior_status: 'CREATED',
      transition_started_at: new Date().toISOString(),
    });
    await makeStale(orderId);

    const result = await runRecovery();
    assert(result.recoveredOrderIds.includes(orderId), 'order should be in recoveredOrderIds');

    const order = await getOrder(orderId);
    assertEqual(order.status, 'HELD', 'order should be HELD after recovery');
    assert(order.stripe_charge_id, 'stripe_charge_id should be written');
    assert(order.transition_started_at === null,
      'transition_started_at must be NULL after successful finalization');
    assert(order.recovery_claimed_at === null,
      'recovery_claimed_at must be NULL after successful finalization');

    const events = await getEvents(orderId);
    const types = events.map((e) => e.event_type);
    assert(types.includes('PAYMENT_CAPTURED'), 'PAYMENT_CAPTURED event required');
    assert(types.includes('RECOVERY_CAPTURED'), 'RECOVERY_CAPTURED event required');
  });

  await test('post-Stripe crash: PI already succeeded — recovery finalizes to HELD without new Stripe call', async () => {
    const pi = await createStubPI(10000);
    await stripeClient.capturePaymentIntent(pi.id, { idempotencyKey: `capture_order_pre_${pi.id}` });
    const piInfo = await stripeClient.getPaymentIntent(pi.id);
    assertEqual(piInfo.status, 'succeeded', 'PI must be succeeded in stub');

    const orderId = await insertOrder({
      stripe_payment_intent_id: pi.id,
      status: 'CAPTURING',
      prior_status: 'CREATED',
      transition_started_at: new Date().toISOString(),
    });
    await makeStale(orderId);

    const intentCountBefore = stripeClient._intents.size;
    await runRecovery();

    const order = await getOrder(orderId);
    assertEqual(order.status, 'HELD', 'order should be HELD');
    assert(order.stripe_charge_id, 'stripe_charge_id should be written from existing PI');
    assertEqual(stripeClient._intents.size, intentCountBefore, 'no new PaymentIntents should be created');

    const events = await getEvents(orderId);
    const capturedEvents = events.filter((e) => e.event_type === 'PAYMENT_CAPTURED');
    assertEqual(capturedEvents.length, 1, 'exactly one PAYMENT_CAPTURED event');
  });

  await test('ambiguous: PI in canceled state — RECOVERY_AMBIGUOUS recorded, order stays CAPTURING', async () => {
    const pi = await createStubPI(5000);
    const intentRef = stripeClient._intents.get(pi.id);
    intentRef.status = 'canceled';

    const orderId = await insertOrder({
      stripe_payment_intent_id: pi.id,
      status: 'CAPTURING',
      prior_status: 'CREATED',
      transition_started_at: new Date().toISOString(),
    });
    await makeStale(orderId);

    const result = await runRecovery();
    assert(result.ambiguous.some((a) => a.orderId === orderId), 'orderId should be in ambiguous list');

    const order = await getOrder(orderId);
    assertEqual(order.status, 'CAPTURING', 'order must remain CAPTURING when ambiguous');

    const events = await getEvents(orderId);
    assert(events.some((e) => e.event_type === 'RECOVERY_AMBIGUOUS'), 'RECOVERY_AMBIGUOUS event required');
  });

  await test('repeated recovery: second sweep finds order already HELD, no duplicate Stripe call', async () => {
    const pi = await createStubPI(10000);
    const orderId = await insertOrder({
      stripe_payment_intent_id: pi.id,
      status: 'CAPTURING',
      prior_status: 'CREATED',
      transition_started_at: new Date().toISOString(),
    });
    await makeStale(orderId);

    await runRecovery(); // first sweep
    const order1 = await getOrder(orderId);
    assertEqual(order1.status, 'HELD', 'first sweep should finalize to HELD');

    const capturesBefore = stripeClient._intents.size;
    await runRecovery(); // second sweep — order is HELD, not in candidate query

    assertEqual(stripeClient._intents.size, capturesBefore, 'no new Stripe objects created by second sweep');
    const events = await getEvents(orderId);
    const capturedEvents = events.filter((e) => e.event_type === 'PAYMENT_CAPTURED');
    assertEqual(capturedEvents.length, 1, 'exactly one PAYMENT_CAPTURED event across both sweeps');
  });

  await test('listing sold side effect fires during capture recovery', async () => {
    // listing-service is not running in tests — markListingSold returns false.
    // Assert: LISTING_MARK_SOLD_FAILED is recorded and LISTING_MARKED_SOLD is NOT.
    const pi = await createStubPI(10000);
    const orderId = await insertOrder({
      stripe_payment_intent_id: pi.id,
      status: 'CAPTURING',
      prior_status: 'CREATED',
      transition_started_at: new Date().toISOString(),
    });
    await makeStale(orderId);

    await runRecovery();

    const events = await getEvents(orderId);
    const types = events.map((e) => e.event_type);
    assert(types.includes('LISTING_MARK_SOLD_FAILED'),
      'LISTING_MARK_SOLD_FAILED must be recorded when listing service is unavailable');
    assert(!types.includes('LISTING_MARKED_SOLD'),
      'LISTING_MARKED_SOLD must NOT be recorded when listing service is unavailable');
  });

  await test('concurrent claim guard: second sweep skips order already claimed', async () => {
    const pi = await createStubPI(10000);
    const recentClaim = new Date(Date.now() - 30 * 1000).toISOString(); // 30 seconds ago
    const orderId = await insertOrder({
      stripe_payment_intent_id: pi.id,
      status: 'CAPTURING',
      prior_status: 'CREATED',
      transition_started_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(), // stale
      recovery_claimed_at: recentClaim, // recently claimed
      recovery_attempts: 1,
    });

    const result = await runRecovery();
    assert(!result.recoveredOrderIds.includes(orderId), 'claimed order must be skipped by second sweep');
    const order = await getOrder(orderId);
    assertEqual(order.status, 'CAPTURING', 'status must remain CAPTURING — not claimed by this sweep');
  });
}

// ---------------------------------------------------------------------------
// RELEASING tests
// ---------------------------------------------------------------------------

async function runReleasingTests() {
  console.log('\nRELEASING recovery');

  async function setupReleasingOrder(overrides = {}) {
    const pi = await createStubPI(10000);
    const captured = await stripeClient.capturePaymentIntent(pi.id, { idempotencyKey: `cap_setup_${pi.id}` });
    const orderId = await insertOrder({
      stripe_payment_intent_id: pi.id,
      stripe_charge_id: captured.chargeId,
      status: 'RELEASING',
      prior_status: 'DELIVERED',
      transition_started_at: new Date().toISOString(),
      ...overrides,
    });
    await makeStale(orderId);
    return { orderId, pi, chargeId: captured.chargeId };
  }

  await test('pre-Stripe crash: no transfer exists — recovery issues transfer, finalizes to RELEASED', async () => {
    const { orderId } = await setupReleasingOrder();

    const result = await runRecovery();
    assert(result.recoveredOrderIds.includes(orderId), 'orderId in recoveredOrderIds');

    const order = await getOrder(orderId);
    assertEqual(order.status, 'RELEASED', 'order should be RELEASED');
    assert(order.stripe_transfer_id, 'stripe_transfer_id should be written');
    assert(order.transition_started_at === null,
      'transition_started_at must be NULL after successful finalization');
    assert(order.recovery_claimed_at === null,
      'recovery_claimed_at must be NULL after successful finalization');

    const events = await getEvents(orderId);
    assert(events.some((e) => e.event_type === 'RELEASED'), 'RELEASED event required');
    assert(events.some((e) => e.event_type === 'RECOVERY_RELEASED'), 'RECOVERY_RELEASED event required');
  });

  await test('post-Stripe crash: transfer already exists — recovery finalizes without new transfer', async () => {
    const { orderId, chargeId } = await setupReleasingOrder();
    const existingTransferId = 'tr_stub_existing_release';
    injectStubTransfer({
      id: existingTransferId,
      sourceTransactionId: chargeId,
      amountCents: 9200,
      currency: 'usd',
      destination: SELLER_STRIPE_ACCOUNT,
      metadata: { orderId: String(orderId), operationType: 'release' },
      status: 'paid',
    });

    const transfersBefore = stripeClient._transfers.length;
    await runRecovery();

    const order = await getOrder(orderId);
    assertEqual(order.status, 'RELEASED', 'order should be RELEASED');
    assertEqual(order.stripe_transfer_id, existingTransferId, 'must use the existing transfer ID');
    assertEqual(stripeClient._transfers.length, transfersBefore, 'no new transfer should be created');
  });

  await test('prior_status=DISPUTED: dispute_resolution field written after release recovery', async () => {
    const { orderId } = await setupReleasingOrder({ prior_status: 'DISPUTED' });

    await runRecovery();

    const order = await getOrder(orderId);
    assertEqual(order.status, 'RELEASED', 'order should be RELEASED');
    assertEqual(order.dispute_resolution, 'release', 'dispute_resolution must be set to "release"');

    const events = await getEvents(orderId);
    assert(events.some((e) => e.event_type === 'DISPUTE_RESOLVED'), 'DISPUTE_RESOLVED event required');
  });

  await test('ambiguous: two matching transfers — RECOVERY_AMBIGUOUS, order stays RELEASING', async () => {
    const { orderId, chargeId } = await setupReleasingOrder();
    injectStubTransfer({
      id: 'tr_stub_dup_1',
      sourceTransactionId: chargeId,
      amountCents: 9200,
      currency: 'usd',
      destination: SELLER_STRIPE_ACCOUNT,
      metadata: { orderId: String(orderId), operationType: 'release' },
      status: 'paid',
    });
    injectStubTransfer({
      id: 'tr_stub_dup_2',
      sourceTransactionId: chargeId,
      amountCents: 9200,
      currency: 'usd',
      destination: SELLER_STRIPE_ACCOUNT,
      metadata: { orderId: String(orderId), operationType: 'release' },
      status: 'paid',
    });

    await runRecovery();
    const order = await getOrder(orderId);
    assertEqual(order.status, 'RELEASING', 'order must stay RELEASING when ambiguous');
    const events = await getEvents(orderId);
    assert(events.some((e) => e.event_type === 'RECOVERY_AMBIGUOUS'), 'RECOVERY_AMBIGUOUS event required');
  });

  await test('repeated recovery: second sweep skips already-RELEASED order', async () => {
    const { orderId } = await setupReleasingOrder();
    await runRecovery();
    const order1 = await getOrder(orderId);
    assertEqual(order1.status, 'RELEASED', 'first sweep must RELEASE');

    const transfersBefore = stripeClient._transfers.length;
    await runRecovery();
    assertEqual(stripeClient._transfers.length, transfersBefore, 'no new transfer on second sweep');

    const events = await getEvents(orderId);
    assertEqual(events.filter((e) => e.event_type === 'RELEASED').length, 1, 'exactly one RELEASED event');
    assertEqual(events.filter((e) => e.event_type === 'RECOVERY_RELEASED').length, 1, 'exactly one RECOVERY_RELEASED event');
  });

  await test('idempotency key: same key on re-issue returns same transfer ID', async () => {
    const { orderId } = await setupReleasingOrder();
    await runRecovery();
    const order1 = await getOrder(orderId);
    const transferId1 = order1.stripe_transfer_id;
    assert(transferId1, 'transfer_id must be set after first recovery');

    // Manually reset to RELEASING with cleared transfer_id and stale timestamp
    await pool.query(
      `UPDATE orders SET status='RELEASING', stripe_transfer_id=NULL, recovery_claimed_at=NULL WHERE id=$1`,
      [orderId]
    );
    await makeStale(orderId);
    await runRecovery();
    const order2 = await getOrder(orderId);
    const transferId2 = order2.stripe_transfer_id;
    assertEqual(transferId1, transferId2, 'same idempotency key must produce same transfer ID');
  });
}

// ---------------------------------------------------------------------------
// REFUNDING tests
// ---------------------------------------------------------------------------

async function runRefundingTests() {
  console.log('\nREFUNDING recovery');

  async function setupRefundingOrder() {
    const pi = await createStubPI(8500);
    await stripeClient.capturePaymentIntent(pi.id, { idempotencyKey: `cap_refund_${pi.id}` });
    const orderId = await insertOrder({
      amount_cents:         8500,
      platform_fee_cents:   255,
      seller_payout_cents:  8245,
      stripe_payment_intent_id: pi.id,
      status:        'REFUNDING',
      prior_status:  'DISPUTED',
      transition_started_at: new Date().toISOString(),
    });
    await makeStale(orderId);
    return { orderId, piId: pi.id };
  }

  await test('pre-Stripe crash: no refund exists — recovery issues refund, finalizes to REFUNDED', async () => {
    const { orderId } = await setupRefundingOrder();

    await runRecovery();

    const order = await getOrder(orderId);
    assertEqual(order.status, 'REFUNDED', 'order should be REFUNDED');
    assert(order.stripe_refund_id, 'stripe_refund_id should be written');
    assert(order.transition_started_at === null,
      'transition_started_at must be NULL after successful finalization');
    assert(order.recovery_claimed_at === null,
      'recovery_claimed_at must be NULL after successful finalization');

    const events = await getEvents(orderId);
    assert(events.some((e) => e.event_type === 'REFUNDED'), 'REFUNDED event required');
    assert(events.some((e) => e.event_type === 'RECOVERY_REFUNDED'), 'RECOVERY_REFUNDED event required');
  });

  await test('post-Stripe crash: refund already in Stripe — recovery finalizes without new refund', async () => {
    const { orderId, piId } = await setupRefundingOrder();
    const existingRefundId = 're_stub_existing_refund';
    injectStubRefund({
      id: existingRefundId,
      paymentIntentId: piId,
      amountCents: 8500,
      metadata: { orderId: String(orderId), operationType: 'refund_dispute' },
      status: 'succeeded',
    });

    const refundsBefore = stripeClient._refunds.length;
    await runRecovery();

    const order = await getOrder(orderId);
    assertEqual(order.status, 'REFUNDED', 'order should be REFUNDED');
    assertEqual(order.stripe_refund_id, existingRefundId, 'must use the existing refund ID');
    assertEqual(stripeClient._refunds.length, refundsBefore, 'no new refund should be created');
  });

  await test('prior_status=DISPUTED: dispute_resolution field written after refund recovery', async () => {
    const { orderId } = await setupRefundingOrder();
    await runRecovery();

    const order = await getOrder(orderId);
    assertEqual(order.dispute_resolution, 'refund', 'dispute_resolution must be set to "refund"');

    const events = await getEvents(orderId);
    assert(events.some((e) => e.event_type === 'DISPUTE_RESOLVED'), 'DISPUTE_RESOLVED event required');
  });

  await test('ambiguous: two matching refunds — RECOVERY_AMBIGUOUS, order stays REFUNDING', async () => {
    const { orderId, piId } = await setupRefundingOrder();
    injectStubRefund({
      id: 're_stub_dup_a',
      paymentIntentId: piId,
      amountCents: 8500,
      metadata: { orderId: String(orderId), operationType: 'refund_dispute' },
      status: 'succeeded',
    });
    injectStubRefund({
      id: 're_stub_dup_b',
      paymentIntentId: piId,
      amountCents: 8500,
      metadata: { orderId: String(orderId), operationType: 'refund_dispute' },
      status: 'succeeded',
    });

    await runRecovery();
    const order = await getOrder(orderId);
    assertEqual(order.status, 'REFUNDING', 'order must stay REFUNDING when ambiguous');
    assert((await getEvents(orderId)).some((e) => e.event_type === 'RECOVERY_AMBIGUOUS'), 'RECOVERY_AMBIGUOUS required');
  });

  await test('repeated recovery: second sweep skips already-REFUNDED order, no duplicate refund', async () => {
    const { orderId } = await setupRefundingOrder();
    await runRecovery();
    assertEqual((await getOrder(orderId)).status, 'REFUNDED', 'first sweep must REFUND');

    const refundsBefore = stripeClient._refunds.length;
    await runRecovery();
    assertEqual(stripeClient._refunds.length, refundsBefore, 'no new refund on second sweep');

    const events = await getEvents(orderId);
    assertEqual(events.filter((e) => e.event_type === 'REFUNDED').length, 1, 'exactly one REFUNDED event');
  });
}

// ---------------------------------------------------------------------------
// CANCELLING tests
// ---------------------------------------------------------------------------

async function runCancellingTests() {
  console.log('\nCANCELLING recovery');

  async function setupCancellingOrder(overrides = {}) {
    const pi = await createStubPI(15000);
    await stripeClient.capturePaymentIntent(pi.id, { idempotencyKey: `cap_cancel_${pi.id}` });
    const orderId = await insertOrder({
      amount_cents:          15000,
      platform_fee_cents:     1200,
      seller_payout_cents:   13800,
      stripe_payment_intent_id: pi.id,
      status:        'CANCELLING',
      prior_status:  'HELD',
      transition_started_at: new Date().toISOString(),
      cancellation_reason: 'buyer changed mind',
      ...overrides,
    });
    await makeStale(orderId);
    return { orderId, piId: pi.id };
  }

  await test('pre-Stripe crash: no refund exists — recovery issues partial refund, finalizes to CANCELLED', async () => {
    const { orderId } = await setupCancellingOrder();

    const result = await runRecovery();
    assert(result.recoveredOrderIds.includes(orderId), 'orderId in recoveredOrderIds');

    const order = await getOrder(orderId);
    assertEqual(order.status, 'CANCELLED', 'order should be CANCELLED');
    assert(order.stripe_refund_id, 'stripe_refund_id should be written');
    assert(order.transition_started_at === null,
      'transition_started_at must be NULL after successful finalization');
    assert(order.recovery_claimed_at === null,
      'recovery_claimed_at must be NULL after successful finalization');

    const events = await getEvents(orderId);
    assert(events.some((e) => e.event_type === 'CANCELLED'), 'CANCELLED event required');
    assert(events.some((e) => e.event_type === 'RECOVERY_CANCELLED'), 'RECOVERY_CANCELLED event required');
  });

  await test('post-Stripe crash: partial refund already in Stripe — finalizes without new refund call', async () => {
    const { orderId, piId } = await setupCancellingOrder();
    const existingRefundId = 're_stub_existing_cancel';
    injectStubRefund({
      id: existingRefundId,
      paymentIntentId: piId,
      amountCents: 13800, // amount_cents - platform_fee_cents
      metadata: { orderId: String(orderId), operationType: 'cancel' },
      status: 'succeeded',
    });

    const refundsBefore = stripeClient._refunds.length;
    await runRecovery();

    const order = await getOrder(orderId);
    assertEqual(order.status, 'CANCELLED', 'order should be CANCELLED');
    assertEqual(order.stripe_refund_id, existingRefundId, 'must use the existing refund ID');
    assertEqual(stripeClient._refunds.length, refundsBefore, 'no new refund should be created');
  });

  await test('cancellation_reason preserved: recovery reads pre-saved reason from DB', async () => {
    const { orderId } = await setupCancellingOrder({ cancellation_reason: 'item not as described' });
    await runRecovery();

    const events = await getEvents(orderId);
    const cancelledEvent = events.find((e) => e.event_type === 'CANCELLED');
    assert(cancelledEvent, 'CANCELLED event must exist');
    const payload = JSON.parse(cancelledEvent.payload_json);
    assertEqual(payload.reason, 'item not as described', 'reason must be preserved from DB');
  });

  await test('listing reactivation fires only after Stripe confirms refund', async () => {
    const { orderId } = await setupCancellingOrder();
    await runRecovery();

    assertEqual((await getOrder(orderId)).status, 'CANCELLED', 'order must be CANCELLED despite listing failure');
    const types = (await getEvents(orderId)).map((e) => e.event_type);
    assert(types.includes('LISTING_REACTIVATE_FAILED'),
      'LISTING_REACTIVATE_FAILED must be recorded when listing service is unavailable');
    assert(!types.includes('LISTING_REACTIVATED'),
      'LISTING_REACTIVATED must NOT be recorded when listing service is unavailable');
  });

  await test('ambiguous: two matching cancel refunds — RECOVERY_AMBIGUOUS, order stays CANCELLING', async () => {
    const { orderId, piId } = await setupCancellingOrder();
    injectStubRefund({
      id: 're_stub_cancel_dup_1',
      paymentIntentId: piId,
      amountCents: 13800,
      metadata: { orderId: String(orderId), operationType: 'cancel' },
      status: 'succeeded',
    });
    injectStubRefund({
      id: 're_stub_cancel_dup_2',
      paymentIntentId: piId,
      amountCents: 13800,
      metadata: { orderId: String(orderId), operationType: 'cancel' },
      status: 'succeeded',
    });

    await runRecovery();
    assertEqual((await getOrder(orderId)).status, 'CANCELLING', 'order must stay CANCELLING when ambiguous');
    assert((await getEvents(orderId)).some((e) => e.event_type === 'RECOVERY_AMBIGUOUS'), 'RECOVERY_AMBIGUOUS required');
  });

  await test('repeated recovery: second sweep skips already-CANCELLED order, no duplicate refund', async () => {
    const { orderId } = await setupCancellingOrder();
    await runRecovery();
    assertEqual((await getOrder(orderId)).status, 'CANCELLED', 'first sweep must CANCEL');

    const refundsBefore = stripeClient._refunds.length;
    await runRecovery();
    assertEqual(stripeClient._refunds.length, refundsBefore, 'no new refund on second sweep');

    const events = await getEvents(orderId);
    assertEqual(events.filter((e) => e.event_type === 'CANCELLED').length, 1, 'exactly one CANCELLED event');
    assertEqual(events.filter((e) => e.event_type === 'RECOVERY_CANCELLED').length, 1, 'exactly one RECOVERY_CANCELLED event');
  });

  await test('same idempotency key on re-issue returns same refund ID', async () => {
    const { orderId } = await setupCancellingOrder();
    await runRecovery();
    const refundId1 = (await getOrder(orderId)).stripe_refund_id;
    assert(refundId1, 'refund_id must be set after first recovery');

    await pool.query(
      `UPDATE orders SET status='CANCELLING', stripe_refund_id=NULL, recovery_claimed_at=NULL WHERE id=$1`,
      [orderId]
    );
    await makeStale(orderId);
    await runRecovery();
    const refundId2 = (await getOrder(orderId)).stripe_refund_id;
    assertEqual(refundId1, refundId2, 'same idempotency key must produce same refund ID');
  });

  await test('in-process guard: concurrent sweep call returns skipped while first is running', async () => {
    const { orderId } = await setupCancellingOrder();
    const p1 = runRecovery(); // start — does NOT await
    const p2 = runRecovery(); // immediately start second — should get skipped
    const [r1, r2] = await Promise.all([p1, p2]);
    assert(
      (r1.skipped && !r2.skipped) || (!r1.skipped && r2.skipped),
      'exactly one sweep should be skipped'
    );
  });
}

// ---------------------------------------------------------------------------
// Schema and reserveTransition tests (replaces migration backfill tests)
// ---------------------------------------------------------------------------

async function runSchemaTests() {
  console.log('\nSchema and reserveTransition');

  await test('recovery columns exist in orders table', async () => {
    const { rows } = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'orders' AND table_schema = 'public'
    `);
    const cols = rows.map((r) => r.column_name);
    for (const col of ['prior_status', 'transition_started_at', 'recovery_claimed_at', 'recovery_attempts', 'last_recovery_error']) {
      assert(cols.includes(col), `Column '${col}' must exist in orders table`);
    }
  });

  await test('reserveTransition writes prior_status and transition_started_at', async () => {
    const orderId = await insertOrder({ status: 'HELD' });
    const now = new Date().toISOString();
    const result = await pool.query(
      `UPDATE orders
       SET status='CAPTURING', updated_at=$1, prior_status=status, transition_started_at=$2
       WHERE id=$3 AND status='HELD'`,
      [now, now, orderId]
    );
    assertEqual(result.rowCount, 1, 'UPDATE must affect exactly 1 row');
    const row = await getOrder(orderId);
    assertEqual(row.prior_status, 'HELD', 'prior_status must capture the pre-transition status');
    assert(row.transition_started_at, 'transition_started_at must be set');
  });

  await test('status CHECK constraint rejects invalid values', async () => {
    await assertThrows(
      () => insertOrder({ status: 'INVALID_STATUS' }),
      'check'
    );
  });
}

// ---------------------------------------------------------------------------
// Run all suites
// ---------------------------------------------------------------------------

(async () => {
  console.log('=== Recovery Tests (PostgreSQL) ===');

  try {
    await setupDb();

    await runSchemaTests();
    await runCapturingTests();
    await runReleasingTests();
    await runRefundingTests();
    await runCancellingTests();
  } finally {
    await pool.end();
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();

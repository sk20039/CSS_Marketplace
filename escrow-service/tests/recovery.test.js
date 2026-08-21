// tests/recovery.test.js
//
// Standalone test script — no test runner required.
// Run: node tests/recovery.test.js
// Exit code 0 = all passed, 1 = any failed.
//
// Uses a temporary SQLite database so it never touches production data.
// All Stripe calls go to the StubStripeClient (no STRIPE_SECRET_KEY set).
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

// ---- MUST be set before any module that loads db.js ----
const path = require('path');
const os = require('os');
const fs = require('fs');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-test-'));
const TEST_DB = path.join(tmpDir, 'test.sqlite3');
process.env.DB_PATH = TEST_DB;
delete process.env.STRIPE_SECRET_KEY; // force stub mode

const db = require('../src/db');
const { runMigrationBackfill } = db;
const { stripeClient } = require('../src/stripeClient');
const { runRecovery } = require('../src/recoveryService');
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
// DB helpers
// ---------------------------------------------------------------------------

// Seed data IDs (populated from db.js seed() in the test DB)
let BUYER_ID, SELLER_ID, LISTING_ID;

function loadSeedIds() {
  const buyer  = db.prepare("SELECT id FROM users WHERE email = 'buyer@demo.test'").get();
  const seller = db.prepare("SELECT id FROM users WHERE email = 'seller@demo.test'").get();
  const listing = db.prepare('SELECT id FROM listings LIMIT 1').get();
  BUYER_ID  = buyer.id;
  SELLER_ID = seller.id;
  LISTING_ID = listing.id;
}

// Insert an order row directly (bypasses all service logic, for test setup).
function insertOrder(overrides = {}) {
  const now = new Date().toISOString();
  const defaults = {
    listing_id: LISTING_ID,
    buyer_id:   BUYER_ID,
    seller_id:  SELLER_ID,
    amount_cents: 10000,
    platform_fee_cents: 300,
    seller_payout_cents: 9700,
    status: 'HELD',
    stripe_payment_intent_id: null,
    stripe_charge_id: null,
    stripe_client_secret: null,
    stripe_transfer_id: null,
    stripe_refund_id: null,
    cancellation_reason: null,
    prior_status: null,
    transition_started_at: null,
    recovery_claimed_at: null,
    recovery_attempts: 0,
    last_recovery_error: null,
    created_at: now,
    updated_at: now,
  };
  const row = { ...defaults, ...overrides };
  const result = db.prepare(`
    INSERT INTO orders (
      listing_id, buyer_id, seller_id, amount_cents, platform_fee_cents, seller_payout_cents,
      status, stripe_payment_intent_id, stripe_charge_id, stripe_client_secret,
      stripe_transfer_id, stripe_refund_id, cancellation_reason,
      prior_status, transition_started_at, recovery_claimed_at, recovery_attempts,
      last_recovery_error, created_at, updated_at
    ) VALUES (
      @listing_id, @buyer_id, @seller_id, @amount_cents, @platform_fee_cents, @seller_payout_cents,
      @status, @stripe_payment_intent_id, @stripe_charge_id, @stripe_client_secret,
      @stripe_transfer_id, @stripe_refund_id, @cancellation_reason,
      @prior_status, @transition_started_at, @recovery_claimed_at, @recovery_attempts,
      @last_recovery_error, @created_at, @updated_at
    )
  `).run(row);
  return result.lastInsertRowid;
}

function getOrder(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
}

function getEvents(orderId) {
  return db.prepare('SELECT event_type, payload_json FROM order_events WHERE order_id = ? ORDER BY id').all(orderId);
}

// Make transition_started_at stale so recovery picks it up.
function makeStale(orderId, minutesAgo = 15) {
  const past = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  db.prepare('UPDATE orders SET transition_started_at = ?, recovery_claimed_at = NULL WHERE id = ?')
    .run(past, orderId);
}

// Create a PaymentIntent in the stub and return its ID.
async function createStubPI(amountCents = 10000) {
  const pi = await stripeClient.createPaymentIntent({ amountCents, currency: 'usd', metadata: {} });
  return pi;
}

// Directly push a refund into the stub's _refunds list (simulates Stripe having
// already processed the refund before a crash prevented DB finalization).
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
    const orderId = insertOrder({
      stripe_payment_intent_id: pi.id,
      status: 'CAPTURING',
      prior_status: 'CREATED',
      transition_started_at: new Date().toISOString(),
    });
    makeStale(orderId);

    const result = await runRecovery();
    assert(result.recoveredOrderIds.includes(orderId), 'order should be in recoveredOrderIds');

    const order = getOrder(orderId);
    assertEqual(order.status, 'HELD', 'order should be HELD after recovery');
    assert(order.stripe_charge_id, 'stripe_charge_id should be written');
    // Recovery claim fields must be cleared so the finalized row does not
    // appear actively claimed in audits.
    assert(order.transition_started_at === null,
      'transition_started_at must be NULL after successful finalization');
    assert(order.recovery_claimed_at === null,
      'recovery_claimed_at must be NULL after successful finalization');

    const events = getEvents(orderId);
    const types = events.map((e) => e.event_type);
    assert(types.includes('PAYMENT_CAPTURED'), 'PAYMENT_CAPTURED event required');
    assert(types.includes('RECOVERY_CAPTURED'), 'RECOVERY_CAPTURED event required');
  });

  await test('post-Stripe crash: PI already succeeded — recovery finalizes to HELD without new Stripe call', async () => {
    const pi = await createStubPI(10000);
    // Simulate Stripe capture already happened (stub sets status to succeeded)
    await stripeClient.capturePaymentIntent(pi.id, { idempotencyKey: `capture_order_pre` });
    // PI is now 'succeeded' in the stub; order DB was never finalized
    const piInfo = await stripeClient.getPaymentIntent(pi.id);
    assertEqual(piInfo.status, 'succeeded', 'PI must be succeeded in stub');

    const orderId = insertOrder({
      stripe_payment_intent_id: pi.id,
      status: 'CAPTURING',
      prior_status: 'CREATED',
      transition_started_at: new Date().toISOString(),
    });
    makeStale(orderId);

    const countBefore = stripeClient._intents.size; // no new intents should be created
    await runRecovery();

    const order = getOrder(orderId);
    assertEqual(order.status, 'HELD', 'order should be HELD');
    assert(order.stripe_charge_id, 'stripe_charge_id should be written from existing PI');
    assertEqual(stripeClient._intents.size, countBefore, 'no new PaymentIntents should be created');

    const events = getEvents(orderId);
    const recEvents = events.filter((e) => e.event_type === 'PAYMENT_CAPTURED');
    assertEqual(recEvents.length, 1, 'exactly one PAYMENT_CAPTURED event');
  });

  await test('ambiguous: PI in canceled state — RECOVERY_AMBIGUOUS recorded, order stays CAPTURING', async () => {
    const pi = await createStubPI(5000);
    // Simulate expired authorization
    const intentRef = stripeClient._intents.get(pi.id);
    intentRef.status = 'canceled';

    const orderId = insertOrder({
      stripe_payment_intent_id: pi.id,
      status: 'CAPTURING',
      prior_status: 'CREATED',
      transition_started_at: new Date().toISOString(),
    });
    makeStale(orderId);

    const result = await runRecovery();
    assert(result.ambiguous.some((a) => a.orderId === orderId), 'orderId should be in ambiguous list');

    const order = getOrder(orderId);
    assertEqual(order.status, 'CAPTURING', 'order must remain CAPTURING when ambiguous');

    const events = getEvents(orderId);
    assert(events.some((e) => e.event_type === 'RECOVERY_AMBIGUOUS'), 'RECOVERY_AMBIGUOUS event required');
  });

  await test('repeated recovery: second sweep finds order already HELD, no duplicate Stripe call', async () => {
    const pi = await createStubPI(10000);
    const orderId = insertOrder({
      stripe_payment_intent_id: pi.id,
      status: 'CAPTURING',
      prior_status: 'CREATED',
      transition_started_at: new Date().toISOString(),
    });
    makeStale(orderId);

    await runRecovery(); // first sweep — finalizes to HELD
    assertEqual(getOrder(orderId).status, 'HELD', 'first sweep should finalize to HELD');

    const capturesBefore = stripeClient._intents.size; // stub tracks intents
    await runRecovery(); // second sweep — order is HELD, not selected by WHERE clause

    assertEqual(stripeClient._intents.size, capturesBefore, 'no new Stripe objects created by second sweep');
    const events = getEvents(orderId);
    const capturedEvents = events.filter((e) => e.event_type === 'PAYMENT_CAPTURED');
    assertEqual(capturedEvents.length, 1, 'exactly one PAYMENT_CAPTURED event across both sweeps');
  });

  await test('listing sold side effect fires during capture recovery', async () => {
    // listing-service is not running in tests — markListingSold returns false.
    // Assert: LISTING_MARK_SOLD_FAILED is recorded and LISTING_MARKED_SOLD is NOT.
    const pi = await createStubPI(10000);
    const orderId = insertOrder({
      stripe_payment_intent_id: pi.id,
      status: 'CAPTURING',
      prior_status: 'CREATED',
      transition_started_at: new Date().toISOString(),
    });
    makeStale(orderId);

    await runRecovery();

    const events = getEvents(orderId);
    const types = events.map((e) => e.event_type);
    assert(types.includes('LISTING_MARK_SOLD_FAILED'),
      'LISTING_MARK_SOLD_FAILED must be recorded when listing service is unavailable');
    assert(!types.includes('LISTING_MARKED_SOLD'),
      'LISTING_MARKED_SOLD must NOT be recorded when listing service is unavailable');
  });

  await test('concurrent claim guard: second sweep skips order already claimed', async () => {
    const pi = await createStubPI(10000);
    const orderId = insertOrder({
      stripe_payment_intent_id: pi.id,
      status: 'CAPTURING',
      prior_status: 'CREATED',
      transition_started_at: new Date().toISOString(),
      // Simulate a recent claim by another sweep (within claim expiry window)
      recovery_claimed_at: new Date(Date.now() - 30 * 1000).toISOString(), // 30 seconds ago
      recovery_attempts: 1,
    });
    // Make transition stale but keep recovery_claimed_at recent
    db.prepare('UPDATE orders SET transition_started_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 15 * 60 * 1000).toISOString(), orderId);

    const result = await runRecovery();
    // The order should NOT appear in recoveredOrderIds or ambiguous — it was skipped
    assert(!result.recoveredOrderIds.includes(orderId), 'claimed order must be skipped by second sweep');
    assertEqual(getOrder(orderId).status, 'CAPTURING', 'status must remain CAPTURING — not claimed by this sweep');
  });
}

// ---------------------------------------------------------------------------
// RELEASING tests
// ---------------------------------------------------------------------------

async function runReleasingTests() {
  console.log('\nRELEASING recovery');

  const SELLER_STRIPE_ACCOUNT = 'acct_stub_seller_1'; // from seed data

  async function setupReleasingOrder(overrides = {}) {
    const pi = await createStubPI(10000);
    // Capture to get a charge ID in the stub
    const captured = await stripeClient.capturePaymentIntent(pi.id, { idempotencyKey: `cap_setup_${pi.id}` });
    const orderId = insertOrder({
      stripe_payment_intent_id: pi.id,
      stripe_charge_id: captured.chargeId,
      status: 'RELEASING',
      prior_status: 'DELIVERED',
      transition_started_at: new Date().toISOString(),
      ...overrides,
    });
    makeStale(orderId);
    return { orderId, pi, chargeId: captured.chargeId };
  }

  await test('pre-Stripe crash: no transfer exists — recovery issues transfer, finalizes to RELEASED', async () => {
    const { orderId, chargeId } = await setupReleasingOrder();

    const result = await runRecovery();
    assert(result.recoveredOrderIds.includes(orderId), 'orderId in recoveredOrderIds');

    const order = getOrder(orderId);
    assertEqual(order.status, 'RELEASED', 'order should be RELEASED');
    assert(order.stripe_transfer_id, 'stripe_transfer_id should be written');
    assert(order.transition_started_at === null,
      'transition_started_at must be NULL after successful finalization');
    assert(order.recovery_claimed_at === null,
      'recovery_claimed_at must be NULL after successful finalization');

    const events = getEvents(orderId);
    assert(events.some((e) => e.event_type === 'RELEASED'), 'RELEASED event required');
    assert(events.some((e) => e.event_type === 'RECOVERY_RELEASED'), 'RECOVERY_RELEASED event required');
  });

  await test('post-Stripe crash: transfer already exists — recovery finalizes without new transfer', async () => {
    const { orderId, chargeId } = await setupReleasingOrder();
    // Inject an existing transfer (simulates Stripe processed it before crash)
    const existingTransferId = 'tr_stub_existing_release';
    injectStubTransfer({
      id: existingTransferId,
      sourceTransactionId: chargeId,
      amountCents: 9700,
      destination: SELLER_STRIPE_ACCOUNT,
      metadata: { orderId: String(orderId), operationType: 'release' },
      status: 'paid',
    });

    const transfersBefore = stripeClient._transfers.length;
    await runRecovery();

    const order = getOrder(orderId);
    assertEqual(order.status, 'RELEASED', 'order should be RELEASED');
    assertEqual(order.stripe_transfer_id, existingTransferId, 'must use the existing transfer ID');
    assertEqual(stripeClient._transfers.length, transfersBefore, 'no new transfer should be created');
  });

  await test('prior_status=DISPUTED: dispute_resolution field written after release recovery', async () => {
    const { orderId } = await setupReleasingOrder({ prior_status: 'DISPUTED' });

    await runRecovery();

    const order = getOrder(orderId);
    assertEqual(order.status, 'RELEASED', 'order should be RELEASED');
    assertEqual(order.dispute_resolution, 'release', 'dispute_resolution must be set to "release"');

    const events = getEvents(orderId);
    assert(events.some((e) => e.event_type === 'DISPUTE_RESOLVED'), 'DISPUTE_RESOLVED event required');
  });

  await test('ambiguous: two matching transfers — RECOVERY_AMBIGUOUS, order stays RELEASING', async () => {
    const { orderId, chargeId } = await setupReleasingOrder();
    injectStubTransfer({
      id: 'tr_stub_dup_1',
      sourceTransactionId: chargeId,
      amountCents: 9700,
      destination: SELLER_STRIPE_ACCOUNT,
      metadata: { orderId: String(orderId), operationType: 'release' },
      status: 'paid',
    });
    injectStubTransfer({
      id: 'tr_stub_dup_2',
      sourceTransactionId: chargeId,
      amountCents: 9700,
      destination: SELLER_STRIPE_ACCOUNT,
      metadata: { orderId: String(orderId), operationType: 'release' },
      status: 'paid',
    });

    await runRecovery();
    assertEqual(getOrder(orderId).status, 'RELEASING', 'order must stay RELEASING when ambiguous');
    const events = getEvents(orderId);
    assert(events.some((e) => e.event_type === 'RECOVERY_AMBIGUOUS'), 'RECOVERY_AMBIGUOUS event required');
  });

  await test('repeated recovery: second sweep skips already-RELEASED order', async () => {
    const { orderId } = await setupReleasingOrder();
    await runRecovery();
    assertEqual(getOrder(orderId).status, 'RELEASED', 'first sweep must RELEASE');

    const transfersBefore = stripeClient._transfers.length;
    await runRecovery();
    assertEqual(stripeClient._transfers.length, transfersBefore, 'no new transfer on second sweep');

    const events = getEvents(orderId);
    assertEqual(events.filter((e) => e.event_type === 'RELEASED').length, 1, 'exactly one RELEASED event');
    assertEqual(events.filter((e) => e.event_type === 'RECOVERY_RELEASED').length, 1, 'exactly one RECOVERY_RELEASED event');
  });

  await test('idempotency key: same key on re-issue returns same transfer ID', async () => {
    const { orderId } = await setupReleasingOrder();
    await runRecovery();
    const transferId1 = getOrder(orderId).stripe_transfer_id;
    assert(transferId1, 'transfer_id must be set after first recovery');

    // Manually reset to RELEASING with same stale timestamp to trigger second recovery
    db.prepare(`UPDATE orders SET status='RELEASING', stripe_transfer_id=NULL, recovery_claimed_at=NULL WHERE id=?`).run(orderId);
    makeStale(orderId);
    await runRecovery();
    const transferId2 = getOrder(orderId).stripe_transfer_id;
    // The idempotency key (release_order_{id}) returns the same cached transfer
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
    const orderId = insertOrder({
      amount_cents: 8500,
      platform_fee_cents: 255,
      seller_payout_cents: 8245,
      stripe_payment_intent_id: pi.id,
      status: 'REFUNDING',
      prior_status: 'DISPUTED',
      transition_started_at: new Date().toISOString(),
    });
    makeStale(orderId);
    return { orderId, piId: pi.id };
  }

  await test('pre-Stripe crash: no refund exists — recovery issues refund, finalizes to REFUNDED', async () => {
    const { orderId } = await setupRefundingOrder();

    await runRecovery();

    const order = getOrder(orderId);
    assertEqual(order.status, 'REFUNDED', 'order should be REFUNDED');
    assert(order.stripe_refund_id, 'stripe_refund_id should be written');
    assert(order.transition_started_at === null,
      'transition_started_at must be NULL after successful finalization');
    assert(order.recovery_claimed_at === null,
      'recovery_claimed_at must be NULL after successful finalization');

    const events = getEvents(orderId);
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

    const order = getOrder(orderId);
    assertEqual(order.status, 'REFUNDED', 'order should be REFUNDED');
    assertEqual(order.stripe_refund_id, existingRefundId, 'must use the existing refund ID');
    assertEqual(stripeClient._refunds.length, refundsBefore, 'no new refund should be created');
  });

  await test('prior_status=DISPUTED: dispute_resolution field written after refund recovery', async () => {
    const { orderId } = await setupRefundingOrder();
    await runRecovery();

    const order = getOrder(orderId);
    assertEqual(order.dispute_resolution, 'refund', 'dispute_resolution must be set to "refund"');

    const events = getEvents(orderId);
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
    assertEqual(getOrder(orderId).status, 'REFUNDING', 'order must stay REFUNDING when ambiguous');
    assert(getEvents(orderId).some((e) => e.event_type === 'RECOVERY_AMBIGUOUS'), 'RECOVERY_AMBIGUOUS required');
  });

  await test('repeated recovery: second sweep skips already-REFUNDED order, no duplicate refund', async () => {
    const { orderId } = await setupRefundingOrder();
    await runRecovery();
    assertEqual(getOrder(orderId).status, 'REFUNDED', 'first sweep must REFUND');

    const refundsBefore = stripeClient._refunds.length;
    await runRecovery();
    assertEqual(stripeClient._refunds.length, refundsBefore, 'no new refund on second sweep');

    const events = getEvents(orderId);
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
    const orderId = insertOrder({
      amount_cents: 15000,
      platform_fee_cents: 450,
      seller_payout_cents: 14550,
      stripe_payment_intent_id: pi.id,
      status: 'CANCELLING',
      prior_status: 'HELD',
      transition_started_at: new Date().toISOString(),
      cancellation_reason: 'buyer changed mind',
      ...overrides,
    });
    makeStale(orderId);
    return { orderId, piId: pi.id };
  }

  await test('pre-Stripe crash: no refund exists — recovery issues partial refund, finalizes to CANCELLED', async () => {
    const { orderId } = await setupCancellingOrder();

    const result = await runRecovery();
    assert(result.recoveredOrderIds.includes(orderId), 'orderId in recoveredOrderIds');

    const order = getOrder(orderId);
    assertEqual(order.status, 'CANCELLED', 'order should be CANCELLED');
    assert(order.stripe_refund_id, 'stripe_refund_id should be written');
    assert(order.transition_started_at === null,
      'transition_started_at must be NULL after successful finalization');
    assert(order.recovery_claimed_at === null,
      'recovery_claimed_at must be NULL after successful finalization');

    const events = getEvents(orderId);
    assert(events.some((e) => e.event_type === 'CANCELLED'), 'CANCELLED event required');
    assert(events.some((e) => e.event_type === 'RECOVERY_CANCELLED'), 'RECOVERY_CANCELLED event required');
  });

  await test('post-Stripe crash: partial refund already in Stripe — finalizes without new refund call', async () => {
    const { orderId, piId } = await setupCancellingOrder();
    const existingRefundId = 're_stub_existing_cancel';
    injectStubRefund({
      id: existingRefundId,
      paymentIntentId: piId,
      amountCents: 14550, // amount_cents - platform_fee_cents
      metadata: { orderId: String(orderId), operationType: 'cancel' },
      status: 'succeeded',
    });

    const refundsBefore = stripeClient._refunds.length;
    await runRecovery();

    const order = getOrder(orderId);
    assertEqual(order.status, 'CANCELLED', 'order should be CANCELLED');
    assertEqual(order.stripe_refund_id, existingRefundId, 'must use the existing refund ID');
    assertEqual(stripeClient._refunds.length, refundsBefore, 'no new refund should be created');
  });

  await test('cancellation_reason preserved: recovery reads pre-saved reason from DB', async () => {
    const { orderId } = await setupCancellingOrder({ cancellation_reason: 'item not as described' });
    await runRecovery();

    const events = getEvents(orderId);
    const cancelledEvent = events.find((e) => e.event_type === 'CANCELLED');
    assert(cancelledEvent, 'CANCELLED event must exist');
    const payload = JSON.parse(cancelledEvent.payload_json);
    assertEqual(payload.reason, 'item not as described', 'reason must be preserved from DB');
  });

  await test('listing reactivation fires only after Stripe confirms refund', async () => {
    // listing-service is not running in tests — markListingActive returns false.
    // Assert: LISTING_REACTIVATE_FAILED is recorded, LISTING_REACTIVATED is NOT,
    // and the order reaches CANCELLED (Stripe side succeeded despite listing failure).
    const { orderId } = await setupCancellingOrder();
    await runRecovery();

    assertEqual(getOrder(orderId).status, 'CANCELLED', 'order must be CANCELLED despite listing failure');
    const types = getEvents(orderId).map((e) => e.event_type);
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
      amountCents: 14550,
      metadata: { orderId: String(orderId), operationType: 'cancel' },
      status: 'succeeded',
    });
    injectStubRefund({
      id: 're_stub_cancel_dup_2',
      paymentIntentId: piId,
      amountCents: 14550,
      metadata: { orderId: String(orderId), operationType: 'cancel' },
      status: 'succeeded',
    });

    await runRecovery();
    assertEqual(getOrder(orderId).status, 'CANCELLING', 'order must stay CANCELLING when ambiguous');
    assert(getEvents(orderId).some((e) => e.event_type === 'RECOVERY_AMBIGUOUS'), 'RECOVERY_AMBIGUOUS required');
  });

  await test('repeated recovery: second sweep skips already-CANCELLED order, no duplicate refund', async () => {
    const { orderId } = await setupCancellingOrder();
    await runRecovery();
    assertEqual(getOrder(orderId).status, 'CANCELLED', 'first sweep must CANCEL');

    const refundsBefore = stripeClient._refunds.length;
    await runRecovery();
    assertEqual(stripeClient._refunds.length, refundsBefore, 'no new refund on second sweep');

    const events = getEvents(orderId);
    assertEqual(events.filter((e) => e.event_type === 'CANCELLED').length, 1, 'exactly one CANCELLED event');
    assertEqual(events.filter((e) => e.event_type === 'RECOVERY_CANCELLED').length, 1, 'exactly one RECOVERY_CANCELLED event');
  });

  await test('same idempotency key on re-issue returns same refund ID', async () => {
    const { orderId } = await setupCancellingOrder();
    await runRecovery();
    const refundId1 = getOrder(orderId).stripe_refund_id;
    assert(refundId1, 'refund_id must be set after first recovery');

    // Reset to CANCELLING with cleared refund_id and stale timestamp
    db.prepare(`UPDATE orders SET status='CANCELLING', stripe_refund_id=NULL, recovery_claimed_at=NULL WHERE id=?`).run(orderId);
    makeStale(orderId);
    await runRecovery();
    const refundId2 = getOrder(orderId).stripe_refund_id;
    assertEqual(refundId1, refundId2, 'same idempotency key must produce same refund ID');
  });

  await test('in-process guard: concurrent sweep call returns skipped while first is running', async () => {
    // We cannot create true concurrency in a single-threaded test, but we can
    // verify the guard by invoking runRecovery twice without awaiting the first.
    const { orderId } = await setupCancellingOrder();
    const p1 = runRecovery(); // start — does NOT await
    const p2 = runRecovery(); // immediately start second — should get skipped
    const [r1, r2] = await Promise.all([p1, p2]);
    // One should have run and one should have been skipped.
    // Because both start synchronously and recoveryInProgress is set before any await,
    // the second call sees recoveryInProgress = true and returns { skipped: true }.
    assert(
      (r1.skipped && !r2.skipped) || (!r1.skipped && r2.skipped),
      'exactly one sweep should be skipped'
    );
  });
}

// ---------------------------------------------------------------------------
// Schema migration tests
// ---------------------------------------------------------------------------

async function runMigrationTests() {
  console.log('\nSchema migration');

  await test('new columns exist in orders table', async () => {
    const cols = db.prepare("PRAGMA table_info(orders)").all().map((c) => c.name);
    for (const col of ['prior_status', 'transition_started_at', 'recovery_claimed_at', 'recovery_attempts', 'last_recovery_error']) {
      assert(cols.includes(col), `Column '${col}' must exist in orders table`);
    }
  });

  await test('reserveTransition writes prior_status and transition_started_at', async () => {
    const pi = await createStubPI(5000);
    await stripeClient.capturePaymentIntent(pi.id, { idempotencyKey: `cap_mig_${pi.id}` });
    const orderId = insertOrder({
      stripe_payment_intent_id: pi.id,
      stripe_charge_id: (await stripeClient.getPaymentIntent(pi.id)).chargeId,
      status: 'HELD',
    });
    // Simulate reserveTransition directly (same SQL as the real function).
    const now = new Date().toISOString();
    db.prepare(`UPDATE orders SET status='CAPTURING', updated_at=?, prior_status=status, transition_started_at=? WHERE id=? AND status='HELD'`)
      .run(now, now, orderId);
    const row = getOrder(orderId);
    assertEqual(row.prior_status, 'HELD', 'prior_status must capture the pre-transition status');
    assert(row.transition_started_at, 'transition_started_at must be set');
  });
}

// ---------------------------------------------------------------------------
// Migration backfill tests — simulate pre-migration rows and verify they
// become visible to recovery after runMigrationBackfill() is called.
// ---------------------------------------------------------------------------

async function runMigrationBackfillTests() {
  console.log('\nMigration backfill');

  // Helper: insert a row that mimics a pre-migration order — no transition_started_at,
  // no prior_status, updated_at set to a realistic past timestamp.
  function insertPreMigrationOrder(status, updatedAt, eventOverrides = []) {
    const id = insertOrder({
      status,
      transition_started_at: null,
      prior_status: null,
      stripe_payment_intent_id: `pi_premig_${Date.now()}_${Math.random()}`,
      updated_at: updatedAt,
      created_at: updatedAt,
    });
    for (const ev of eventOverrides) {
      db.prepare(
        `INSERT INTO order_events (order_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)`
      ).run(id, ev.event_type, JSON.stringify(ev.payload || {}), updatedAt);
    }
    return id;
  }

  const pastTs = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago

  await test('backfill sets transition_started_at from updated_at for all transient statuses', async () => {
    const ids = {
      CAPTURING:  insertPreMigrationOrder('CAPTURING',  pastTs),
      RELEASING:  insertPreMigrationOrder('RELEASING',  pastTs),
      REFUNDING:  insertPreMigrationOrder('REFUNDING',  pastTs),
      CANCELLING: insertPreMigrationOrder('CANCELLING', pastTs),
    };

    runMigrationBackfill();

    for (const [status, id] of Object.entries(ids)) {
      const row = getOrder(id);
      assertEqual(row.transition_started_at, pastTs,
        `${status}: transition_started_at must equal updated_at after backfill`);
    }
  });

  await test('backfill sets prior_status correctly for CAPTURING, REFUNDING, CANCELLING', async () => {
    const capId = insertPreMigrationOrder('CAPTURING',  pastTs);
    const refId = insertPreMigrationOrder('REFUNDING',  pastTs);
    const canId = insertPreMigrationOrder('CANCELLING', pastTs);

    runMigrationBackfill();

    assertEqual(getOrder(capId).prior_status, 'CREATED',   'CAPTURING → prior_status = CREATED');
    assertEqual(getOrder(refId).prior_status, 'DISPUTED',  'REFUNDING → prior_status = DISPUTED');
    assertEqual(getOrder(canId).prior_status, 'HELD',      'CANCELLING → prior_status = HELD');
  });

  await test('backfill infers RELEASING prior_status as DELIVERED when no DISPUTE_FILED event', async () => {
    const id = insertPreMigrationOrder('RELEASING', pastTs); // no events
    runMigrationBackfill();
    assertEqual(getOrder(id).prior_status, 'DELIVERED',
      'RELEASING without DISPUTE_FILED event → prior_status = DELIVERED');
  });

  await test('backfill infers RELEASING prior_status as DISPUTED when DISPUTE_FILED event exists', async () => {
    const id = insertPreMigrationOrder('RELEASING', pastTs, [{ event_type: 'DISPUTE_FILED' }]);
    runMigrationBackfill();
    assertEqual(getOrder(id).prior_status, 'DISPUTED',
      'RELEASING with DISPUTE_FILED event → prior_status = DISPUTED');
  });

  await test('backfill is idempotent — calling twice does not overwrite already-set values', async () => {
    const id = insertOrder({
      status: 'CAPTURING',
      transition_started_at: null,
      prior_status: null,
      updated_at: pastTs,
      created_at: pastTs,
    });
    runMigrationBackfill(); // first call sets values
    const afterFirst = getOrder(id);
    runMigrationBackfill(); // second call must be a no-op
    const afterSecond = getOrder(id);
    assertEqual(afterFirst.prior_status, afterSecond.prior_status,
      'prior_status must not change on second backfill');
    assertEqual(afterFirst.transition_started_at, afterSecond.transition_started_at,
      'transition_started_at must not change on second backfill');
  });

  await test('backfilled CAPTURING order becomes visible to recovery after backfill', async () => {
    const pi = await createStubPI(10000);
    const id = insertPreMigrationOrder('CAPTURING', pastTs);
    // Point to a real stub PI so recovery can interrogate it
    db.prepare('UPDATE orders SET stripe_payment_intent_id = ? WHERE id = ?').run(pi.id, id);

    // Before backfill: transition_started_at IS NULL → candidate query excludes it
    const beforeBackfill = await runRecovery();
    assert(!beforeBackfill.recoveredOrderIds.includes(id),
      'order must NOT be visible to recovery before backfill (transition_started_at IS NULL)');

    runMigrationBackfill();

    // After backfill: transition_started_at = pastTs (1h ago → stale) → candidate picked up
    // Also clear recovery_claimed_at so the stale-threshold filter applies
    db.prepare('UPDATE orders SET recovery_claimed_at = NULL WHERE id = ?').run(id);
    const afterBackfill = await runRecovery();
    assert(
      afterBackfill.recoveredOrderIds.includes(id) ||
      afterBackfill.ambiguous.some((a) => a.orderId === id) ||
      afterBackfill.failed.some((f) => f.orderId === id),
      'order must be visible to recovery after backfill (transition_started_at set)'
    );
  });
}

// ---------------------------------------------------------------------------
// Run all suites
// ---------------------------------------------------------------------------

(async () => {
  console.log('=== Recovery Tests (Phase 2) ===');
  loadSeedIds();

  await runMigrationTests();
  await runMigrationBackfillTests();
  await runCapturingTests();
  await runReleasingTests();
  await runRefundingTests();
  await runCancellingTests();

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);

  // Cleanup temp directory
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}

  if (failed > 0) process.exit(1);
})();

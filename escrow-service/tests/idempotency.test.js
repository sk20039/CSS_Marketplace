// tests/idempotency.test.js
//
// Standalone test script — no test runner required.
// Run: node tests/idempotency.test.js
// Exit code 0 = all passed, 1 = any failed.
//
// Tests the StubStripeClient idempotency contract:
//   - Same key + same params => same result, no second Stripe operation
//   - Same key + different params => clear conflict error
//   - No key => every call is independent (documents the double-refund risk)
//   - Metadata is recorded and excluded from the conflict fingerprint
//   - Verifies the four deterministic key formats used by orderService

'use strict';

const { StubStripeClient } = require('../src/stripeClient');

// ---------------------------------------------------------------------------
// Minimal test harness
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
  let thrownMessage = '';
  try {
    await fn();
  } catch (err) {
    threw = true;
    thrownMessage = err.message;
  }
  if (!threw) throw new Error('Expected function to throw but it returned normally');
  if (requiredSubstring && !thrownMessage.includes(requiredSubstring)) {
    throw new Error(
      `Expected error to contain "${requiredSubstring}" but got: "${thrownMessage}"`
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function freshIntent(client, amountCents = 10000) {
  return client.createPaymentIntent({ amountCents, currency: 'usd', metadata: {} });
}

// ---------------------------------------------------------------------------
// capturePaymentIntent
// ---------------------------------------------------------------------------
async function runCaptureTests() {
  console.log('\ncapturePaymentIntent  [key format: capture_order_{id}]');

  await test('same key returns identical id and chargeId', async () => {
    const c = new StubStripeClient();
    const pi = await freshIntent(c);
    const r1 = await c.capturePaymentIntent(pi.id, { idempotencyKey: 'capture_order_42' });
    const r2 = await c.capturePaymentIntent(pi.id, { idempotencyKey: 'capture_order_42' });
    assertEqual(r1.id, r2.id, 'id must be identical on replay');
    assertEqual(r1.chargeId, r2.chargeId, 'chargeId must be identical on replay');
  });

  await test('replay does not re-execute the capture mutation', async () => {
    // The first call flips intent.status to 'succeeded'. If _checkIdempotency
    // ran resultFn a second time it would still return the same status, but
    // the key proof is that the returned id is the same object from cache.
    const c = new StubStripeClient();
    const pi = await freshIntent(c);
    const r1 = await c.capturePaymentIntent(pi.id, { idempotencyKey: 'capture_order_42' });
    const r2 = await c.capturePaymentIntent(pi.id, { idempotencyKey: 'capture_order_42' });
    assert(r1 === r2, 'replay must return the exact same cached result object');
  });

  await test('different order ids produce independent captures', async () => {
    const c = new StubStripeClient();
    const pi1 = await freshIntent(c, 5000);
    const pi2 = await freshIntent(c, 9000);
    const r1 = await c.capturePaymentIntent(pi1.id, { idempotencyKey: 'capture_order_1' });
    const r2 = await c.capturePaymentIntent(pi2.id, { idempotencyKey: 'capture_order_2' });
    assert(r1.id !== r2.id, 'different keys must produce independent captures');
  });

  await test('conflict: same key, different paymentIntentId', async () => {
    const c = new StubStripeClient();
    const pi1 = await freshIntent(c);
    const pi2 = await freshIntent(c);
    await c.capturePaymentIntent(pi1.id, { idempotencyKey: 'capture_order_99' });
    await assertThrows(
      () => c.capturePaymentIntent(pi2.id, { idempotencyKey: 'capture_order_99' }),
      'different parameters'
    );
  });

  await test('no key — every call executes independently (no dedup)', async () => {
    const c = new StubStripeClient();
    const pi = await freshIntent(c);
    const r1 = await c.capturePaymentIntent(pi.id);
    // Without a key the function always calls resultFn, never the cache.
    // We verify the returned object is NOT the same reference as any cached entry.
    const r2 = await c.capturePaymentIntent(pi.id);
    // Both succeed (stub is lenient about re-capturing), but they are not
    // guaranteed to be the same object — the important assertion is that the
    // cache was NOT consulted (no idempotencyKey means no caching).
    assert(r1.id === pi.id, 'result id should match intent id');
    assert(r2.id === pi.id, 'second result id should match intent id');
    // The real test: the two results are distinct JS objects.
    assert(r1 !== r2, 'without a key, each call returns a fresh result object');
  });
}

// ---------------------------------------------------------------------------
// createTransfer
// ---------------------------------------------------------------------------
async function runTransferTests() {
  console.log('\ncreateTransfer  [key format: release_order_{id}]');

  await test('same key returns the same transfer id', async () => {
    const c = new StubStripeClient();
    const opts = {
      amountCents: 9700,
      currency: 'usd',
      destination: 'acct_123',
      sourceTransactionId: 'ch_abc',
      metadata: { orderId: '5', operationType: 'release' },
      idempotencyKey: 'release_order_5',
    };
    const r1 = await c.createTransfer(opts);
    const r2 = await c.createTransfer(opts);
    assertEqual(r1.id, r2.id, 'transfer id must be identical on replay');
    assert(r1.id.startsWith('tr_'), 'transfer id must have tr_ prefix');
  });

  await test('replay returns the exact cached result object', async () => {
    const c = new StubStripeClient();
    const opts = {
      amountCents: 5000,
      currency: 'usd',
      destination: 'acct_aaa',
      sourceTransactionId: 'ch_xyz',
      idempotencyKey: 'release_order_20',
    };
    const r1 = await c.createTransfer(opts);
    const r2 = await c.createTransfer(opts);
    assert(r1 === r2, 'replay must return the exact same cached result object');
  });

  await test('different order ids produce distinct transfer ids', async () => {
    const c = new StubStripeClient();
    const base = { amountCents: 9700, currency: 'usd', destination: 'acct_123', sourceTransactionId: 'ch_abc' };
    const r1 = await c.createTransfer({ ...base, idempotencyKey: 'release_order_5' });
    const r2 = await c.createTransfer({ ...base, idempotencyKey: 'release_order_6' });
    assert(r1.id !== r2.id, 'different order keys must produce different transfer ids');
  });

  await test('no key — each call creates a distinct transfer (no dedup)', async () => {
    const c = new StubStripeClient();
    const opts = { amountCents: 9700, currency: 'usd', destination: 'acct_123', sourceTransactionId: 'ch_abc' };
    const r1 = await c.createTransfer(opts);
    const r2 = await c.createTransfer(opts);
    assert(r1.id !== r2.id, 'without a key, each transfer must have a unique id');
  });

  await test('conflict: same key, different amountCents', async () => {
    const c = new StubStripeClient();
    await c.createTransfer({
      amountCents: 9700,
      currency: 'usd',
      destination: 'acct_123',
      sourceTransactionId: 'ch_abc',
      idempotencyKey: 'release_order_10',
    });
    await assertThrows(
      () =>
        c.createTransfer({
          amountCents: 9999, // different
          currency: 'usd',
          destination: 'acct_123',
          sourceTransactionId: 'ch_abc',
          idempotencyKey: 'release_order_10',
        }),
      'different parameters'
    );
  });

  await test('conflict: same key, different destination', async () => {
    const c = new StubStripeClient();
    await c.createTransfer({
      amountCents: 5000,
      currency: 'usd',
      destination: 'acct_aaa',
      sourceTransactionId: 'ch_xyz',
      idempotencyKey: 'release_order_11',
    });
    await assertThrows(
      () =>
        c.createTransfer({
          amountCents: 5000,
          currency: 'usd',
          destination: 'acct_bbb', // different
          sourceTransactionId: 'ch_xyz',
          idempotencyKey: 'release_order_11',
        }),
      'different parameters'
    );
  });

  await test('identical metadata with different property order replays without conflict', async () => {
    // stableFingerprint sorts keys before serialising, so the same logical
    // metadata object produces the same fingerprint regardless of how the
    // caller constructed it. This must be a replay, not an idempotency conflict.
    const c = new StubStripeClient();
    const r1 = await c.createTransfer({
      amountCents: 5000,
      currency: 'usd',
      destination: 'acct_aaa',
      sourceTransactionId: 'ch_xyz',
      metadata: { orderId: '12', operationType: 'release' },
      idempotencyKey: 'release_order_12',
    });
    // Same logical metadata — property order swapped
    const r2 = await c.createTransfer({
      amountCents: 5000,
      currency: 'usd',
      destination: 'acct_aaa',
      sourceTransactionId: 'ch_xyz',
      metadata: { operationType: 'release', orderId: '12' },
      idempotencyKey: 'release_order_12',
    });
    assertEqual(r1.id, r2.id, 'property-order-only difference must replay the same transfer');
  });

  await test('changed metadata with same key produces an idempotency conflict', async () => {
    // Metadata IS part of the fingerprint. A different operationType on the
    // same key indicates a different intended operation — that is a conflict.
    const c = new StubStripeClient();
    await c.createTransfer({
      amountCents: 5000,
      currency: 'usd',
      destination: 'acct_aaa',
      sourceTransactionId: 'ch_xyz',
      metadata: { orderId: '13', operationType: 'release' },
      idempotencyKey: 'release_order_13',
    });
    await assertThrows(
      () =>
        c.createTransfer({
          amountCents: 5000,
          currency: 'usd',
          destination: 'acct_aaa',
          sourceTransactionId: 'ch_xyz',
          metadata: { orderId: '13', operationType: 'release_retry' },
          idempotencyKey: 'release_order_13',
        }),
      'different parameters'
    );
  });
}

// ---------------------------------------------------------------------------
// createRefund — full dispute refund
// ---------------------------------------------------------------------------
async function runDisputeRefundTests() {
  console.log('\ncreateRefund (dispute)  [key format: refund_dispute_order_{id}]');

  await test('same key returns the same refund id', async () => {
    const c = new StubStripeClient();
    const pi = await freshIntent(c, 8500);
    await c.capturePaymentIntent(pi.id, { idempotencyKey: 'capture_order_7' });
    const r1 = await c.createRefund({
      paymentIntentId: pi.id,
      amountCents: 8500,
      metadata: { orderId: '7', operationType: 'refund_dispute' },
      idempotencyKey: 'refund_dispute_order_7',
    });
    const r2 = await c.createRefund({
      paymentIntentId: pi.id,
      amountCents: 8500,
      metadata: { orderId: '7', operationType: 'refund_dispute' },
      idempotencyKey: 'refund_dispute_order_7',
    });
    assertEqual(r1.id, r2.id, 'refund id must be identical on replay');
    assert(r1.id.startsWith('re_'), 'refund id must have re_ prefix');
  });

  await test('replay returns the exact cached result object (no second Stripe call)', async () => {
    const c = new StubStripeClient();
    const pi = await freshIntent(c, 8500);
    await c.capturePaymentIntent(pi.id, { idempotencyKey: 'capture_order_7' });
    const opts = {
      paymentIntentId: pi.id,
      amountCents: 8500,
      metadata: { orderId: '7', operationType: 'refund_dispute' },
      idempotencyKey: 'refund_dispute_order_7',
    };
    const r1 = await c.createRefund(opts);
    const r2 = await c.createRefund(opts);
    assert(r1 === r2, 'replay must return the exact same cached result object');
  });

  await test('different dispute orders produce distinct refund ids', async () => {
    const c = new StubStripeClient();
    const pi1 = await freshIntent(c, 8500);
    const pi2 = await freshIntent(c, 5000);
    await c.capturePaymentIntent(pi1.id, { idempotencyKey: 'capture_order_7' });
    await c.capturePaymentIntent(pi2.id, { idempotencyKey: 'capture_order_8' });
    const r1 = await c.createRefund({
      paymentIntentId: pi1.id,
      amountCents: 8500,
      idempotencyKey: 'refund_dispute_order_7',
    });
    const r2 = await c.createRefund({
      paymentIntentId: pi2.id,
      amountCents: 5000,
      idempotencyKey: 'refund_dispute_order_8',
    });
    assert(r1.id !== r2.id, 'different order keys must produce distinct refund ids');
  });

  await test('conflict: same key, different amountCents', async () => {
    const c = new StubStripeClient();
    const pi = await freshIntent(c, 8500);
    await c.capturePaymentIntent(pi.id, { idempotencyKey: 'capture_order_99' });
    await c.createRefund({
      paymentIntentId: pi.id,
      amountCents: 8500,
      idempotencyKey: 'refund_dispute_order_99',
    });
    await assertThrows(
      () =>
        c.createRefund({
          paymentIntentId: pi.id,
          amountCents: 8499, // different
          idempotencyKey: 'refund_dispute_order_99',
        }),
      'different parameters'
    );
  });

  await test('identical refund metadata with different property order replays without conflict', async () => {
    const c = new StubStripeClient();
    const pi = await freshIntent(c, 8500);
    await c.capturePaymentIntent(pi.id, { idempotencyKey: 'capture_order_50' });
    const r1 = await c.createRefund({
      paymentIntentId: pi.id,
      amountCents: 8500,
      metadata: { orderId: '50', operationType: 'refund_dispute' },
      idempotencyKey: 'refund_dispute_order_50',
    });
    // Same logical metadata, property order reversed
    const r2 = await c.createRefund({
      paymentIntentId: pi.id,
      amountCents: 8500,
      metadata: { operationType: 'refund_dispute', orderId: '50' },
      idempotencyKey: 'refund_dispute_order_50',
    });
    assertEqual(r1.id, r2.id, 'property-order-only difference must replay the same refund');
  });

  await test('changed refund metadata with same key produces an idempotency conflict', async () => {
    const c = new StubStripeClient();
    const pi = await freshIntent(c, 8500);
    await c.capturePaymentIntent(pi.id, { idempotencyKey: 'capture_order_51' });
    await c.createRefund({
      paymentIntentId: pi.id,
      amountCents: 8500,
      metadata: { orderId: '51', operationType: 'refund_dispute' },
      idempotencyKey: 'refund_dispute_order_51',
    });
    await assertThrows(
      () =>
        c.createRefund({
          paymentIntentId: pi.id,
          amountCents: 8500,
          metadata: { orderId: '51', operationType: 'refund_dispute_retry' }, // changed operationType
          idempotencyKey: 'refund_dispute_order_51',
        }),
      'different parameters'
    );
  });
}

// ---------------------------------------------------------------------------
// createRefund — partial cancellation refund
// ---------------------------------------------------------------------------
async function runCancelRefundTests() {
  console.log('\ncreateRefund (cancel)  [key format: cancel_order_{id}]');

  await test('same key returns the same refund id — no double-refund', async () => {
    const c = new StubStripeClient();
    // $150.00 order, $4.50 fee, buyer gets back $145.50
    const pi = await freshIntent(c, 15000);
    await c.capturePaymentIntent(pi.id, { idempotencyKey: 'capture_order_9' });
    const refundAmount = 15000 - 450; // 14550
    const r1 = await c.createRefund({
      paymentIntentId: pi.id,
      amountCents: refundAmount,
      metadata: { orderId: '9', operationType: 'cancel' },
      idempotencyKey: 'cancel_order_9',
    });
    const r2 = await c.createRefund({
      paymentIntentId: pi.id,
      amountCents: refundAmount,
      metadata: { orderId: '9', operationType: 'cancel' },
      idempotencyKey: 'cancel_order_9',
    });
    assertEqual(r1.id, r2.id, 'cancel refund id must be identical on replay — no double-refund');
    assert(r1.id.startsWith('re_'), 'refund id must have re_ prefix');
  });

  await test('replay returns the exact cached result object', async () => {
    const c = new StubStripeClient();
    const pi = await freshIntent(c, 15000);
    await c.capturePaymentIntent(pi.id, { idempotencyKey: 'capture_order_9' });
    const opts = {
      paymentIntentId: pi.id,
      amountCents: 14550,
      metadata: { orderId: '9', operationType: 'cancel' },
      idempotencyKey: 'cancel_order_9',
    };
    const r1 = await c.createRefund(opts);
    const r2 = await c.createRefund(opts);
    assert(r1 === r2, 'replay must return the exact same cached result object');
  });

  await test('no key — each call creates a distinct refund id (documents double-refund risk)', async () => {
    // This test documents the unsafe scenario that idempotency keys prevent.
    // Without a key the stub creates two separate refund IDs for the same
    // partial amount — exactly the double-refund that would occur if the
    // process crashed after the first Stripe call and retried without a key.
    const c = new StubStripeClient();
    const pi = await freshIntent(c, 15000);
    await c.capturePaymentIntent(pi.id);
    const r1 = await c.createRefund({ paymentIntentId: pi.id, amountCents: 14550 });
    const r2 = await c.createRefund({ paymentIntentId: pi.id, amountCents: 14550 });
    assert(r1.id !== r2.id, 'without a key, each refund call produces a distinct id (double-refund risk)');
  });

  await test('conflict: same cancel key, different refund amount', async () => {
    const c = new StubStripeClient();
    const pi = await freshIntent(c, 15000);
    await c.capturePaymentIntent(pi.id, { idempotencyKey: 'capture_order_11' });
    await c.createRefund({
      paymentIntentId: pi.id,
      amountCents: 14550,
      idempotencyKey: 'cancel_order_11',
    });
    await assertThrows(
      () =>
        c.createRefund({
          paymentIntentId: pi.id,
          amountCents: 14551, // different
          idempotencyKey: 'cancel_order_11',
        }),
      'different parameters'
    );
  });

  await test('conflict: same cancel key, different paymentIntentId', async () => {
    const c = new StubStripeClient();
    const pi1 = await freshIntent(c, 10000);
    const pi2 = await freshIntent(c, 10000);
    await c.capturePaymentIntent(pi1.id, { idempotencyKey: 'capture_order_12' });
    await c.capturePaymentIntent(pi2.id, { idempotencyKey: 'capture_order_13' });
    await c.createRefund({
      paymentIntentId: pi1.id,
      amountCents: 9700,
      idempotencyKey: 'cancel_order_12',
    });
    await assertThrows(
      () =>
        c.createRefund({
          paymentIntentId: pi2.id, // different PI
          amountCents: 9700,
          idempotencyKey: 'cancel_order_12',
        }),
      'different parameters'
    );
  });
}

// ---------------------------------------------------------------------------
// Metadata recording
// ---------------------------------------------------------------------------
async function runMetadataTests() {
  console.log('\nStripe metadata');

  await test('transfer carries orderId and operationType=release', async () => {
    const c = new StubStripeClient();
    const result = await c.createTransfer({
      amountCents: 9700,
      currency: 'usd',
      destination: 'acct_123',
      sourceTransactionId: 'ch_abc',
      metadata: { orderId: '5', operationType: 'release' },
      idempotencyKey: 'release_order_5',
    });
    assertEqual(result.metadata.orderId, '5', 'metadata.orderId must equal order id as string');
    assertEqual(result.metadata.operationType, 'release', 'metadata.operationType must be "release"');
  });

  await test('dispute refund carries orderId and operationType=refund_dispute', async () => {
    const c = new StubStripeClient();
    const pi = await freshIntent(c, 8500);
    const result = await c.createRefund({
      paymentIntentId: pi.id,
      amountCents: 8500,
      metadata: { orderId: '7', operationType: 'refund_dispute' },
      idempotencyKey: 'refund_dispute_order_7',
    });
    assertEqual(result.metadata.orderId, '7', 'metadata.orderId must equal order id as string');
    assertEqual(result.metadata.operationType, 'refund_dispute', 'metadata.operationType must be "refund_dispute"');
  });

  await test('cancel refund carries orderId and operationType=cancel', async () => {
    const c = new StubStripeClient();
    const pi = await freshIntent(c, 15000);
    const result = await c.createRefund({
      paymentIntentId: pi.id,
      amountCents: 14550,
      metadata: { orderId: '9', operationType: 'cancel' },
      idempotencyKey: 'cancel_order_9',
    });
    assertEqual(result.metadata.orderId, '9', 'metadata.orderId must equal order id as string');
    assertEqual(result.metadata.operationType, 'cancel', 'metadata.operationType must be "cancel"');
  });

  await test('transfer metadata is preserved on idempotent replay', async () => {
    const c = new StubStripeClient();
    const opts = {
      amountCents: 5000,
      currency: 'usd',
      destination: 'acct_aaa',
      sourceTransactionId: 'ch_xyz',
      metadata: { orderId: '20', operationType: 'release' },
      idempotencyKey: 'release_order_20',
    };
    const r1 = await c.createTransfer(opts);
    const r2 = await c.createTransfer(opts);
    assertEqual(r2.metadata.orderId, '20', 'metadata must survive replay');
    assertEqual(r2.metadata.operationType, 'release', 'metadata.operationType must survive replay');
    assertEqual(r1.id, r2.id, 'id must be the same on replay');
  });
}

// ---------------------------------------------------------------------------
// Key format verification
// ---------------------------------------------------------------------------
async function runKeyFormatTests() {
  console.log('\nIdempotency key format (matches orderService constants)');

  await test('capture key format: capture_order_{id}', async () => {
    // Verify the key format used by orderService.captureOrder is recognised
    // by the stub without errors and produces a stable result.
    const c = new StubStripeClient();
    const pi = await freshIntent(c);
    const orderId = 42;
    const key = `capture_order_${orderId}`;
    const r1 = await c.capturePaymentIntent(pi.id, { idempotencyKey: key });
    const r2 = await c.capturePaymentIntent(pi.id, { idempotencyKey: key });
    assertEqual(r1.id, r2.id);
  });

  await test('release key format: release_order_{id}', async () => {
    const c = new StubStripeClient();
    const orderId = 5;
    const key = `release_order_${orderId}`;
    const r1 = await c.createTransfer({
      amountCents: 9700, currency: 'usd', destination: 'acct_x',
      sourceTransactionId: 'ch_y', idempotencyKey: key,
    });
    const r2 = await c.createTransfer({
      amountCents: 9700, currency: 'usd', destination: 'acct_x',
      sourceTransactionId: 'ch_y', idempotencyKey: key,
    });
    assertEqual(r1.id, r2.id);
  });

  await test('refund_dispute key format: refund_dispute_order_{id}', async () => {
    const c = new StubStripeClient();
    const pi = await freshIntent(c, 8500);
    const orderId = 7;
    const key = `refund_dispute_order_${orderId}`;
    const r1 = await c.createRefund({ paymentIntentId: pi.id, amountCents: 8500, idempotencyKey: key });
    const r2 = await c.createRefund({ paymentIntentId: pi.id, amountCents: 8500, idempotencyKey: key });
    assertEqual(r1.id, r2.id);
  });

  await test('cancel key format: cancel_order_{id}', async () => {
    const c = new StubStripeClient();
    const pi = await freshIntent(c, 15000);
    const orderId = 9;
    const key = `cancel_order_${orderId}`;
    const r1 = await c.createRefund({ paymentIntentId: pi.id, amountCents: 14550, idempotencyKey: key });
    const r2 = await c.createRefund({ paymentIntentId: pi.id, amountCents: 14550, idempotencyKey: key });
    assertEqual(r1.id, r2.id);
  });

  await test('capture and cancel keys for the same order id do not collide', async () => {
    // Different operation prefixes must produce different cache namespaces.
    const c = new StubStripeClient();
    const pi = await freshIntent(c, 10000);
    // Use capture_order_9 for capture
    const captureResult = await c.capturePaymentIntent(pi.id, { idempotencyKey: 'capture_order_9' });
    // cancel_order_9 must be independent — it is a refund call on a different method
    const refundResult = await c.createRefund({
      paymentIntentId: pi.id,
      amountCents: 9700,
      idempotencyKey: 'cancel_order_9',
    });
    assert(captureResult.id !== refundResult.id, 'capture and cancel keys for same order id must not collide');
  });
}

// ---------------------------------------------------------------------------
// Run all suites
// ---------------------------------------------------------------------------
(async () => {
  console.log('=== Stripe Idempotency Tests (Phase 1) ===');
  await runCaptureTests();
  await runTransferTests();
  await runDisputeRefundTests();
  await runCancelRefundTests();
  await runMetadataTests();
  await runKeyFormatTests();

  const total = passed + failed;
  console.log(`\n${total} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();

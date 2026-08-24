// Phase 2 stale financial transition recovery.
//
// Covers orders that entered a transient status (CAPTURING, RELEASING,
// REFUNDING, CANCELLING) but never reached a terminal state because the
// process stopped between reserving the transition and finalizing the DB.
//
// Recovery is safe at any time after a restart because:
//   - All Stripe calls use deterministic idempotency keys (Phase 1), so
//     re-issuing a Stripe request that already completed returns the same
//     result without creating a duplicate charge/transfer/refund.
//   - Finalization uses the same conditional UPDATE WHERE status = <transient>
//     as normal processing — if a concurrent HTTP request finalizes first,
//     recovery's UPDATE returns 0 changes and FinalizeConflictError is caught
//     as a success (the order is already in the correct terminal state).
//   - The recovery_claimed_at column prevents two concurrent recovery sweeps
//     from both acting on the same order (SQLite serializes the claim UPDATE).
//
// Entry points:
//   runRecovery()       — called by scheduler on startup and on each cron tick
//   POST /admin/run-recovery — manual trigger wired in app.js

'use strict';

const db = require('./db');
const { stripeClient } = require('./stripeClient');
const {
  FinalizeConflictError,
  finalizeCaptured,
  finalizeReleased,
  finalizeRefunded,
  finalizeCancelled,
} = require('./orderService');

const STALE_THRESHOLD_MINUTES = Number(process.env.STALE_THRESHOLD_MINUTES || 10);
// A claimed order is considered abandoned if recovery_claimed_at is older than
// CLAIM_EXPIRY (= 2× threshold). This lets a second sweep re-try an order
// whose recovery sweep died mid-flight.
const CLAIM_EXPIRY_MINUTES = STALE_THRESHOLD_MINUTES * 2;

const TRANSIENT_STATUSES = ['CAPTURING', 'RELEASING', 'REFUNDING', 'CANCELLING'];

// In-process guard: prevents a second cron tick from starting a new sweep
// while the previous sweep is still awaiting Stripe responses.
let recoveryInProgress = false;

function nowIso() {
  return new Date().toISOString();
}

function recordEvent(orderId, eventType, payload) {
  db.prepare(
    `INSERT INTO order_events (order_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)`
  ).run(orderId, eventType, JSON.stringify(payload || {}), nowIso());
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

async function runRecovery() {
  if (recoveryInProgress) {
    console.log('[recovery] sweep already in progress — skipping this tick');
    return { skipped: true };
  }
  recoveryInProgress = true;
  try {
    return await _sweep();
  } finally {
    recoveryInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

async function _sweep() {
  const nowStr = nowIso();
  const staleThreshold = new Date(
    Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000
  ).toISOString();
  const claimExpiry = new Date(
    Date.now() - CLAIM_EXPIRY_MINUTES * 60 * 1000
  ).toISOString();

  // Find stale candidates. Excludes orders whose recovery_claimed_at is recent
  // (another sweep is working on them) — the claim UPDATE below is the
  // authoritative exclusion mechanism; this pre-filter is an optimisation.
  const placeholders = TRANSIENT_STATUSES.map(() => '?').join(',');
  const candidates = db
    .prepare(
      `SELECT * FROM orders
       WHERE status IN (${placeholders})
         AND transition_started_at IS NOT NULL
         AND transition_started_at <= ?
         AND (recovery_claimed_at IS NULL OR recovery_claimed_at < ?)`
    )
    .all(...TRANSIENT_STATUSES, staleThreshold, claimExpiry);

  const recovered = [];
  const failed = [];
  const ambiguous = [];

  for (const order of candidates) {
    // Atomic claim — SQLite serializes this UPDATE so only one sweep wins per order.
    const claimed = db
      .prepare(
        `UPDATE orders
         SET recovery_claimed_at = ?, recovery_attempts = recovery_attempts + 1
         WHERE id = ?
           AND status = ?
           AND (recovery_claimed_at IS NULL OR recovery_claimed_at < ?)`
      )
      .run(nowStr, order.id, order.status, claimExpiry);

    if (claimed.changes === 0) {
      // Another sweep claimed it between our SELECT and this UPDATE — skip.
      continue;
    }

    try {
      const result = await _recoverOrder(order);
      // Clear any error recorded from a previous failed attempt.
      db.prepare('UPDATE orders SET last_recovery_error = NULL WHERE id = ?').run(order.id);
      if (result.outcome === 'ambiguous') {
        ambiguous.push({ orderId: order.id, reason: result.reason });
      } else {
        recovered.push(order.id);
      }
    } catch (err) {
      // Record error but continue — one bad order must not stop others.
      try {
        db.prepare('UPDATE orders SET last_recovery_error = ? WHERE id = ?').run(
          err.message,
          order.id
        );
        recordEvent(order.id, 'RECOVERY_FAILED', { error: err.message });
      } catch (_) {
        // Ignore DB write failure for the error record itself
      }
      failed.push({ orderId: order.id, error: err.message });
      console.error(`[recovery] order ${order.id} recovery failed:`, err.message);
    }
  }

  if (candidates.length > 0) {
    console.log(
      `[recovery] sweep: ${recovered.length} recovered, ` +
        `${ambiguous.length} ambiguous, ${failed.length} failed ` +
        `(of ${candidates.length} stale candidates)`
    );
  }

  return {
    checkedAt: nowStr,
    staleThresholdMinutes: STALE_THRESHOLD_MINUTES,
    candidateCount: candidates.length,
    recoveredOrderIds: recovered,
    ambiguous,
    failed,
  };
}

// ---------------------------------------------------------------------------
// Per-order dispatch
// ---------------------------------------------------------------------------

async function _recoverOrder(order) {
  switch (order.status) {
    case 'CAPTURING':  return _reconcileCapturing(order);
    case 'RELEASING':  return _reconcileReleasing(order);
    case 'REFUNDING':  return _reconcileRefunding(order);
    case 'CANCELLING': return _reconcileCancelling(order);
    default:
      throw new Error(`Unexpected status for recovery: ${order.status}`);
  }
}

// ---------------------------------------------------------------------------
// CAPTURING reconciliation
// ---------------------------------------------------------------------------

async function _reconcileCapturing(order) {
  const pi = await stripeClient.getPaymentIntent(order.stripe_payment_intent_id);

  if (pi.status === 'succeeded') {
    // Stripe captured; process crashed before DB finalize.
    const stripeCapture = { id: pi.id, status: 'succeeded', chargeId: pi.chargeId };
    try {
      await finalizeCaptured(order, stripeCapture, { triggeredBy: 'recovery' });
    } catch (err) {
      if (err instanceof FinalizeConflictError) {
        // Another path beat recovery to the finalize — order is already HELD.
        recordEvent(order.id, 'RECOVERY_CAPTURED', {
          note: 'finalize conflict — order already finalized by concurrent path',
          stripePaymentIntentId: pi.id,
        });
        return { outcome: 'finalized' };
      }
      throw err;
    }
    recordEvent(order.id, 'RECOVERY_CAPTURED', {
      stripePaymentIntentId: pi.id,
      chargeId: pi.chargeId,
      note: 'finalized existing Stripe capture',
    });
    return { outcome: 'finalized' };
  }

  if (pi.status === 'requires_capture') {
    // Process crashed before calling Stripe — re-issue with same idempotency key.
    const captured = await stripeClient.capturePaymentIntent(order.stripe_payment_intent_id, {
      idempotencyKey: `capture_order_${order.id}`,
    });
    if (captured.status !== 'succeeded') {
      return _ambiguous(order, `capturePaymentIntent returned unexpected status: ${captured.status}`);
    }
    try {
      await finalizeCaptured(order, captured, { triggeredBy: 'recovery' });
    } catch (err) {
      if (err instanceof FinalizeConflictError) {
        recordEvent(order.id, 'RECOVERY_CAPTURED', {
          note: 'finalize conflict — order already finalized by concurrent path',
          stripePaymentIntentId: captured.id,
        });
        return { outcome: 'finalized' };
      }
      throw err;
    }
    recordEvent(order.id, 'RECOVERY_CAPTURED', {
      stripePaymentIntentId: captured.id,
      chargeId: captured.chargeId,
      note: 'issued capture during recovery',
    });
    return { outcome: 'finalized' };
  }

  // PI in an unrecoverable state (e.g., 'canceled', 'processing') — human needed.
  return _ambiguous(order, `PaymentIntent is in unrecoverable status: ${pi.status}`);
}

// ---------------------------------------------------------------------------
// RELEASING reconciliation
// ---------------------------------------------------------------------------

async function _reconcileReleasing(order) {
  if (!order.stripe_charge_id) {
    return _ambiguous(order, 'stripe_charge_id missing — cannot look up transfers');
  }

  const seller = db.prepare('SELECT * FROM users WHERE id = ?').get(order.seller_id);
  if (!seller || !seller.stripe_account_id) {
    return _ambiguous(order, `seller ${order.seller_id} has no connected Stripe account`);
  }

  const transferGroup = `order_${order.id}`;

  // Fetch candidates: primary by transfer_group, fallback by destination account.
  const candidates = await stripeClient.listTransfersForRelease({
    transferGroup,
    chargeId: order.stripe_charge_id,
    destinationAccountId: seller.stripe_account_id,
  });

  // Full validation: all six fields must match to rule out unrelated transfers.
  const matching = candidates.filter(
    (t) =>
      t.metadata &&
      t.metadata.orderId === String(order.id) &&
      t.metadata.operationType === 'release' &&
      t.destination === seller.stripe_account_id &&
      t.sourceTransactionId === order.stripe_charge_id &&
      t.currency === 'usd' &&
      t.amountCents === order.seller_payout_cents
  );

  let stripeTransfer;
  if (matching.length === 1) {
    stripeTransfer = matching[0];
  } else if (matching.length === 0) {
    // No matching transfer found — re-issue with the same idempotency key so
    // Stripe deduplicates if the original call went through but the response
    // was lost before the process could write the transfer ID to the DB.
    stripeTransfer = await stripeClient.createTransfer({
      amountCents: order.seller_payout_cents,
      currency: 'usd',
      destination: seller.stripe_account_id,
      metadata: { orderId: String(order.id), operationType: 'release' },
      sourceTransactionId: order.stripe_charge_id,
      transferGroup,
      idempotencyKey: `release_order_${order.id}`,
    });
  } else {
    return _ambiguous(order, `${matching.length} matching transfers found — expected 1`, {
      transferIds: matching.map((t) => t.id),
    });
  }

  try {
    await finalizeReleased(order, stripeTransfer, { triggeredBy: 'recovery' });
  } catch (err) {
    if (err instanceof FinalizeConflictError) {
      recordEvent(order.id, 'RECOVERY_RELEASED', {
        note: 'finalize conflict — order already finalized by concurrent path',
        stripeTransferId: stripeTransfer.id,
      });
      return { outcome: 'finalized' };
    }
    throw err;
  }

  recordEvent(order.id, 'RECOVERY_RELEASED', {
    stripeTransferId: stripeTransfer.id,
    note: matching.length === 1 ? 'finalized existing transfer' : 'issued transfer during recovery',
  });

  // If this was a disputed order, write the dispute_resolution field so the
  // admin UI reflects the correct outcome (mirrors resolveDispute behaviour).
  if (order.prior_status === 'DISPUTED') {
    db.prepare(`UPDATE orders SET dispute_resolution = 'release' WHERE id = ?`).run(order.id);
    recordEvent(order.id, 'DISPUTE_RESOLVED', { action: 'release', triggeredBy: 'recovery' });
  }

  return { outcome: 'finalized' };
}

// ---------------------------------------------------------------------------
// REFUNDING reconciliation
// ---------------------------------------------------------------------------

async function _reconcileRefunding(order) {
  const refunds = await stripeClient.listRefundsForPaymentIntent(order.stripe_payment_intent_id);
  const matching = refunds.filter(
    (r) =>
      r.metadata &&
      r.metadata.orderId === String(order.id) &&
      r.metadata.operationType === 'refund_dispute' &&
      r.amountCents === order.amount_cents
  );

  let stripeRefund;
  if (matching.length === 1) {
    stripeRefund = matching[0];
  } else if (matching.length === 0) {
    stripeRefund = await stripeClient.createRefund({
      paymentIntentId: order.stripe_payment_intent_id,
      amountCents: order.amount_cents,
      metadata: { orderId: String(order.id), operationType: 'refund_dispute' },
      idempotencyKey: `refund_dispute_order_${order.id}`,
    });
  } else {
    return _ambiguous(order, `${matching.length} matching dispute refunds found — expected 1`, {
      refundIds: matching.map((r) => r.id),
    });
  }

  try {
    await finalizeRefunded(order, stripeRefund, { triggeredBy: 'recovery' });
  } catch (err) {
    if (err instanceof FinalizeConflictError) {
      recordEvent(order.id, 'RECOVERY_REFUNDED', {
        note: 'finalize conflict — order already finalized by concurrent path',
        stripeRefundId: stripeRefund.id,
      });
      return { outcome: 'finalized' };
    }
    throw err;
  }

  recordEvent(order.id, 'RECOVERY_REFUNDED', { stripeRefundId: stripeRefund.id });

  if (order.prior_status === 'DISPUTED') {
    db.prepare(`UPDATE orders SET dispute_resolution = 'refund' WHERE id = ?`).run(order.id);
    recordEvent(order.id, 'DISPUTE_RESOLVED', { action: 'refund', triggeredBy: 'recovery' });
  }

  return { outcome: 'finalized' };
}

// ---------------------------------------------------------------------------
// CANCELLING reconciliation
// ---------------------------------------------------------------------------

async function _reconcileCancelling(order) {
  const refundAmountCents = order.amount_cents - order.platform_fee_cents;

  const refunds = await stripeClient.listRefundsForPaymentIntent(order.stripe_payment_intent_id);
  const matching = refunds.filter(
    (r) =>
      r.metadata &&
      r.metadata.orderId === String(order.id) &&
      r.metadata.operationType === 'cancel' &&
      r.amountCents === refundAmountCents
  );

  let stripeRefund;
  if (matching.length === 1) {
    stripeRefund = matching[0];
  } else if (matching.length === 0) {
    stripeRefund = await stripeClient.createRefund({
      paymentIntentId: order.stripe_payment_intent_id,
      amountCents: refundAmountCents,
      metadata: { orderId: String(order.id), operationType: 'cancel' },
      idempotencyKey: `cancel_order_${order.id}`,
    });
  } else {
    return _ambiguous(order, `${matching.length} matching cancel refunds found — expected 1`, {
      refundIds: matching.map((r) => r.id),
    });
  }

  try {
    await finalizeCancelled(order, stripeRefund, { cancelledBy: 'recovery' });
  } catch (err) {
    if (err instanceof FinalizeConflictError) {
      recordEvent(order.id, 'RECOVERY_CANCELLED', {
        note: 'finalize conflict — order already finalized by concurrent path',
        stripeRefundId: stripeRefund.id,
      });
      return { outcome: 'finalized' };
    }
    throw err;
  }

  recordEvent(order.id, 'RECOVERY_CANCELLED', { stripeRefundId: stripeRefund.id });
  return { outcome: 'finalized' };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _ambiguous(order, reason, extra = {}) {
  recordEvent(order.id, 'RECOVERY_AMBIGUOUS', { reason, ...extra });
  console.warn(`[recovery] order ${order.id} AMBIGUOUS: ${reason}`);
  return { outcome: 'ambiguous', reason };
}

module.exports = { runRecovery };

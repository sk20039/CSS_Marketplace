'use strict';
// Phase 2 stale financial transition recovery.
// All DB calls use async pg queries.

const pool = require('./db');
const { stripeClient } = require('./stripeClient');
const shippoClient = require('./shippoClient');
const {
  FinalizeConflictError,
  finalizeCaptured,
  finalizeReleased,
  finalizeRefunded,
  finalizeCancelled,
  finalizeLabeled,
  revertLabelPurchase,
} = require('./orderService');

const STALE_THRESHOLD_MINUTES = Number(process.env.STALE_THRESHOLD_MINUTES || 10);
const CLAIM_EXPIRY_MINUTES    = STALE_THRESHOLD_MINUTES * 2;

const TRANSIENT_STATUSES = ['CAPTURING', 'RELEASING', 'REFUNDING', 'CANCELLING', 'LABELING'];

let recoveryInProgress = false;

function nowIso() {
  return new Date().toISOString();
}

function ts(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

function normalizeOrder(row) {
  if (!row) return null;
  return {
    ...row,
    transition_started_at: ts(row.transition_started_at),
    recovery_claimed_at:   ts(row.recovery_claimed_at),
    created_at:            ts(row.created_at),
    updated_at:            ts(row.updated_at),
  };
}

async function recordEvent(orderId, eventType, payload) {
  await pool.query(
    `INSERT INTO order_events (order_id, event_type, payload_json, created_at)
     VALUES ($1, $2, $3, $4)`,
    [orderId, eventType, JSON.stringify(payload || {}), nowIso()]
  );
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
  const nowStr        = nowIso();
  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000).toISOString();
  const claimExpiry    = new Date(Date.now() - CLAIM_EXPIRY_MINUTES    * 60 * 1000).toISOString();

  // Build IN ($1,$2,$3,$4) placeholders for the transient statuses.
  const statusPH = TRANSIENT_STATUSES.map((_, i) => `$${i + 1}`).join(',');
  const { rows: rawCandidates } = await pool.query(
    `SELECT * FROM orders
     WHERE status IN (${statusPH})
       AND transition_started_at IS NOT NULL
       AND transition_started_at <= $${TRANSIENT_STATUSES.length + 1}
       AND (recovery_claimed_at IS NULL OR recovery_claimed_at < $${TRANSIENT_STATUSES.length + 2})`,
    [...TRANSIENT_STATUSES, staleThreshold, claimExpiry]
  );
  const candidates = rawCandidates.map(normalizeOrder);

  const recovered = [];
  const failed    = [];
  const ambiguous = [];

  for (const order of candidates) {
    // Atomic claim — only one sweep wins per order.
    const claimed = await pool.query(
      `UPDATE orders
       SET recovery_claimed_at = $1, recovery_attempts = recovery_attempts + 1
       WHERE id = $2
         AND status = $3
         AND (recovery_claimed_at IS NULL OR recovery_claimed_at < $4)`,
      [nowStr, order.id, order.status, claimExpiry]
    );

    if (claimed.rowCount === 0) continue; // another sweep claimed it

    try {
      const result = await _recoverOrder(order);
      await pool.query('UPDATE orders SET last_recovery_error = NULL WHERE id = $1', [order.id]);
      if (result.outcome === 'ambiguous') {
        ambiguous.push({ orderId: order.id, reason: result.reason });
      } else {
        recovered.push(order.id);
      }
    } catch (err) {
      try {
        await pool.query('UPDATE orders SET last_recovery_error = $1 WHERE id = $2', [err.message, order.id]);
        await recordEvent(order.id, 'RECOVERY_FAILED', { error: err.message });
      } catch (_) {}
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
    checkedAt:           nowStr,
    staleThresholdMinutes: STALE_THRESHOLD_MINUTES,
    candidateCount:      candidates.length,
    recoveredOrderIds:   recovered,
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
    case 'LABELING':   return _reconcileLabeling(order);
    default:
      throw new Error(`Unexpected status for recovery: ${order.status}`);
  }
}

// ---------------------------------------------------------------------------
// CAPTURING
// ---------------------------------------------------------------------------

async function _reconcileCapturing(order) {
  const pi = await stripeClient.getPaymentIntent(order.stripe_payment_intent_id);

  if (pi.status === 'succeeded') {
    const stripeCapture = { id: pi.id, status: 'succeeded', chargeId: pi.chargeId };
    try {
      await finalizeCaptured(order, stripeCapture, { triggeredBy: 'recovery' });
    } catch (err) {
      if (err instanceof FinalizeConflictError) {
        await recordEvent(order.id, 'RECOVERY_CAPTURED', {
          note: 'finalize conflict — order already finalized by concurrent path',
          stripePaymentIntentId: pi.id,
        });
        return { outcome: 'finalized' };
      }
      throw err;
    }
    await recordEvent(order.id, 'RECOVERY_CAPTURED', {
      stripePaymentIntentId: pi.id,
      chargeId:              pi.chargeId,
      note:                  'finalized existing Stripe capture',
    });
    return { outcome: 'finalized' };
  }

  if (pi.status === 'requires_capture') {
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
        await recordEvent(order.id, 'RECOVERY_CAPTURED', {
          note: 'finalize conflict — order already finalized by concurrent path',
          stripePaymentIntentId: captured.id,
        });
        return { outcome: 'finalized' };
      }
      throw err;
    }
    await recordEvent(order.id, 'RECOVERY_CAPTURED', {
      stripePaymentIntentId: captured.id,
      chargeId:              captured.chargeId,
      note:                  'issued capture during recovery',
    });
    return { outcome: 'finalized' };
  }

  return _ambiguous(order, `PaymentIntent is in unrecoverable status: ${pi.status}`);
}

// ---------------------------------------------------------------------------
// RELEASING
// ---------------------------------------------------------------------------

async function _reconcileReleasing(order) {
  if (!order.stripe_charge_id) {
    return _ambiguous(order, 'stripe_charge_id missing — cannot look up transfers');
  }

  const { rows: sellerRows } = await pool.query('SELECT * FROM users WHERE id = $1', [order.seller_id]);
  const seller = sellerRows[0];
  if (!seller || !seller.stripe_account_id) {
    return _ambiguous(order, `seller ${order.seller_id} has no connected Stripe account`);
  }

  const transferGroup = `order_${order.id}`;

  const candidates = await stripeClient.listTransfersForRelease({
    transferGroup,
    chargeId:             order.stripe_charge_id,
    destinationAccountId: seller.stripe_account_id,
  });

  const matching = candidates.filter(
    (t) =>
      t.metadata &&
      t.metadata.orderId       === String(order.id) &&
      t.metadata.operationType === 'release' &&
      t.destination            === seller.stripe_account_id &&
      t.sourceTransactionId    === order.stripe_charge_id &&
      t.currency               === 'usd' &&
      t.amountCents            === order.seller_payout_cents
  );

  let stripeTransfer;
  if (matching.length === 1) {
    stripeTransfer = matching[0];
  } else if (matching.length === 0) {
    stripeTransfer = await stripeClient.createTransfer({
      amountCents:         order.seller_payout_cents,
      currency:            'usd',
      destination:         seller.stripe_account_id,
      metadata:            { orderId: String(order.id), operationType: 'release' },
      sourceTransactionId: order.stripe_charge_id,
      transferGroup,
      idempotencyKey:      `release_order_${order.id}`,
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
      await recordEvent(order.id, 'RECOVERY_RELEASED', {
        note: 'finalize conflict — order already finalized by concurrent path',
        stripeTransferId: stripeTransfer.id,
      });
      return { outcome: 'finalized' };
    }
    throw err;
  }

  await recordEvent(order.id, 'RECOVERY_RELEASED', {
    stripeTransferId: stripeTransfer.id,
    note: matching.length === 1 ? 'finalized existing transfer' : 'issued transfer during recovery',
  });

  if (order.prior_status === 'DISPUTED') {
    await pool.query(`UPDATE orders SET dispute_resolution = 'release' WHERE id = $1`, [order.id]);
    await recordEvent(order.id, 'DISPUTE_RESOLVED', { action: 'release', triggeredBy: 'recovery' });
  }

  return { outcome: 'finalized' };
}

// ---------------------------------------------------------------------------
// REFUNDING
// ---------------------------------------------------------------------------

async function _reconcileRefunding(order) {
  const refunds = await stripeClient.listRefundsForPaymentIntent(order.stripe_payment_intent_id);
  const matching = refunds.filter(
    (r) =>
      r.metadata &&
      r.metadata.orderId       === String(order.id) &&
      r.metadata.operationType === 'refund_dispute' &&
      r.amountCents            === order.amount_cents
  );

  let stripeRefund;
  if (matching.length === 1) {
    stripeRefund = matching[0];
  } else if (matching.length === 0) {
    stripeRefund = await stripeClient.createRefund({
      paymentIntentId: order.stripe_payment_intent_id,
      amountCents:     order.amount_cents,
      metadata:        { orderId: String(order.id), operationType: 'refund_dispute' },
      idempotencyKey:  `refund_dispute_order_${order.id}`,
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
      await recordEvent(order.id, 'RECOVERY_REFUNDED', {
        note: 'finalize conflict — order already finalized by concurrent path',
        stripeRefundId: stripeRefund.id,
      });
      return { outcome: 'finalized' };
    }
    throw err;
  }

  await recordEvent(order.id, 'RECOVERY_REFUNDED', { stripeRefundId: stripeRefund.id });

  if (order.prior_status === 'DISPUTED') {
    await pool.query(`UPDATE orders SET dispute_resolution = 'refund' WHERE id = $1`, [order.id]);
    await recordEvent(order.id, 'DISPUTE_RESOLVED', { action: 'refund', triggeredBy: 'recovery' });
  }

  return { outcome: 'finalized' };
}

// ---------------------------------------------------------------------------
// CANCELLING
// ---------------------------------------------------------------------------

async function _reconcileCancelling(order) {
  // ── Label void reconciliation ─────────────────────────────────────────────
  // If a label was purchased but the void outcome was ambiguous (network/5xx),
  // the order landed in CANCELLING with label_voided_at = NULL.
  // We must resolve the void before issuing the Stripe refund:
  //   1. Query Shippo for any existing refund for this label.
  //   2. SUCCESS found → write label_voided_at and continue.
  //   3. ERROR found   → void definitively failed, record event and continue.
  //   4. null          → no refund created → retry void once.
  //      a. Retry succeeds → write label_voided_at and continue.
  //      b. Retry ambiguous → leave in CANCELLING, retry next sweep.
  //      c. Retry definitive → record event and continue.
  //   5. pending       → still processing, retry next sweep.
  if (order.label_id && !order.label_voided_at) {
    let existingVoid;
    try {
      existingVoid = await shippoClient.findRefundByTransaction(order.label_id);
    } catch (queryErr) {
      return _ambiguous(order,
        `Cannot query Shippo refunds for void reconciliation: ${queryErr.message}`);
    }

    if (existingVoid && existingVoid.pending) {
      return _ambiguous(order,
        `Shippo refund for label void is pending (status: ${existingVoid.status})`);
    }

    if (existingVoid && !existingVoid.error) {
      // SUCCESS — a refund was created in Shippo; write void fields and continue.
      await pool.query(
        `UPDATE orders SET label_voided_at = $1, label_void_refund_cents = $2 WHERE id = $3`,
        [nowIso(), existingVoid.refund_cents, order.id]
      );
      await recordEvent(order.id, 'LABEL_VOIDED', {
        voidId:      existingVoid.void_id,
        refundCents: existingVoid.refund_cents,
        triggeredBy: 'recovery',
        labelId:     order.label_id,
      });
    } else if (existingVoid && existingVoid.error) {
      // Shippo refund has ERROR status — void definitively failed.
      await recordEvent(order.id, 'LABEL_VOID_FAILED', {
        error:       'Shippo refund status ERROR',
        definitive:  true,
        triggeredBy: 'recovery',
        labelId:     order.label_id,
      });
      // Continue to Stripe refund — the label cost is a platform loss.
    } else {
      // null — no existing Shippo refund found.  Positive confirmation that the
      // original void never reached Shippo, so we can safely retry once.
      try {
        const voidResult = await shippoClient.voidLabel(order.label_id);
        await pool.query(
          `UPDATE orders SET label_voided_at = $1, label_void_refund_cents = $2 WHERE id = $3`,
          [nowIso(), voidResult.refund_cents, order.id]
        );
        await recordEvent(order.id, 'LABEL_VOIDED', {
          voidId:      voidResult.void_id,
          refundCents: voidResult.refund_cents,
          triggeredBy: 'recovery',
          labelId:     order.label_id,
        });
      } catch (voidErr) {
        if (!voidErr.definitive) {
          // Still ambiguous — leave in CANCELLING for next sweep.
          return _ambiguous(order,
            `Void retry in recovery returned ambiguous error: ${voidErr.message}`);
        }
        // Definitive failure on retry — record and continue to Stripe refund.
        await recordEvent(order.id, 'LABEL_VOID_FAILED', {
          error:       voidErr.message,
          definitive:  true,
          triggeredBy: 'recovery',
          labelId:     order.label_id,
        });
      }
    }
  }

  // ── Stripe refund reconciliation ─────────────────────────────────────────
  // seller_late: full refund; buyer_change_of_mind or null: partial refund
  const refundAmountCents = order.cancellation_cause === 'seller_late'
    ? order.amount_cents
    : order.amount_cents - order.platform_fee_cents;

  const refunds = await stripeClient.listRefundsForPaymentIntent(order.stripe_payment_intent_id);
  const matching = refunds.filter(
    (r) =>
      r.metadata &&
      r.metadata.orderId       === String(order.id) &&
      r.metadata.operationType === 'cancel' &&
      r.amountCents            === refundAmountCents
  );

  let stripeRefund;
  if (matching.length === 1) {
    stripeRefund = matching[0];
  } else if (matching.length === 0) {
    stripeRefund = await stripeClient.createRefund({
      paymentIntentId: order.stripe_payment_intent_id,
      amountCents:     refundAmountCents,
      metadata:        { orderId: String(order.id), operationType: 'cancel' },
      idempotencyKey:  `cancel_order_${order.id}`,
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
      await recordEvent(order.id, 'RECOVERY_CANCELLED', {
        note: 'finalize conflict — order already finalized by concurrent path',
        stripeRefundId: stripeRefund.id,
      });
      return { outcome: 'finalized' };
    }
    throw err;
  }

  await recordEvent(order.id, 'RECOVERY_CANCELLED', { stripeRefundId: stripeRefund.id });
  return { outcome: 'finalized' };
}

// ---------------------------------------------------------------------------
// LABELING
// ---------------------------------------------------------------------------
//
// An order stuck in LABELING means either:
//   (a) The Shippo call succeeded but the process crashed before finalizeLabeled
//       wrote to the DB — we must find and finalize that transaction.
//   (b) The Shippo call was in-flight when the network dropped — we query Shippo
//       to determine whether a transaction was created.
//
// Idempotency: the recovery_claimed_at atomic claim in _sweep() ensures only one
// worker reaches this function per order.  finalizeLabeled()'s WHERE status='LABELING'
// guard provides a second layer in case of clock skew between claim expiry and a
// concurrent sweep.

async function _reconcileLabeling(order) {
  // Query Shippo for any transaction created for this rate and order.
  let shippoResult;
  try {
    shippoResult = await shippoClient.findTransactionByRate(order.shippo_rate_id, order.id);
  } catch (queryErr) {
    // Cannot reach Shippo — outcome unknown, retry next sweep.
    return _ambiguous(order, `Cannot query Shippo to verify label purchase: ${queryErr.message}`);
  }

  // null → positive confirmation no transaction was created → safe to revert.
  if (shippoResult === null) {
    await revertLabelPurchase(order.id, {
      reason: 'Shippo returned no transaction for this rate — label was never created',
    });
    await recordEvent(order.id, 'RECOVERY_LABEL_REVERTED', {
      reason: 'no Shippo transaction found', rateId: order.shippo_rate_id,
    });
    return { outcome: 'finalized' };
  }

  // error → Shippo created a transaction record but the label failed → revert.
  if (shippoResult.error) {
    await revertLabelPurchase(order.id, {
      reason: 'Shippo transaction has ERROR status — label purchase definitively failed',
    });
    await recordEvent(order.id, 'RECOVERY_LABEL_REVERTED', {
      reason: 'Shippo transaction status ERROR', rateId: order.shippo_rate_id,
    });
    return { outcome: 'finalized' };
  }

  // pending → QUEUED/WAITING (should not occur with async:false; leave in LABELING).
  if (shippoResult.pending) {
    return _ambiguous(
      order,
      `Shippo transaction is still pending (status: ${shippoResult.status}) — will retry`
    );
  }

  // SUCCESS → finalize using the found transaction.
  try {
    await finalizeLabeled(order, shippoResult);
  } catch (err) {
    if (err instanceof FinalizeConflictError) {
      await recordEvent(order.id, 'RECOVERY_LABEL_FINALIZE_CONFLICT', {
        note: 'finalize conflict — order already finalized by concurrent path',
        labelId: shippoResult.label_id,
      });
      return { outcome: 'finalized' };
    }
    throw err;
  }

  await recordEvent(order.id, 'RECOVERY_LABEL_PURCHASED', {
    labelId:        shippoResult.label_id,
    trackingNumber: shippoResult.tracking_number,
    note:           'finalized existing Shippo transaction during recovery',
  });

  return { outcome: 'finalized' };
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function _ambiguous(order, reason, extra = {}) {
  await recordEvent(order.id, 'RECOVERY_AMBIGUOUS', { reason, ...extra });
  console.warn(`[recovery] order ${order.id} AMBIGUOUS: ${reason}`);
  return { outcome: 'ambiguous', reason };
}

module.exports = { runRecovery };

'use strict';

// Phase 3: Shipping label purchase — DB schema changes.
//
// Adds the LABELING transient status to the orders status constraint.
// LABELING plays the same role as CAPTURING/RELEASING/REFUNDING/CANCELLING:
// it is an atomic database lock that prevents two concurrent requests from
// both calling Shippo's POST /transactions for the same order.
//
// State machine addition:
//   HELD → LABELING → HELD (with label fields populated)
//               └──→ HELD (revert on definitive Shippo failure)
//   Ambiguous outcome (network error / 5xx): stay in LABELING until recovery.
//
// Recovery index updated to include LABELING so the stale-transition sweep
// in recoveryService.js picks up crash-stuck label purchases.

exports.up = (pgm) => {
  pgm.sql(`

    -- ── orders: add LABELING to the status constraint ─────────────────────
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
    ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN (
      'CREATED','CAPTURING','HELD','LABELING','SHIPPED','DELIVERED','DISPUTED',
      'RELEASING','REFUNDING','RELEASED','REFUNDED','CANCELLING','CANCELLED'
    ));

    -- ── orders: rebuild recovery index to include LABELING ─────────────────
    -- PostgreSQL partial indexes cannot be modified in-place; must drop and
    -- recreate.  The index is non-unique and rebuilding it is safe with zero
    -- data loss or down-time risk.
    DROP INDEX IF EXISTS idx_orders_recovery;
    CREATE INDEX idx_orders_recovery
      ON orders(transition_started_at)
      WHERE status IN ('CAPTURING','RELEASING','REFUNDING','CANCELLING','LABELING');

  `);
};

exports.down = (pgm) => {
  pgm.sql(`

    -- Remove LABELING from status constraint (revert to Phase 2 set).
    -- Note: any rows currently in LABELING status will violate the restored
    -- constraint.  Ensure no orders are in LABELING before running down.
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
    ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN (
      'CREATED','CAPTURING','HELD','SHIPPED','DELIVERED','DISPUTED',
      'RELEASING','REFUNDING','RELEASED','REFUNDED','CANCELLING','CANCELLED'
    ));

    -- Restore recovery index without LABELING.
    DROP INDEX IF EXISTS idx_orders_recovery;
    CREATE INDEX idx_orders_recovery
      ON orders(transition_started_at)
      WHERE status IN ('CAPTURING','RELEASING','REFUNDING','CANCELLING');

  `);
};

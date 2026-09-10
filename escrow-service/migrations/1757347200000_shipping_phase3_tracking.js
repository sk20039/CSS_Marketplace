'use strict';

// Phase 3 (tracking): Shippo webhook-driven tracking status fields.
//
// Adds the two columns required for forward-only idempotent tracking state:
//
//   tracking_status        — mirrors Shippo's normalised status string:
//                            UNKNOWN | PRE_TRANSIT | TRANSIT | DELIVERED |
//                            RETURNED | FAILURE
//                            Written by the POST /webhooks/shippo handler.
//
//   last_tracking_event_at — the carrier-recorded status_date from the most
//                            recent Shippo tracking event we processed.
//                            Used as the idempotency fence: an incoming event
//                            whose status_date is <= this value is stale and
//                            must never overwrite the stored tracking_status
//                            or regress the order state machine.
//
// No status constraint changes — tracking webhooks drive HELD→SHIPPED and
// SHIPPED→DELIVERED using the existing state machine guards.

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_status        TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_tracking_event_at TIMESTAMPTZ;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE orders DROP COLUMN IF EXISTS tracking_status;
    ALTER TABLE orders DROP COLUMN IF EXISTS last_tracking_event_at;
  `);
};

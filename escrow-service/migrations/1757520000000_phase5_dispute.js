'use strict';

// Phase 5 (disputes): adds dispute_admin_notes column for admin resolution rationale.
//
// Allows admins to record their reasoning when resolving a dispute.
// The text is included in the DISPUTE_RESOLVED audit event and is visible
// only to admins (not returned to buyer or seller via the public order endpoint).

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_admin_notes TEXT;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE orders DROP COLUMN IF EXISTS dispute_admin_notes;
  `);
};

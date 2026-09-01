'use strict';

// Phase 1: Shipping system DB schema additions — auth-service.
// Adds the seller ship-from address to the users table.
//
// Security requirements:
//   • ship_from_address is the authoritative source in auth-service.
//   • It is synced to escrow-service's users mirror via /api/sync/user and
//     used only internally for Shippo label generation.
//   • It must NEVER appear in public API responses (listings, order details,
//     user reviews, etc.).
//   • It is only returned to the authenticated seller querying their own
//     profile (/auth/me), and only with explicit field selection.
//
// Format: { name, company?, line1, line2?, city, state, zip, phone }

exports.up = (pgm) => {
  pgm.sql(`

    ALTER TABLE users ADD COLUMN IF NOT EXISTS ship_from_address JSONB;

  `);
};

exports.down = (pgm) => {
  pgm.sql(`

    ALTER TABLE users DROP COLUMN IF EXISTS ship_from_address;

  `);
};

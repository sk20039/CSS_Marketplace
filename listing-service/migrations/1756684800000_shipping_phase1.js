'use strict';

// Phase 1: Shipping system DB schema additions — listing-service.
// Adds package dimension and weight columns to listings.  These are used by
// the escrow-service when calling Shippo to get carrier rates at checkout and
// to purchase prepaid labels.
//
// All columns are nullable.  Category-based defaults are applied in
// application code (Phase 4), not in the DB, so sellers can override them.

exports.up = (pgm) => {
  pgm.sql(`

    -- weight_oz: gross package weight in ounces, including typical packaging.
    --   Used by Shippo for rate calculation.  Category defaults (Phase 4):
    --     bat=64, helmet=48, pads=40, gloves=16, kit-bag=96, other=16
    ALTER TABLE listings ADD COLUMN IF NOT EXISTS weight_oz INTEGER;

    -- pkg_length_in / pkg_width_in / pkg_height_in: outer package dimensions
    --   in inches.  Used by Shippo for dimensional weight calculation.
    ALTER TABLE listings ADD COLUMN IF NOT EXISTS pkg_length_in NUMERIC(5,1);
    ALTER TABLE listings ADD COLUMN IF NOT EXISTS pkg_width_in  NUMERIC(5,1);
    ALTER TABLE listings ADD COLUMN IF NOT EXISTS pkg_height_in NUMERIC(5,1);

  `);
};

exports.down = (pgm) => {
  pgm.sql(`

    ALTER TABLE listings DROP COLUMN IF EXISTS weight_oz;
    ALTER TABLE listings DROP COLUMN IF EXISTS pkg_length_in;
    ALTER TABLE listings DROP COLUMN IF EXISTS pkg_width_in;
    ALTER TABLE listings DROP COLUMN IF EXISTS pkg_height_in;

  `);
};

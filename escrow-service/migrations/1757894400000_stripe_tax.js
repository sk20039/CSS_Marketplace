'use strict';

// Stripe Tax integration.
// Adds four columns to orders:
//   tax_cents               — tax calculated by Stripe Tax (exclusive of item+shipping).
//                             DEFAULT 0 so all existing rows remain valid without backfill.
//   tax_calculation_id      — Stripe Tax Calculation ID (txc_...) stored at order creation.
//                             NULL on pre-feature rows; skips finalization logic safely.
//   stripe_tax_transaction_id — Stripe Tax Transaction ID (tax_tran_...) written after
//                             capture succeeds and the calculation is finalized.
//                             NULL = finalization pending/failed; recovered by sweep.
//   stripe_tax_reversal_id  — Stripe Tax reversal Transaction ID written after a
//                             refund or cancellation finalizes.
//                             NULL = reversal pending/failed; recovered by sweep.

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_cents               INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_calculation_id      TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_tax_transaction_id TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_tax_reversal_id  TEXT;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE orders DROP COLUMN IF EXISTS stripe_tax_reversal_id;
    ALTER TABLE orders DROP COLUMN IF EXISTS stripe_tax_transaction_id;
    ALTER TABLE orders DROP COLUMN IF EXISTS tax_calculation_id;
    ALTER TABLE orders DROP COLUMN IF EXISTS tax_cents;
  `);
};

'use strict';

// Platform-wide "first 10 completed sales are fee-free" launch offer.
//
// platform_settings — generic key/value store for platform-wide counters.
//   completed_sales_count tracks how many orders have reached RELEASED status
//   and had their fee waived.  Capped at 10 by the application layer.
//
// orders.launch_fee_waiver — boolean flag set when a specific order's platform
//   fee was waived under this offer.  Allows seller-facing UI to show
//   "Fee: $0 (launch offer)" rather than a confusing $0 with no explanation.

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS platform_settings (
      key        TEXT PRIMARY KEY,
      value_int  BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    INSERT INTO platform_settings (key, value_int)
    VALUES ('completed_sales_count', 0)
    ON CONFLICT (key) DO NOTHING;

    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS launch_fee_waiver BOOLEAN NOT NULL DEFAULT FALSE;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE orders DROP COLUMN IF EXISTS launch_fee_waiver;
    DROP TABLE IF EXISTS platform_settings;
  `);
};

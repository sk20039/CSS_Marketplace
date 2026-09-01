'use strict';

// Phase 1: Shipping system DB schema additions.
// Adds all columns required for the shipping feature to the orders and users
// tables.  No business-logic changes — all new columns are nullable or have
// safe defaults so existing code continues to function without modification.
//
// Key design decisions reflected here:
//   • item_price_cents  — merchandise price only (fee basis)
//   • shipping_cents    — carrier charge collected from buyer (pass-through)
//   • amount_cents remains = item_price_cents + shipping_cents (existing column)
//   • seller_payout_cents = item_price_cents - platform_fee_cents (no shipping)
//   • cancellation_cause — server-controlled enum; drives refund calculation,
//       never supplied by the client.
//   • ship_from_address on users — seller's origin address for Shippo label
//       generation; never exposed in public API responses.

exports.up = (pgm) => {
  pgm.sql(`

    -- ── orders: price decomposition ──────────────────────────────────────────
    -- item_price_cents: merchandise price at time of order.
    --   Nullable initially; backfilled from amount_cents for existing rows.
    --   Phase 2 will enforce NOT NULL once createOrder() provides it.
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS item_price_cents INTEGER;
    UPDATE orders SET item_price_cents = amount_cents WHERE item_price_cents IS NULL;

    -- shipping_cents: carrier charge collected from buyer.
    --   Default 0 so existing orders (merchandise-only) are correct.
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_cents INTEGER NOT NULL DEFAULT 0;

    -- ── orders: Shippo / label fields ────────────────────────────────────────
    -- shippo_rate_id: the exact Shippo Rate object_id selected by the buyer at
    --   checkout.  Valid for 7 days per Shippo API.  Used to purchase the
    --   label immediately upon payment capture.
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS shippo_rate_id TEXT;

    -- label_id: Shippo Transaction object_id returned after label purchase.
    --   Used to retrieve/void the label.
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS label_id TEXT;

    -- label_url: presigned PDF URL for seller to download and print.
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS label_url TEXT;

    -- label_cost_cents: actual amount Shippo charged.
    --   Should equal shipping_cents when rate is locked at checkout; may differ
    --   if a rate-expired fallback re-quote is used (Cricket Market absorbs delta).
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS label_cost_cents INTEGER;

    -- tracking_number / carrier / carrier_service: written at label purchase.
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS carrier TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS carrier_service TEXT;

    -- label_voided_at: set when a void request is sent to Shippo.
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS label_voided_at TIMESTAMPTZ;

    -- label_void_refund_cents: actual postage refund received from Shippo void.
    --   May arrive 3-7 days after void request; tracked for reconciliation.
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS label_void_refund_cents INTEGER;

    -- ── orders: shipping logistics ───────────────────────────────────────────
    -- shipping_address: buyer ship-to address, order-scoped.
    --   { name, line1, line2?, city, state, zip, phone? }
    --   Never exposed in public API responses; used only for label generation.
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_address JSONB;

    -- ship_by_date: calculated at order capture as 3 business days from HELD.
    --   Cron sweep notifies seller and enables buyer cancel after this date
    --   if no carrier acceptance scan has been received.
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS ship_by_date TIMESTAMPTZ;

    -- ── orders: cancellation cause (server-controlled) ───────────────────────
    -- Drives the refund amount calculation.  Set only by server code, never by
    -- client input.
    --   buyer_change_of_mind : refund = amount_cents - platform_fee_cents
    --   seller_late          : refund = amount_cents (full; fee not retained)
    --   admin                : refund determined by admin action
    --   recovery             : set by recovery service sweep
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_cause TEXT;
    ALTER TABLE orders ADD CONSTRAINT orders_cancellation_cause_check
      CHECK (cancellation_cause IS NULL
          OR cancellation_cause IN
             ('buyer_change_of_mind','seller_late','admin','recovery'));

    -- ── orders: insurance placeholder (v1: always false/0) ───────────────────
    -- Columns are present so the schema is ready for a future phase.
    -- insurance_cents is included in amount_cents when > 0; it is NOT part of
    -- the fee base (fee applies to item_price_cents only).
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS insurance_requested BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS insurance_cents INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS insurance_value_cents INTEGER;

    -- ── users: seller ship-from address ──────────────────────────────────────
    -- { name, company?, line1, line2?, city, state, zip, phone }
    -- Synced from auth-service via /api/sync/user.
    -- Read by escrow-service internally at label generation time.
    -- Never serialized into GET /orders/:id or any public response.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS ship_from_address JSONB;

  `);
};

exports.down = (pgm) => {
  pgm.sql(`

    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_cancellation_cause_check;
    ALTER TABLE orders DROP COLUMN IF EXISTS item_price_cents;
    ALTER TABLE orders DROP COLUMN IF EXISTS shipping_cents;
    ALTER TABLE orders DROP COLUMN IF EXISTS shippo_rate_id;
    ALTER TABLE orders DROP COLUMN IF EXISTS label_id;
    ALTER TABLE orders DROP COLUMN IF EXISTS label_url;
    ALTER TABLE orders DROP COLUMN IF EXISTS label_cost_cents;
    ALTER TABLE orders DROP COLUMN IF EXISTS tracking_number;
    ALTER TABLE orders DROP COLUMN IF EXISTS carrier;
    ALTER TABLE orders DROP COLUMN IF EXISTS carrier_service;
    ALTER TABLE orders DROP COLUMN IF EXISTS label_voided_at;
    ALTER TABLE orders DROP COLUMN IF EXISTS label_void_refund_cents;
    ALTER TABLE orders DROP COLUMN IF EXISTS shipping_address;
    ALTER TABLE orders DROP COLUMN IF EXISTS ship_by_date;
    ALTER TABLE orders DROP COLUMN IF EXISTS cancellation_cause;
    ALTER TABLE orders DROP COLUMN IF EXISTS insurance_requested;
    ALTER TABLE orders DROP COLUMN IF EXISTS insurance_cents;
    ALTER TABLE orders DROP COLUMN IF EXISTS insurance_value_cents;
    ALTER TABLE users DROP COLUMN IF EXISTS ship_from_address;

  `);
};

'use strict';

// Prevent two orders for the same listing from both capturing payment.
//
// Root cause: reserveTransition was per-order only. Two separate orders for the
// same listing each had their own row, so both could pass CREATED→CAPTURING
// independently and both Stripe captures would succeed.
//
// Fix: a unique partial index on listing_id that covers every "in-flight" state.
// The index excludes CREATED (buyers may browse-create before paying) and the
// three terminal states (CANCELLED, REFUNDED, RELEASED) so that a failed or
// completed sale never blocks future orders for the same listing.
//
// When the second captureOrder call runs its UPDATE orders SET status='CAPTURING'
// WHERE id=$N AND status='CREATED', PostgreSQL raises 23505. reserveTransition
// now catches 23505 and returns false, which causes captureOrder to throw 409
// — identical to any other concurrent-reservation conflict.

exports.up = (pgm) => {
  pgm.sql(`
    CREATE UNIQUE INDEX one_active_order_per_listing
      ON orders (listing_id)
      WHERE status NOT IN ('CREATED', 'CANCELLED', 'REFUNDED', 'RELEASED');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS one_active_order_per_listing;
  `);
};

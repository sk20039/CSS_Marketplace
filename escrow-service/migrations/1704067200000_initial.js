'use strict';

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS users (
      id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name              TEXT   NOT NULL,
      email             TEXT   NOT NULL UNIQUE,
      role              TEXT   NOT NULL DEFAULT 'buyer',
      stripe_account_id TEXT,
      CONSTRAINT users_role_check CHECK (role IN ('buyer','seller','admin'))
    );

    CREATE TABLE IF NOT EXISTS listings (
      id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      seller_id   BIGINT  NOT NULL REFERENCES users(id),
      title       TEXT    NOT NULL,
      price_cents INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_listings_seller ON listings(seller_id);

    CREATE TABLE IF NOT EXISTS orders (
      id                       BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      listing_id               BIGINT      NOT NULL REFERENCES listings(id),
      buyer_id                 BIGINT      NOT NULL REFERENCES users(id),
      seller_id                BIGINT      NOT NULL REFERENCES users(id),
      amount_cents             INTEGER     NOT NULL,
      platform_fee_cents       INTEGER     NOT NULL,
      seller_payout_cents      INTEGER     NOT NULL,
      status                   TEXT        NOT NULL,
      stripe_payment_intent_id TEXT,
      stripe_charge_id         TEXT,
      stripe_client_secret     TEXT,
      stripe_transfer_id       TEXT,
      stripe_refund_id         TEXT,
      shipped_at               TIMESTAMPTZ,
      delivered_at             TIMESTAMPTZ,
      window_expires_at        TIMESTAMPTZ,
      dispute_reason_text      TEXT,
      dispute_category         TEXT,
      dispute_resolution       TEXT,
      cancellation_reason      TEXT,
      prior_status             TEXT,
      transition_started_at    TIMESTAMPTZ,
      recovery_claimed_at      TIMESTAMPTZ,
      recovery_attempts        INTEGER     NOT NULL DEFAULT 0,
      last_recovery_error      TEXT,
      created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT orders_status_check CHECK (status IN (
        'CREATED','CAPTURING','HELD','SHIPPED','DELIVERED','DISPUTED',
        'RELEASING','REFUNDING','RELEASED','REFUNDED','CANCELLING','CANCELLED'
      )),
      CONSTRAINT orders_dispute_category_check
        CHECK (dispute_category IN ('valid','invalid','uncategorized')),
      CONSTRAINT orders_dispute_resolution_check
        CHECK (dispute_resolution IN ('release','refund'))
    );
    CREATE INDEX IF NOT EXISTS idx_orders_buyer    ON orders(buyer_id);
    CREATE INDEX IF NOT EXISTS idx_orders_seller   ON orders(seller_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status   ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_window
      ON orders(window_expires_at) WHERE status = 'DELIVERED';
    CREATE INDEX IF NOT EXISTS idx_orders_recovery
      ON orders(transition_started_at)
      WHERE status IN ('CAPTURING','RELEASING','REFUNDING','CANCELLING');

    CREATE TABLE IF NOT EXISTS order_events (
      id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      order_id     BIGINT      NOT NULL REFERENCES orders(id),
      event_type   TEXT        NOT NULL,
      payload_json TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id);

    CREATE TABLE IF NOT EXISTS messages (
      id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      order_id   BIGINT      NOT NULL REFERENCES orders(id),
      sender_id  BIGINT      NOT NULL REFERENCES users(id),
      body       TEXT        NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_messages_order ON messages(order_id);

    CREATE TABLE IF NOT EXISTS reviews (
      id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      order_id    BIGINT      NOT NULL REFERENCES orders(id),
      reviewer_id BIGINT      NOT NULL REFERENCES users(id),
      reviewee_id BIGINT      NOT NULL REFERENCES users(id),
      rating      INTEGER     NOT NULL,
      body        TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT reviews_unique      UNIQUE (order_id, reviewer_id),
      CONSTRAINT reviews_rating_check CHECK (rating BETWEEN 1 AND 5)
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_reviewee ON reviews(reviewee_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS reviews;
    DROP TABLE IF EXISTS messages;
    DROP TABLE IF EXISTS order_events;
    DROP TABLE IF EXISTS orders;
    DROP TABLE IF EXISTS listings;
    DROP TABLE IF EXISTS users;
  `);
};

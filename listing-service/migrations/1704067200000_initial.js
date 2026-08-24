'use strict';

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE listings (
      id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      seller_id      BIGINT  NOT NULL,
      title          TEXT    NOT NULL,
      description    TEXT    NOT NULL DEFAULT '',
      price_cents    INTEGER NOT NULL,
      category       TEXT    NOT NULL DEFAULT 'other',
      condition      TEXT    NOT NULL DEFAULT 'used_good',
      status         TEXT    NOT NULL DEFAULT 'active',
      meta_title     TEXT,
      meta_description TEXT,
      tags           TEXT,
      quality_score  INTEGER,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT listings_category_check
        CHECK (category IN ('bat','helmet','pads','gloves','kit-bag','other')),
      CONSTRAINT listings_condition_check
        CHECK (condition IN ('new','used_good','used_fair')),
      CONSTRAINT listings_status_check
        CHECK (status IN ('active','sold','inactive'))
    );

    CREATE INDEX idx_listings_status ON listings(status);
    CREATE INDEX idx_listings_seller ON listings(seller_id);

    CREATE TABLE listing_photos (
      id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      listing_id    BIGINT  NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      filename      TEXT    NOT NULL,
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS listing_photos;
    DROP TABLE IF EXISTS listings;
  `);
};

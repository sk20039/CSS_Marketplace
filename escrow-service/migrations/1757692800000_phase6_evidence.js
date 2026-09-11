'use strict';

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS dispute_evidence (
      id                BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      order_id          BIGINT      NOT NULL REFERENCES orders(id),
      uploader_user_id  BIGINT      NOT NULL REFERENCES users(id),
      uploader_role     TEXT        NOT NULL,
      storage_key       TEXT        NOT NULL UNIQUE,
      original_filename TEXT        NOT NULL,
      mime_type         TEXT        NOT NULL,
      file_size_bytes   INTEGER     NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT de_uploader_role_check CHECK (uploader_role IN ('buyer','seller'))
    );
    CREATE INDEX IF NOT EXISTS idx_de_order ON dispute_evidence(order_id);

    CREATE TABLE IF NOT EXISTS dispute_responses (
      id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      order_id    BIGINT      NOT NULL REFERENCES orders(id) UNIQUE,
      seller_id   BIGINT      NOT NULL REFERENCES users(id),
      body        TEXT        NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS dispute_responses;
    DROP TABLE IF EXISTS dispute_evidence;
  `);
};

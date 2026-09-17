'use strict';

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS mfa_enabled     BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS mfa_totp_secret TEXT;

    CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
      id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash  TEXT        NOT NULL,
      used_at    TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_mfa_recovery_codes_user ON mfa_recovery_codes(user_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS mfa_recovery_codes;
    ALTER TABLE users
      DROP COLUMN IF EXISTS mfa_totp_secret,
      DROP COLUMN IF EXISTS mfa_enabled;
  `);
};

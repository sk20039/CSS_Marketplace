'use strict';
// Migration: add token_sha256 indexed column to refresh_tokens.
//
// Purpose: replace the O(n*bcrypt) full-table scan in findAndDeleteRefreshToken
// with an O(1) indexed lookup.  The lookup now uses SHA-256(raw_token) as the
// fast lookup key; bcrypt verification of that single row is retained for
// breach-resistance.
//
// Existing tokens cannot be backfilled (we do not possess the raw random
// bytes any more — only the stored bcrypt hashes).  All existing staging
// sessions are invalidated by this migration: users simply log in again.

exports.up = (pgm) => {
  pgm.sql(`
    -- Remove all existing refresh tokens — they have no token_sha256 value
    -- and cannot be backfilled without the original raw bytes.
    DELETE FROM refresh_tokens;

    -- Add the fast-lookup column (NOT NULL enforced after the truncation above).
    ALTER TABLE refresh_tokens
      ADD COLUMN token_sha256 TEXT NOT NULL DEFAULT '';

    -- Remove the temporary default; new inserts must supply the value explicitly.
    ALTER TABLE refresh_tokens
      ALTER COLUMN token_sha256 DROP DEFAULT;

    -- Unique constraint + index for O(1) point lookup.
    ALTER TABLE refresh_tokens
      ADD CONSTRAINT refresh_tokens_sha256_unique UNIQUE (token_sha256);

    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_sha256
      ON refresh_tokens(token_sha256);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_refresh_tokens_sha256;
    ALTER TABLE refresh_tokens DROP CONSTRAINT IF EXISTS refresh_tokens_sha256_unique;
    ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS token_sha256;
  `);
};

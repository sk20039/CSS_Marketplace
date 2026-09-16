'use strict';

// Migration: enforce case-insensitive email uniqueness at the database level.
//
// Before this migration:
//   users_email_key — UNIQUE btree (email)          [case-sensitive; dropped]
//   idx_users_email — plain  btree (email)          [lookup index; kept]
//
// After this migration:
//   users_email_lower_key — UNIQUE btree (LOWER(email))  [case-insensitive]
//   idx_users_email       — plain  btree (email)         [fast WHERE email=$1]
//
// The application layer already normalises input via .trim().toLowerCase()
// (commit d141f99).  This migration adds the complementary DB-level guard so
// that a case-variant duplicate (e.g. User@Example.com vs user@example.com)
// cannot be inserted even if application normalisation is bypassed.
//
// Pre-flight checks confirmed before this migration was created:
//   • All existing stored emails are already lowercase — zero conflicts.
//   • No case-insensitive duplicate pairs exist in staging or production.

exports.up = (pgm) => {
  pgm.sql(`
    -- Drop the case-sensitive unique constraint (also drops its backing index).
    -- Confirmed exact name from pg_indexes: users_email_key
    ALTER TABLE users DROP CONSTRAINT users_email_key;

    -- Add case-insensitive uniqueness enforcement.
    -- idx_users_email (plain btree) is intentionally kept for fast
    -- WHERE email = $1 lookups (app always passes a normalised lowercase value).
    CREATE UNIQUE INDEX users_email_lower_key ON users (LOWER(email));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS users_email_lower_key;

    -- Restore the original case-sensitive unique constraint.
    ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email);
  `);
};

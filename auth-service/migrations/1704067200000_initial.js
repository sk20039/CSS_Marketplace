'use strict';

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE users (
      id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name              TEXT        NOT NULL,
      email             TEXT        NOT NULL UNIQUE,
      password_hash     TEXT        NOT NULL,
      role              TEXT        NOT NULL DEFAULT 'buyer',
      stripe_account_id TEXT,
      email_verified    BOOLEAN     NOT NULL DEFAULT false,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT users_role_check CHECK (role IN ('buyer','seller','admin'))
    );

    CREATE INDEX idx_users_email ON users(email);

    CREATE TABLE refresh_tokens (
      id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash  TEXT        NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
    CREATE INDEX idx_refresh_tokens_expires ON refresh_tokens(expires_at);

    CREATE TABLE email_verification_tokens (
      id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash  TEXT        NOT NULL UNIQUE,
      expires_at  TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_verification_tokens_user ON email_verification_tokens(user_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS email_verification_tokens;
    DROP TABLE IF EXISTS refresh_tokens;
    DROP TABLE IF EXISTS users;
  `);
};

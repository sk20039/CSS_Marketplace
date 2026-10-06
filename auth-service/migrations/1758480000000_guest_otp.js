// Make password_hash nullable (passwordless buyers have no password).
// Add otp_codes for HMAC-protected, single-use verification codes.
// Add otp_rate_limits for DB-backed per-key rate limiting (shared across instances).

exports.up = (pgm) => {
  pgm.sql(`
    -- Allow accounts without a password (passwordless buyers)
    ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

    -- OTP verification codes
    CREATE TABLE otp_codes (
      id          BIGSERIAL PRIMARY KEY,
      email       TEXT NOT NULL,
      code_hmac   TEXT NOT NULL,          -- HMAC-SHA256(secret, "email:code") hex
      user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      used_at     TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX otp_codes_email_idx ON otp_codes (email);
    CREATE INDEX otp_codes_expires_idx ON otp_codes (expires_at);

    -- DB-based rate limits (replaces per-process memory; safe for multi-instance)
    CREATE TABLE otp_rate_limits (
      key         TEXT PRIMARY KEY,       -- "req:email" or "ver:email"
      count       INT NOT NULL DEFAULT 1,
      window_end  TIMESTAMPTZ NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS otp_rate_limits;
    DROP TABLE IF EXISTS otp_codes;
    ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL;
  `);
};

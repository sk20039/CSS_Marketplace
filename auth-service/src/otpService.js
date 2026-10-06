/**
 * otpService.js — passwordless OTP generation, signing, rate-limiting, and consumption.
 *
 * Security properties:
 *  - Codes are 6-digit random (not sequential); HMAC-SHA256 signed with OTP_HMAC_SECRET
 *    so a stolen DB row cannot be replayed without the server secret.
 *  - Atomic consumption via FOR UPDATE SKIP LOCKED CTE prevents concurrent reuse.
 *  - Rate limits stored in Postgres (shared across service instances).
 *  - Timing-safe comparison via crypto.timingSafeEqual.
 */

const crypto = require('crypto');
const pool   = require('./db');

const OTP_TTL_MS      = 15 * 60 * 1000;  // 15 minutes
const REQ_WINDOW_MS   = 15 * 60 * 1000;  // request limit window
const REQ_MAX         = 5;               // max OTP requests per email per window
const VER_WINDOW_MS   = 15 * 60 * 1000;  // verify limit window
const VER_MAX         = 10;              // max verify attempts per email per window

// ── Helpers ──────────────────────────────────────────────────────────────────

function hmacSecret() {
  return process.env.OTP_HMAC_SECRET || 'dev-otp-secret-change-in-production';
}

function generateCode() {
  // 6 digits, zero-padded, uniform distribution via rejection sampling
  let n;
  do { n = crypto.randomInt(0, 1_000_000); } while (n >= 1_000_000);
  return String(n).padStart(6, '0');
}

function signCode(email, code) {
  const key = Buffer.from(hmacSecret(), 'utf8');
  return crypto.createHmac('sha256', key)
    .update(`${email.toLowerCase().trim()}:${code}`)
    .digest('hex');
}

function codesMatch(storedHex, email, code) {
  const expected = Buffer.from(signCode(email, code), 'hex');
  const stored   = Buffer.from(storedHex, 'hex');
  if (expected.length !== stored.length) return false;
  return crypto.timingSafeEqual(expected, stored);
}

// ── Rate limiting (DB-backed) ─────────────────────────────────────────────────

/**
 * Increment and check a rate-limit counter.
 * Returns { allowed: boolean, remaining: number }.
 */
async function checkRateLimit(prefix, email, windowMs, max) {
  const key = `${prefix}:${email.toLowerCase().trim()}`;
  const windowInterval = `${windowMs} milliseconds`;

  const { rows } = await pool.query(
    `INSERT INTO otp_rate_limits (key, count, window_end, updated_at)
     VALUES ($1, 1, NOW() + $2::interval, NOW())
     ON CONFLICT (key) DO UPDATE SET
       count      = CASE WHEN otp_rate_limits.window_end < NOW()
                         THEN 1
                         ELSE otp_rate_limits.count + 1 END,
       window_end = CASE WHEN otp_rate_limits.window_end < NOW()
                         THEN NOW() + $2::interval
                         ELSE otp_rate_limits.window_end END,
       updated_at = NOW()
     RETURNING count`,
    [key, windowInterval]
  );
  const count = rows[0].count;
  return { allowed: count <= max, remaining: Math.max(0, max - count) };
}

// ── Store ─────────────────────────────────────────────────────────────────────

/**
 * Persist a new OTP for the given email.
 * user_id may be null for brand-new accounts (created at verify time).
 */
async function storeOtp(email, code, userId) {
  const hmac      = signCode(email, code);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
  await pool.query(
    `INSERT INTO otp_codes (email, code_hmac, user_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [email.toLowerCase().trim(), hmac, userId ?? null, expiresAt]
  );
}

// ── Atomic consume ────────────────────────────────────────────────────────────

/**
 * Verify and consume an OTP atomically.
 * Returns { ok: true, userId: number|null } on success.
 * Returns { ok: false, reason: string } on failure.
 *
 * The CTE with FOR UPDATE SKIP LOCKED ensures only one concurrent request
 * can claim a given OTP row; the loser finds no unlocked candidate.
 */
async function consumeOtp(email, code) {
  const normalEmail = email.toLowerCase().trim();

  // Fetch the most-recent unused, unexpired code for this email
  const { rows: candidates } = await pool.query(
    `SELECT id, code_hmac, user_id
     FROM otp_codes
     WHERE email = $1 AND expires_at > NOW() AND used_at IS NULL
     ORDER BY created_at DESC LIMIT 10`,
    [normalEmail]
  );

  if (candidates.length === 0) {
    return { ok: false, reason: 'invalid_or_expired' };
  }

  // Find a matching candidate (constant-time per row)
  let match = null;
  for (const row of candidates) {
    if (codesMatch(row.code_hmac, normalEmail, code)) {
      match = row;
      break;
    }
  }
  if (!match) {
    return { ok: false, reason: 'invalid_or_expired' };
  }

  // Atomically mark as used; concurrent request will find 0 rows (SKIP LOCKED)
  const { rows: updated } = await pool.query(
    `WITH candidate AS (
       SELECT id FROM otp_codes
       WHERE id = $1 AND used_at IS NULL
       FOR UPDATE SKIP LOCKED
     )
     UPDATE otp_codes SET used_at = NOW()
     FROM candidate
     WHERE otp_codes.id = candidate.id
     RETURNING otp_codes.user_id`,
    [match.id]
  );

  if (updated.length === 0) {
    // Lost the race — another request consumed this code first
    return { ok: false, reason: 'already_used' };
  }

  return { ok: true, userId: updated[0].user_id };
}

module.exports = {
  generateCode,
  storeOtp,
  consumeOtp,
  checkRateLimit,
  REQ_WINDOW_MS,
  REQ_MAX,
  VER_WINDOW_MS,
  VER_MAX,
};

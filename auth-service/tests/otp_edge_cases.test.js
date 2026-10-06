// OTP edge-case tests: rate limits, resend invalidation, sync failure recovery.
// Runs against auth_db_test only (always-pass Turnstile secret assumed).
//
// Run: node tests/otp_edge_cases.test.js
'use strict';

process.env.DATABASE_URL            = process.env.DATABASE_URL_TEST
  || 'postgres://auth_user:auth_pass@127.0.0.1:5432/auth_db_test';
process.env.JWT_SECRET              = 'test-secret';
process.env.INTERNAL_SERVICE_SECRET = 'test-internal-svc-secret-32chars!!';
process.env.TURNSTILE_SECRET_KEY    = '1x0000000000000000000000000000000AA';
process.env.TURNSTILE_ALLOWED_HOSTNAME = 'localhost';
process.env.OTP_HMAC_SECRET         = 'test-hmac-secret-32chars-minimum!!';
process.env.TOTP_ENCRYPTION_KEY     = 'test-totp-encryption-key-32-chars-ok!';
process.env.GUEST_CHECKOUT          = 'true';
// Simulate escrow unreachable (for sync-failure recovery test)
process.env.ESCROW_SERVICE_URL      = 'http://127.0.0.1:19999';
delete process.env.RESEND_API_KEY;   // email stub only

const request   = require('supertest');
const { Pool }  = require('pg');
const { buildApp }  = require('../src/app');
const { storeOtp }  = require('../src/otpService');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app  = buildApp();
const TS   = '1x00000000000000000000AA'; // Cloudflare always-pass site token

let passed = 0, failed = 0;
function assert(c, m)        { if (!c) throw new Error(m || 'assertion failed'); }
function assertEqual(a, b, m){ if (a !== b) throw new Error(m || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

let counter = 0;
function uniqueEmail() { return `edge_${Date.now()}_${++counter}@test.invalid`; }

async function cleanEmail(e) {
  await pool.query('DELETE FROM otp_codes WHERE email = $1', [e]);
  await pool.query("DELETE FROM otp_rate_limits WHERE key LIKE '%' || $1", [e]);
  await pool.query('DELETE FROM users WHERE email = $1', [e]);
}

async function latestUnusedCode(em) {
  const { rows } = await pool.query(
    `SELECT id, user_id FROM otp_codes
     WHERE email = $1 AND used_at IS NULL AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [em]
  );
  return rows[0] || null;
}

console.log('\nOTP edge-case tests\n');

const _tests = [];
async function runAll() {
  for (const { name, fn } of _tests) {
    try   { await fn(); console.log(`  PASS  ${name}`); passed++; }
    catch (err) { console.error(`  FAIL  ${name}\n        ${err.message}`); failed++; }
  }
}
function test(name, fn) { _tests.push({ name, fn }); }

// ── 1. INCORRECT CODE RATE LIMIT (verify) ─────────────────────────────────────
// VER_MAX = 10; the 11th wrong attempt must return 429.
test('verify rate limit: 10 wrong attempts then 429 on 11th', async () => {
  const em = uniqueEmail();
  await request(app).post('/auth/otp/request')
    .set('X-Forwarded-For', '10.31.1.1')
    .send({ email: em, turnstile_token: TS });

  for (let i = 1; i <= 11; i++) {
    const r = await request(app).post('/auth/otp/verify')
      .send({ email: em, code: '000000' });
    if (i <= 10) {
      assertEqual(r.status, 401, `attempt ${i} should be 401 (wrong code), got ${r.status}`);
    } else {
      assertEqual(r.status, 429, `attempt 11 should be 429 (rate limited), got ${r.status}`);
      assert(r.body.error, '429 response must include error message');
    }
  }
  await cleanEmail(em);
});

// ── 2. RESEND: consumed code cannot be replayed ───────────────────────────────
// Once a code has been verified (used_at set), it cannot be used again.
// This is separate from resend — tests the consumed-code guard directly.
test('resend: once a code is consumed via verify it cannot be replayed', async () => {
  const em = uniqueEmail();
  await request(app).post('/auth/otp/request')
    .set('X-Forwarded-For', '10.31.1.2')
    .send({ email: em, turnstile_token: TS });

  const first = await latestUnusedCode(em);
  assert(first, 'should have initial code');

  // Plant a known code
  const knownCode = '111001';
  await pool.query('UPDATE otp_codes SET used_at = NOW() WHERE id = $1', [first.id]);
  await storeOtp(em, knownCode, first.user_id);

  // First verify succeeds
  const rv1 = await request(app).post('/auth/otp/verify').send({ email: em, code: knownCode });
  assertEqual(rv1.status, 200, 'first verify should succeed');

  // Replay of the same code is rejected
  const rv2 = await request(app).post('/auth/otp/verify').send({ email: em, code: knownCode });
  assertEqual(rv2.status, 401, 'replayed code must be rejected (401)');

  await cleanEmail(em);
});

// ── 3. RESEND: old code is invalidated on resend ─────────────────────────────
// After fix: invalidatePreviousCodes() is called before storeOtp on each request.
// A still-live old code must be rejected after the user requests a new one.
test('resend: old live code is invalidated when a new code is requested', async () => {
  const em = uniqueEmail();
  // First request
  await request(app).post('/auth/otp/request')
    .set('X-Forwarded-For', '10.31.1.3')
    .send({ email: em, turnstile_token: TS });

  const first = await latestUnusedCode(em);
  assert(first, 'should have first code');

  // Plant a known first code (replace the auto-generated one with a known value)
  const oldCode = '777001';
  await pool.query('UPDATE otp_codes SET used_at = NOW() WHERE id = $1', [first.id]);
  await storeOtp(em, oldCode, first.user_id);

  // Verify old code is live before resend
  const { rows: liveBefore } = await pool.query(
    `SELECT id FROM otp_codes WHERE email=$1 AND used_at IS NULL AND expires_at > NOW()`, [em]
  );
  assert(liveBefore.length > 0, 'old code should be live before resend');

  // Resend — invalidatePreviousCodes() should mark oldCode as used
  await request(app).post('/auth/otp/request')
    .set('X-Forwarded-For', '10.31.1.3')
    .send({ email: em, turnstile_token: TS });

  // Old code must now be rejected
  const rv = await request(app).post('/auth/otp/verify').send({ email: em, code: oldCode });
  assertEqual(rv.status, 401, 'old code must be rejected after resend (401)');

  // New code (auto-generated by resend) is the only live code
  const { rows: liveAfter } = await pool.query(
    `SELECT id FROM otp_codes WHERE email=$1 AND used_at IS NULL AND expires_at > NOW()`, [em]
  );
  assertEqual(liveAfter.length, 1, 'exactly one live code should exist after resend');

  await cleanEmail(em);
});

// ── 4. REQUEST RATE LIMIT ─────────────────────────────────────────────────────
// REQ_MAX = 5; the 6th request must return 429.
test('request rate limit: 5 requests then 429 on 6th (per-email)', async () => {
  const em = uniqueEmail();
  for (let i = 1; i <= 6; i++) {
    const r = await request(app).post('/auth/otp/request')
      .set('X-Forwarded-For', '10.31.2.1')
      .send({ email: em, turnstile_token: TS });
    if (i <= 5) {
      assertEqual(r.status, 200, `request ${i} should be 200, got ${r.status}`);
    } else {
      assertEqual(r.status, 429, `request 6 should be 429 (rate limited), got ${r.status}`);
      assert(r.body.error, '429 must include error message');
    }
  }
  await cleanEmail(em);
});

// ── 5. SYNC FAILURE RECOVERY ──────────────────────────────────────────────────
// ESCROW_SERVICE_URL points to a dead port (19999).
// The OTP verify handler must still complete and return a JWT.
// Escrow sync is fire-and-forget — a network error must not propagate to the caller.
test('sync failure: OTP verify succeeds even when escrow is unreachable', async () => {
  const em = uniqueEmail();
  await request(app).post('/auth/otp/request')
    .set('X-Forwarded-For', '10.31.3.1')
    .send({ email: em, turnstile_token: TS });

  const row = await latestUnusedCode(em);
  assert(row, 'should have code');
  const knownCode = '555321';
  await pool.query('UPDATE otp_codes SET used_at = NOW() WHERE id = $1', [row.id]);
  await storeOtp(em, knownCode, row.user_id);

  const rv = await request(app).post('/auth/otp/verify').send({ email: em, code: knownCode });
  assertEqual(rv.status, 200,
    `OTP verify should succeed with dead escrow, got ${rv.status}: ${JSON.stringify(rv.body)}`);
  assert(rv.body.access_token, 'should return access_token despite dead escrow');
  assertEqual(rv.body.user.email, em);

  await cleanEmail(em);
});

// ── Run ────────────────────────────────────────────────────────────────────────

runAll().then(() => pool.end()).then(() => {
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}).catch(err => {
  console.error('Runner error:', err);
  process.exit(1);
});

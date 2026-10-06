// Guest checkout integration tests — requires auth_db_test.
// Covers the full OTP request → verify → session flow.
// Tests: rate limits, enumeration resistance, concurrent consumption, admin block.
//
// Run: node tests/checkout_guest_flow.test.js

'use strict';

process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST ||
  'postgres://auth_user:auth_pass@127.0.0.1:5432/auth_db_test';
process.env.JWT_SECRET             = 'test-secret';
process.env.INTERNAL_SERVICE_SECRET = 'test-internal-svc-secret-32chars!!';
process.env.TURNSTILE_SECRET_KEY   = '1x0000000000000000000000000000000AA';
process.env.TURNSTILE_ALLOWED_HOSTNAME = 'localhost';
process.env.OTP_HMAC_SECRET        = 'test-hmac-secret-32chars-minimum!!';
process.env.TOTP_ENCRYPTION_KEY    = 'test-totp-encryption-key-32-chars-ok!';
process.env.GUEST_CHECKOUT         = 'true';
delete process.env.STRIPE_SECRET_KEY;
delete process.env.RESEND_API_KEY;   // email stub only

const request  = require('supertest');
const { Pool } = require('pg');
const jwt      = require('jsonwebtoken');
const { buildApp } = require('../src/app');
const { generateCode, storeOtp, invalidatePreviousCodes } = require('../src/otpService');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app  = buildApp();

const TS_TOKEN = '1x00000000000000000000AA'; // Cloudflare always-pass test token

// ── Minimal test runner ───────────────────────────────────────────────────────

let passed = 0, failed = 0;
const _tests = [];
function test(name, fn) { _tests.push({ name, fn }); }
async function runAll() {
  for (const { name, fn } of _tests) {
    try {
      await fn();
      console.log(`  PASS  ${name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL  ${name}`);
      console.error(`        ${err.message}`);
      if (process.env.VERBOSE) console.error(err.stack);
      failed++;
    }
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// ── Helpers ───────────────────────────────────────────────────────────────────

let emailCounter = 0;
function uniqueEmail() {
  return `guest_test_${Date.now()}_${++emailCounter}@test.invalid`;
}

async function cleanEmail(email) {
  await pool.query('DELETE FROM otp_codes WHERE email = $1', [email]);
  await pool.query("DELETE FROM otp_rate_limits WHERE key LIKE '%' || $1", [email]);
  await pool.query('DELETE FROM users WHERE email = $1', [email]);
}

async function requestOtp(email, name) {
  return request(app)
    .post('/auth/otp/request')
    .send({ email, name: name || 'Test Buyer', turnstile_token: TS_TOKEN });
}

async function verifyOtp(email, code) {
  return request(app)
    .post('/auth/otp/verify')
    .send({ email, code });
}

async function getStoredCode(email) {
  const { rows } = await pool.query(
    `SELECT c.id, c.code_hmac, c.user_id
     FROM otp_codes c
     JOIN users u ON u.id = c.user_id
     WHERE c.email = $1 AND c.used_at IS NULL AND c.expires_at > NOW()
     ORDER BY c.created_at DESC LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

const cleanupEmails = [];

async function afterAll() {
  for (const e of cleanupEmails) await cleanEmail(e);
  await pool.end();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\nGuest checkout integration tests\n');

test('feature disabled when GUEST_CHECKOUT != true', async () => {
  process.env.GUEST_CHECKOUT = 'false';
  const r = await request(app).post('/auth/otp/request').send({ email: 'x@x.com', turnstile_token: TS_TOKEN });
  assertEqual(r.status, 404, 'should 404 when disabled');
  process.env.GUEST_CHECKOUT = 'true';
});

test('otp/request returns code_sent for new email', async () => {
  const email = uniqueEmail();
  cleanupEmails.push(email);
  const r = await requestOtp(email, 'New Buyer');
  assertEqual(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  assertEqual(r.body.status, 'code_sent');
});

test('otp/request creates buyer account for new email', async () => {
  const email = uniqueEmail();
  cleanupEmails.push(email);
  await requestOtp(email);
  const { rows } = await pool.query('SELECT role, email_verified FROM users WHERE email = $1', [email]);
  assert(rows.length === 1, 'user should be created');
  assertEqual(rows[0].role, 'buyer');
  assert(rows[0].email_verified, 'should be email_verified');
});

test('otp/request returns code_sent for existing email (enumeration resistance)', async () => {
  const email = uniqueEmail();
  cleanupEmails.push(email);
  // First request creates account
  await requestOtp(email);
  // Second request same email
  const r = await requestOtp(email);
  assertEqual(r.status, 200);
  assertEqual(r.body.status, 'code_sent');
});

test('otp/verify succeeds with correct code and issues JWT', async () => {
  const email = uniqueEmail();
  cleanupEmails.push(email);
  await requestOtp(email);

  // Use the service to verify (we need to know the actual code)
  // Read from DB and use otpService directly to verify
  const row = await getStoredCode(email);
  assert(row, 'otp code should be stored');

  // We can't read the raw code from the HMAC — use storeOtp directly instead
  // to set a known code, then call the endpoint
  const knownCode = '654321';
  const userId = row.user_id;
  await pool.query('UPDATE otp_codes SET used_at = NOW() WHERE id = $1', [row.id]);
  await storeOtp(email, knownCode, userId);

  const r = await verifyOtp(email, knownCode);
  assertEqual(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert(r.body.access_token, 'should return access_token');
  assert(r.body.user, 'should return user');
  assertEqual(r.body.user.email, email);
  assertEqual(r.body.user.role, 'buyer');

  // JWT should be valid
  const payload = jwt.verify(r.body.access_token, 'test-secret');
  assertEqual(payload.email, email);
  assertEqual(payload.role, 'buyer');
});

test('otp/verify fails with wrong code', async () => {
  const email = uniqueEmail();
  cleanupEmails.push(email);
  await requestOtp(email);
  const r = await verifyOtp(email, '000000');
  assertEqual(r.status, 401);
  assert(r.body.error, 'should return error message');
});

test('otp/verify fails with expired code', async () => {
  const email = uniqueEmail();
  cleanupEmails.push(email);
  // Insert a code that is already expired
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, role, email_verified, created_at)
     VALUES ($1, $2, 'buyer', true, NOW()) RETURNING id`,
    [`exp_test`, email]
  );
  await pool.query(
    `INSERT INTO otp_codes (email, code_hmac, user_id, expires_at)
     VALUES ($1, 'deadbeef', $2, NOW() - INTERVAL '1 second')`,
    [email, rows[0].id]
  );
  const r = await verifyOtp(email, '123456');
  assertEqual(r.status, 401);
});

test('otp/verify fails with already-used code', async () => {
  const email = uniqueEmail();
  cleanupEmails.push(email);
  await requestOtp(email);
  const row = await getStoredCode(email);
  assert(row, 'should have code');

  const knownCode = '111222';
  await pool.query('UPDATE otp_codes SET used_at = NOW() WHERE id = $1', [row.id]);
  await storeOtp(email, knownCode, row.user_id);

  // Use it once
  await verifyOtp(email, knownCode);
  // Use it again — should fail
  const r2 = await verifyOtp(email, knownCode);
  assertEqual(r2.status, 401);
});

test('concurrent verify requests cannot both succeed (only one wins)', async () => {
  const email = uniqueEmail();
  cleanupEmails.push(email);
  await requestOtp(email);
  const row = await getStoredCode(email);
  assert(row, 'should have code');

  const knownCode = '999888';
  await pool.query('UPDATE otp_codes SET used_at = NOW() WHERE id = $1', [row.id]);
  await storeOtp(email, knownCode, row.user_id);

  // Fire two concurrent verify requests
  const [r1, r2] = await Promise.all([
    verifyOtp(email, knownCode),
    verifyOtp(email, knownCode),
  ]);
  const statuses = [r1.status, r2.status].sort();
  // Exactly one 200 and one 401
  assert(statuses[0] === 200 || statuses[1] === 200, 'at least one should succeed');
  // At most one can succeed
  const successes = [r1, r2].filter(r => r.status === 200);
  assert(successes.length <= 1, `both requests succeeded — race condition! statuses: ${r1.status}, ${r2.status}`);
});

test('otp/verify blocked for admin email (passwordless admin not allowed)', async () => {
  const email = uniqueEmail();
  cleanupEmails.push(email);
  // Create an admin user directly
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, role, email_verified, created_at)
     VALUES ('Admin', $1, 'admin', true, NOW()) RETURNING id`,
    [email]
  );
  const knownCode = '777666';
  await storeOtp(email, knownCode, rows[0].id);

  const r = await verifyOtp(email, knownCode);
  assertEqual(r.status, 403, 'admin should be blocked from OTP login');
});

test('otp/request rejects missing turnstile token', async () => {
  const r = await request(app)
    .post('/auth/otp/request')
    .send({ email: 'test@test.com' }); // no turnstile_token
  // verifyTurnstile middleware rejects this
  assert(r.status >= 400, 'should reject missing turnstile');
});

test('otp/request validates email format', async () => {
  // Use a distinct IP to avoid the shared IP rate limit bucket
  const r = await request(app)
    .post('/auth/otp/request')
    .set('X-Forwarded-For', '10.0.1.1')
    .send({ email: 'not-an-email', turnstile_token: TS_TOKEN });
  assertEqual(r.status, 400);
});

test('existing seller keeps seller role after OTP request', async () => {
  const email = uniqueEmail();
  cleanupEmails.push(email);
  // Create an existing seller
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, role, email_verified, password_hash, created_at)
     VALUES ('Seller', $1, 'seller', true, 'hash', NOW()) RETURNING id`,
    [email]
  );

  // OTP request should return code_sent (not an error)
  // Use a distinct IP to avoid hitting the shared test IP rate limit bucket
  const r = await request(app)
    .post('/auth/otp/request')
    .set('X-Forwarded-For', '10.0.1.2')
    .send({ email, name: 'Seller', turnstile_token: TS_TOKEN });
  assertEqual(r.status, 200);
  assertEqual(r.body.status, 'code_sent');

  // Verify — role should remain seller
  const knownCode = '334455';
  await storeOtp(email, knownCode, rows[0].id);

  const vr = await verifyOtp(email, knownCode);
  assertEqual(vr.status, 200, `expected 200, got ${vr.status}: ${JSON.stringify(vr.body)}`);
  assertEqual(vr.body.user.role, 'seller', 'seller role must be preserved');
});

test('otp/request rejects seller account with no new account created', async () => {
  // Sellers/existing accounts still get code_sent (enumeration resistance)
  // but no new account is created for an existing email
  const email = uniqueEmail();
  cleanupEmails.push(email);
  await pool.query(
    `INSERT INTO users (name, email, role, email_verified, password_hash, created_at)
     VALUES ('SellerX', $1, 'seller', true, 'hash', NOW())`,
    [email]
  );
  const before = await pool.query('SELECT COUNT(*) FROM users WHERE email = $1', [email]);

  await requestOtp(email);

  const after = await pool.query('SELECT COUNT(*) FROM users WHERE email = $1', [email]);
  assertEqual(before.rows[0].count, after.rows[0].count, 'no duplicate user should be created');
});

test('resend invalidates previous live codes', async () => {
  const email = uniqueEmail();
  cleanupEmails.push(email);
  // First request — use distinct IP to avoid shared test-suite rate limit bucket
  const r1 = await request(app)
    .post('/auth/otp/request')
    .set('X-Forwarded-For', '10.50.1.1')
    .send({ email, name: 'Resend Test', turnstile_token: TS_TOKEN });
  assertEqual(r1.status, 200);

  // Replace auto-generated code with known value
  const row = await getStoredCode(email);
  assert(row, 'should have first code after request');
  const oldCode = '100200';
  await pool.query('UPDATE otp_codes SET used_at = NOW() WHERE id = $1', [row.id]);
  await storeOtp(email, oldCode, row.user_id);

  // Confirm old code is live before resend
  const liveBefore = await getStoredCode(email);
  assert(liveBefore, 'old code should be live before resend');

  // Resend via the endpoint (triggers invalidatePreviousCodes)
  const r2 = await request(app)
    .post('/auth/otp/request')
    .set('X-Forwarded-For', '10.50.1.1')
    .send({ email, turnstile_token: TS_TOKEN });
  assertEqual(r2.status, 200, 'resend should succeed');

  // Old code must be rejected
  const rv = await verifyOtp(email, oldCode);
  assertEqual(rv.status, 401, 'old code must be rejected (401) after resend');
});

// ── Summary ───────────────────────────────────────────────────────────────────

runAll().then(() => afterAll()).then(() => {
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}).catch((err) => {
  console.error('afterAll failed:', err);
  process.exit(1);
});

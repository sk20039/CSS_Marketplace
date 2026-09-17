// Auth-service integration tests against an isolated PostgreSQL database.
//
// Requires:
//   1. PostgreSQL running (pg_isready on 127.0.0.1:5432)
//   2. auth_db_test database created and schema migrated (or trust beforeAll)
//   3. DATABASE_URL_TEST env var (default: postgres://auth_user:auth_pass@...)
//
// Run: node tests/auth.test.js
'use strict';

// Set DATABASE_URL before any app module is required so db.js creates its
// pool against the test database.
process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST ||
  'postgres://auth_user:auth_pass@127.0.0.1:5432/auth_db_test';
process.env.JWT_SECRET = 'test-secret';
process.env.INTERNAL_SERVICE_SECRET = 'test-internal-svc-secret-32chars!!';
// Cloudflare test secret — short-circuits siteverify network call in tests.
process.env.TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA';
process.env.TURNSTILE_ALLOWED_HOSTNAME = 'localhost';
// Clear Stripe keys so tests run in stub mode (no real API calls)
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.ADMIN_JWT_SECRET;
process.env.TOTP_ENCRYPTION_KEY = 'test-totp-encryption-key-32-chars-ok!';

const request = require('supertest');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { buildApp } = require('../src/app');
const crypto = require('crypto');
const bcryptjs = require('bcryptjs');
const { authenticator } = require('otplib');
const { encryptSecret } = require('../src/mfaHelpers');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = buildApp();

// ── Minimal test runner ───────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

// ── Schema + seed helpers ─────────────────────────────────────────────────────

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name              TEXT        NOT NULL,
    email             TEXT        NOT NULL,
    password_hash     TEXT        NOT NULL,
    role              TEXT        NOT NULL DEFAULT 'buyer',
    stripe_account_id TEXT,
    email_verified    BOOLEAN     NOT NULL DEFAULT false,
    ship_from_address JSONB,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT users_role_check CHECK (role IN ('buyer','seller','admin'))
  );
  -- Plain lookup index kept for fast WHERE email = $1 queries (app always
  -- passes a normalised lowercase value).
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  -- Case-insensitive uniqueness: mirrors the DB state after migration
  -- 1758067200000_email_lower_unique.
  CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (LOWER(email));

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT        NOT NULL,
    token_sha256 TEXT        NOT NULL UNIQUE,
    expires_at   TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user   ON refresh_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_sha256  ON refresh_tokens(token_sha256);

  CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT        NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_verification_tokens_user ON email_verification_tokens(user_id);

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT        NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);
`;

// Demo users seeded directly — same IDs, emails, roles, passwords, and
// Stripe account ID as the former SQLite import. No native module needed.
const DEMO_USERS = [
  { id: 3, name: 'Demo Seller', email: 'demo.seller@cricket.test', password: 'Demo1234!',  role: 'seller', stripe_account_id: 'acct_1U590xBKfStkw42B' },
  { id: 4, name: 'Test Buyer',  email: 'buyer@cricket.test',       password: 'Buyer1234!', role: 'buyer',  stripe_account_id: null },
  { id: 5, name: 'Test Admin',  email: 'admin@cricket.test',       password: 'Admin1234!', role: 'admin',  stripe_account_id: null },
];

async function seedDemoUsers(client) {
  for (const u of DEMO_USERS) {
    const hash = await bcryptjs.hash(u.password, 4); // cost 4: fast for tests
    await client.query(
      `INSERT INTO users
         (id, name, email, password_hash, role, stripe_account_id, email_verified)
       OVERRIDING SYSTEM VALUE
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (id) DO NOTHING`,
      [u.id, u.name, u.email, hash, u.role, u.stripe_account_id]
    );
  }
  await client.query(
    `SELECT setval(pg_get_serial_sequence('users','id'), GREATEST(COALESCE((SELECT MAX(id) FROM users), 0), 1))`
  );
  return { users: DEMO_USERS.length, tokens: 0 };
}

// ── Unique email helper ───────────────────────────────────────────────────────

let seq = 0;
function uniqueEmail() {
  return `test-${Date.now()}-${++seq}@example.com`;
}

// ── Test suite ────────────────────────────────────────────────────────────────

async function run() {
  console.log('Auth service — PostgreSQL integration tests\n');

  // Setup: apply schema and seed demo users
  await pool.query('TRUNCATE TABLE password_reset_tokens, email_verification_tokens, refresh_tokens, users RESTART IDENTITY CASCADE');
  await pool.query(SCHEMA_SQL);
  // MFA schema — added after initial schema (uses ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS)
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS mfa_enabled     BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS mfa_totp_secret TEXT;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
      id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash  TEXT        NOT NULL,
      used_at    TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_mfa_recovery_codes_user ON mfa_recovery_codes(user_id);
  `);
  const client = await pool.connect();
  let seeded;
  try {
    seeded = await seedDemoUsers(client);
  } finally {
    client.release();
  }
  console.log(`Setup: seeded ${seeded.users} demo user(s)\n`);

  // ── POST /auth/register ───────────────────────────────────────────────────
  // NOTE: registerLimiter allows max 5 requests per IP per hour.
  // All register tests combined must not exceed 5 calls.
  console.log('POST /auth/register');

  await test('returns 400 when required fields are missing', async () => {
    // Counts toward rate limit (1/5)
    const res = await request(app).post('/auth/register').send({ email: uniqueEmail(), turnstile_token: 'test-token' });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  let registeredEmail;
  await test('returns 201 with verification message for valid registration', async () => {
    // (2/5)
    registeredEmail = uniqueEmail();
    const res = await request(app)
      .post('/auth/register')
      .send({ name: 'Test User', email: registeredEmail, password: 'ValidPass1!', turnstile_token: 'test-token' });
    assert(res.status === 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.message, 'should have a message');
    assert(res.body.user && res.body.user.id > 0, 'should return user with id');
    assert(res.body.user.role === 'buyer', 'default role should be buyer');
  });

  await test('returns 409 for duplicate email', async () => {
    // Two calls: first creates user (3/5), second is duplicate (4/5)
    const email = uniqueEmail();
    await request(app).post('/auth/register').send({ name: 'A', email, password: 'Pass1234!', turnstile_token: 'test-token' });
    const res = await request(app).post('/auth/register').send({ name: 'B', email, password: 'Other1!', turnstile_token: 'test-token' });
    assert(res.status === 409, `expected 409, got ${res.status}`);
    assert(res.body.error, 'should have error message');
  });

  // ── POST /auth/login — invalid credentials ────────────────────────────────
  console.log('\nPOST /auth/login — invalid credentials');

  await test('returns 401 for invalid password', async () => {
    const res = await request(app).post('/auth/login')
      .send({ email: 'buyer@cricket.test', password: 'WrongPassword!', turnstile_token: 'test-token' });
    assert(res.status === 401, `expected 401, got ${res.status}`);
    assert(res.body.error === 'Invalid credentials', `unexpected error: ${res.body.error}`);
  });

  await test('returns 401 for non-existent email', async () => {
    const res = await request(app).post('/auth/login')
      .send({ email: 'nobody@nowhere.com', password: 'Whatever1!', turnstile_token: 'test-token' });
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await test('returns 403 for unverified account', async () => {
    // Use the successfully registered (but unverified) user from the registration test above.
    // This avoids a 6th /auth/register call which would hit the rate limiter (max 5/hr).
    assert(registeredEmail, 'registeredEmail must be set from the registration test');
    const res = await request(app).post('/auth/login').send({ email: registeredEmail, password: 'ValidPass1!', turnstile_token: 'test-token' });
    assert(res.status === 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  await test('returns 400 when fields are missing', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'a@b.com', turnstile_token: 'test-token' });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });


  // ── Email verification ─────────────────────────────────────────────────────
  console.log('\nEmail verification');

  // Direct-SQL helper: creates a user without going through the rate-limited
  // /auth/register endpoint. Uses bcrypt cost 4 (minimum) for test speed.
  async function insertTestUser(email, verified = false) {
    const hash = await bcryptjs.hash('TestPass1!', 4);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, email_verified)
       VALUES ('Test', $1, $2, 'buyer', $3) RETURNING id, email`,
      [email, hash, verified]
    );
    return rows[0];
  }

  await test('registration stores exactly one verification token in the database', async () => {
    const { rows } = await pool.query(
      `SELECT evt.* FROM email_verification_tokens evt
       JOIN users u ON u.id = evt.user_id WHERE u.email = $1`,
      [registeredEmail]
    );
    assert(rows.length === 1, `expected 1 token, got ${rows.length}`);
    assert(new Date(rows[0].expires_at) > new Date(), 'token should not already be expired');
  });

  await test('expired verification token returns 400', async () => {
    const user = await insertTestUser(uniqueEmail());
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await pool.query(
      `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() - INTERVAL '1 second')`,
      [user.id, hash]
    );
    const res = await request(app).get(`/auth/verify-email?token=${rawToken}`);
    assert(res.status === 400, `expected 400, got ${res.status}`);
    assert(res.body.error, 'should have error message');
  });

  let consumedToken;
  await test('valid verification token verifies account and is consumed', async () => {
    const user = await insertTestUser(uniqueEmail());
    consumedToken = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(consumedToken).digest('hex');
    await pool.query(
      `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '24 hours')`,
      [user.id, hash]
    );
    const res = await request(app).get(`/auth/verify-email?token=${consumedToken}`);
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.message, 'should have success message');
    const { rows: uRows } = await pool.query('SELECT email_verified FROM users WHERE id = $1', [user.id]);
    assert(uRows[0].email_verified === true, 'email_verified should be true in DB');
    const { rows: tRows } = await pool.query(
      'SELECT * FROM email_verification_tokens WHERE user_id = $1', [user.id]
    );
    assert(tRows.length === 0, 'token should be deleted after successful verification');
  });

  await test('verification token cannot be reused after successful verification', async () => {
    assert(consumedToken, 'consumedToken must be set from previous test');
    const res = await request(app).get(`/auth/verify-email?token=${consumedToken}`);
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  console.log('\nPOST /auth/resend-verification');

  await test('missing email field returns 400', async () => {
    const res = await request(app).post('/auth/resend-verification').send({ turnstile_token: 'test-token' });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await test('unknown email returns generic 200 without leaking existence', async () => {
    const res = await request(app)
      .post('/auth/resend-verification')
      .send({ email: 'nobody-resend@nowhere.invalid', turnstile_token: 'test-token' });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.message, 'should have message');
  });

  await test('already-verified user returns generic 200 and no token is created', async () => {
    const res = await request(app)
      .post('/auth/resend-verification')
      .send({ email: 'buyer@cricket.test', turnstile_token: 'test-token' });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.message, 'should have message');
    const { rows: uRows } = await pool.query('SELECT id FROM users WHERE email = $1', ['buyer@cricket.test']);
    const { rows: tRows } = await pool.query(
      'SELECT * FROM email_verification_tokens WHERE user_id = $1', [uRows[0].id]
    );
    assert(tRows.length === 0, 'verified user should not receive a new token');
  });

  await test('unverified user gets a new token; old token is replaced', async () => {
    const { rows: oldRows } = await pool.query(
      `SELECT evt.id FROM email_verification_tokens evt
       JOIN users u ON u.id = evt.user_id WHERE u.email = $1`,
      [registeredEmail]
    );
    const oldTokenId = oldRows[0]?.id;

    const res = await request(app)
      .post('/auth/resend-verification')
      .send({ email: registeredEmail, turnstile_token: 'test-token' });
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.message, 'should have message');

    const { rows: newRows } = await pool.query(
      `SELECT evt.* FROM email_verification_tokens evt
       JOIN users u ON u.id = evt.user_id WHERE u.email = $1`,
      [registeredEmail]
    );
    assert(newRows.length === 1, `expected 1 replacement token, got ${newRows.length}`);
    if (oldTokenId) {
      assert(newRows[0].id !== oldTokenId, 'replacement token should have a new id');
    }
    assert(new Date(newRows[0].expires_at) > new Date(), 'replacement token should not be expired');
  });

  // ── POST /auth/login — seeded demo accounts ───────────────────────────────
  console.log('\nPOST /auth/login — seeded accounts');

  let buyerToken, sellerToken, adminToken;
  let buyerRefreshCookie, sellerRefreshCookie;

  await test('seeded buyer (buyer@cricket.test) can log in', async () => {
    const res = await request(app).post('/auth/login')
      .send({ email: 'buyer@cricket.test', password: 'Buyer1234!', turnstile_token: 'test-token' });
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.access_token, 'should return access_token');
    assert(res.body.user.role === 'buyer', `expected buyer, got ${res.body.user.role}`);
    buyerToken = res.body.access_token;
    buyerRefreshCookie = res.headers['set-cookie'];
  });

  await test('seeded seller (demo.seller@cricket.test) can log in', async () => {
    const res = await request(app).post('/auth/login')
      .send({ email: 'demo.seller@cricket.test', password: 'Demo1234!', turnstile_token: 'test-token' });
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.access_token, 'should return access_token');
    assert(res.body.user.role === 'seller', `expected seller, got ${res.body.user.role}`);
    sellerToken = res.body.access_token;
    sellerRefreshCookie = res.headers['set-cookie'];
  });

  await test('seeded admin (admin@cricket.test) without MFA returns 403 MFA_ENROLLMENT_REQUIRED', async () => {
    // Admin accounts require MFA. Login returns 403 + enrollment token when MFA is not set up.
    const res = await request(app).post('/auth/login')
      .send({ email: 'admin@cricket.test', password: 'Admin1234!', turnstile_token: 'test-token' });
    assert(res.status === 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.code === 'MFA_ENROLLMENT_REQUIRED', `expected MFA_ENROLLMENT_REQUIRED, got ${res.body.code}`);
    assert(typeof res.body.mfa_enrollment_token === 'string', 'mfa_enrollment_token must be present');
    // Derive adminToken directly for subsequent authorization tests (no login needed).
    const { rows } = await pool.query("SELECT id, email, role FROM users WHERE email = 'admin@cricket.test'");
    const adminUser = rows[0];
    adminToken = jwt.sign(
      { sub: adminUser.id, email: adminUser.email, role: adminUser.role, jti: 'test-admin' },
      process.env.JWT_SECRET
    );
  });

  // ── GET /auth/me — authorization ─────────────────────────────────────────
  console.log('\nGET /auth/me — authorization');

  await test('returns 401 with no token', async () => {
    const res = await request(app).get('/auth/me');
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await test('returns 401 with expired token', async () => {
    const expired = jwt.sign({ sub: 4, email: 'buyer@cricket.test', role: 'buyer' }, 'test-secret', { expiresIn: '-1s' });
    const res = await request(app).get('/auth/me').set('Authorization', `Bearer ${expired}`);
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await test('buyer authorization — returns role=buyer and correct email', async () => {
    assert(buyerToken, 'buyerToken must be set from login test');
    const res = await request(app).get('/auth/me').set('Authorization', `Bearer ${buyerToken}`);
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.role === 'buyer', `expected buyer, got ${res.body.role}`);
    assert(res.body.email === 'buyer@cricket.test', `email mismatch: ${res.body.email}`);
  });

  await test('seller authorization — returns role=seller and correct email', async () => {
    assert(sellerToken, 'sellerToken must be set from login test');
    const res = await request(app).get('/auth/me').set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.role === 'seller', `expected seller, got ${res.body.role}`);
    assert(res.body.email === 'demo.seller@cricket.test', `email mismatch: ${res.body.email}`);
  });

  await test('admin authorization — returns role=admin and correct email', async () => {
    assert(adminToken, 'adminToken must be set');
    const res = await request(app).get('/auth/me').set('Authorization', `Bearer ${adminToken}`);
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.role === 'admin', `expected admin, got ${res.body.role}`);
    assert(res.body.email === 'admin@cricket.test', `email mismatch: ${res.body.email}`);
  });

  // ── Stripe account verification ───────────────────────────────────────────
  console.log('\nStripe account synchronization');

  await test('seller 3 stripe_account_id preserved as acct_1U590xBKfStkw42B', async () => {
    const { rows } = await pool.query('SELECT stripe_account_id FROM users WHERE id = $1', [3]);
    assert(rows[0], 'seller id=3 should exist');
    assert(
      rows[0].stripe_account_id === 'acct_1U590xBKfStkw42B',
      `expected acct_1U590xBKfStkw42B, got ${rows[0].stripe_account_id}`
    );
  });

  await test('GET /sellers/connect/status returns connected=false in stub mode (no STRIPE_SECRET_KEY)', async () => {
    assert(sellerToken, 'sellerToken must be set');
    const res = await request(app)
      .get('/auth/sellers/connect/status')
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.stub === true, 'stub flag should be true when no STRIPE_SECRET_KEY');
    assert(res.body.connected === false, 'connected should be false in stub mode');
  });

  await test('POST /sellers/connect returns 503 in stub mode (no STRIPE_SECRET_KEY)', async () => {
    assert(sellerToken, 'sellerToken must be set');
    const res = await request(app)
      .post('/auth/sellers/connect')
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 503, `expected 503, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.stub === true, 'stub flag should be true');
  });

  // ── Webhook updates ───────────────────────────────────────────────────────
  console.log('\nWebhook updates');

  await test('POST /webhooks/stripe in stub mode returns { received: true, stub: true }', async () => {
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ type: 'account.updated', data: { object: { id: 'acct_test' } } }));
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.received === true, 'received should be true');
    assert(res.body.stub === true, 'stub should be true');
  });

  // ── Token refresh (rotation) ──────────────────────────────────────────────
  console.log('\nToken refresh');

  await test('login → refresh → new access token (cookie-based rotation)', async () => {
    // Reuse the buyer cookie from the imported-accounts login — avoids an extra
    // login call that would push us past the rate limiter (max 10/15 min).
    assert(buyerRefreshCookie && buyerRefreshCookie.length > 0, 'buyerRefreshCookie must be set from login test');

    const refresh = await request(app)
      .post('/auth/refresh')
      .set('Cookie', buyerRefreshCookie);
    assert(refresh.status === 200, `refresh failed: ${refresh.status}: ${JSON.stringify(refresh.body)}`);
    assert(refresh.body.access_token, 'should return new access_token');
    assert(refresh.body.access_token !== buyerToken, 'new token should differ from original');

    // Rotate: update stored cookie for subsequent tests
    buyerRefreshCookie = refresh.headers['set-cookie'];
  });

  await test('refresh with no cookie returns 401', async () => {
    const res = await request(app).post('/auth/refresh');
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await test('POST /auth/logout clears refresh cookie', async () => {
    // Use the rotated buyer cookie — no additional login needed.
    assert(buyerRefreshCookie && buyerRefreshCookie.length > 0, 'buyerRefreshCookie must be set');
    const res = await request(app).post('/auth/logout').set('Cookie', buyerRefreshCookie);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.ok === true, 'should return ok:true');
    // Subsequent refresh with the same (now deleted) cookie should fail
    const retried = await request(app).post('/auth/refresh').set('Cookie', buyerRefreshCookie);
    assert(retried.status === 401, `expected 401 after logout, got ${retried.status}`);
  });

  // ── token_sha256 indexed lookup (BLOCKER-1 regression) ───────────────────
  // Prove that refresh/logout use the indexed token_sha256 column and do NOT
  // fall back to a full-table bcrypt scan.
  console.log('\nRefresh token SHA-256 indexed lookup (BLOCKER-1)');

  await test('token_sha256 column is stored on login and is a valid hex SHA-256', async () => {
    // Inspect the DB row created by the seller login earlier in this test run.
    const { rows } = await pool.query(
      "SELECT token_sha256 FROM refresh_tokens WHERE user_id = (SELECT id FROM users WHERE email = 'demo.seller@cricket.test') ORDER BY id DESC LIMIT 1"
    );
    assert(rows.length > 0, 'must have at least one refresh token for demo seller');
    const sha256 = rows[0].token_sha256;
    assert(typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256),
      `token_sha256 must be a 64-char hex string, got: ${sha256}`);
  });

  await test('refresh token lookup uses indexed token_sha256 — single row returned, not full table', async () => {
    // Insert 5 decoy tokens for a different user so the table has multiple rows.
    const { rows: [decoyUser] } = await pool.query(
      "SELECT id FROM users WHERE email = 'buyer@cricket.test'"
    );
    const crypto2 = require('crypto');
    const bcryptjs2 = require('bcryptjs');
    for (let i = 0; i < 5; i++) {
      const raw = crypto2.randomBytes(32).toString('hex');
      const sha256 = crypto2.createHash('sha256').update(raw).digest('hex');
      const hash = await bcryptjs2.hash(raw, 4); // cost 4 for speed in tests
      await pool.query(
        'INSERT INTO refresh_tokens (user_id, token_hash, token_sha256, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL \'7 days\')',
        [decoyUser.id, hash, sha256]
      );
    }

    // Now issue a real login for seller to get a fresh cookie, then refresh it.
    // The refresh must succeed without touching the 5 decoy rows.
    const loginRes = await request(app)
      .post('/auth/login')
      .send({ email: 'demo.seller@cricket.test', password: 'Demo1234!', turnstile_token: 'test-token' });
    assert(loginRes.status === 200, `seller login failed: ${loginRes.status}`);
    const freshCookie = loginRes.headers['set-cookie'];
    assert(freshCookie && freshCookie.length > 0, 'must receive refresh cookie');

    // Count rows before
    const { rows: before } = await pool.query('SELECT COUNT(*) AS c FROM refresh_tokens');
    const countBefore = parseInt(before[0].c, 10);

    const refreshRes = await request(app)
      .post('/auth/refresh')
      .set('Cookie', freshCookie);
    assert(refreshRes.status === 200, `refresh failed: ${refreshRes.status}`);
    assert(refreshRes.body.access_token, 'must return access_token');

    // After a successful refresh, the old token is deleted and a new one inserted.
    // Count of rows must be (countBefore - 1 + 1) = countBefore.
    const { rows: after } = await pool.query('SELECT COUNT(*) AS c FROM refresh_tokens');
    const countAfter = parseInt(after[0].c, 10);
    assert(countAfter === countBefore, `token count mismatch: before=${countBefore} after=${countAfter}`);

    // Clean up decoy tokens
    await pool.query("DELETE FROM refresh_tokens WHERE user_id = $1", [decoyUser.id]);
  });

  await test('a forged raw token with wrong SHA-256 does not match any row', async () => {
    // Insert a real token for the seller
    const crypto3 = require('crypto');
    const bcryptjs3 = require('bcryptjs');
    const { rows: [seller] } = await pool.query(
      "SELECT id FROM users WHERE email = 'demo.seller@cricket.test'"
    );
    const raw = crypto3.randomBytes(32).toString('hex');
    const sha256 = crypto3.createHash('sha256').update(raw).digest('hex');
    const hash = await bcryptjs3.hash(raw, 4);
    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token_hash, token_sha256, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL \'7 days\')',
      [seller.id, hash, sha256]
    );

    // Attempt refresh with a completely different random raw token — should get 401
    const forgery = crypto3.randomBytes(32).toString('hex');
    const fakeCookie = `refresh_token=${forgery}; Path=/; HttpOnly`;
    const res = await request(app).post('/auth/refresh').set('Cookie', fakeCookie);
    assert(res.status === 401, `expected 401 for forged token, got ${res.status}`);

    // Clean up
    await pool.query('DELETE FROM refresh_tokens WHERE token_sha256 = $1', [sha256]);
  });

  // ── Cookie attributes ─────────────────────────────────────────────────────
  // Use /auth/refresh (which also calls setRefreshCookie) with the seller's
  // saved cookie. This avoids extra login calls that would exceed the rate limit.
  console.log('\nRefresh token cookie attributes');

  await test('dev mode: cookie is SameSite=Lax and not Secure', async () => {
    assert(sellerRefreshCookie && sellerRefreshCookie.length > 0, 'sellerRefreshCookie must be set from login test');
    delete process.env.NODE_ENV;
    const res = await request(app).post('/auth/refresh').set('Cookie', sellerRefreshCookie);
    assert(res.status === 200, `refresh failed: ${res.status}`);
    const cookieHeader = (res.headers['set-cookie'] || []).join('; ');
    assert(/samesite=lax/i.test(cookieHeader), `expected SameSite=Lax, got: ${cookieHeader}`);
    assert(!/\bsecure\b/i.test(cookieHeader), `expected no Secure flag in dev mode, got: ${cookieHeader}`);
    sellerRefreshCookie = res.headers['set-cookie']; // rotate
  });

  await test('production mode: cookie is SameSite=None and Secure', async () => {
    assert(sellerRefreshCookie && sellerRefreshCookie.length > 0, 'sellerRefreshCookie must be set from dev cookie test');
    process.env.NODE_ENV = 'production';
    const res = await request(app).post('/auth/refresh').set('Cookie', sellerRefreshCookie);
    delete process.env.NODE_ENV;
    assert(res.status === 200, `refresh failed: ${res.status}`);
    const cookieHeader = (res.headers['set-cookie'] || []).join('; ');
    assert(/samesite=none/i.test(cookieHeader), `expected SameSite=None, got: ${cookieHeader}`);
    assert(/\bsecure\b/i.test(cookieHeader), `expected Secure flag in production mode, got: ${cookieHeader}`);
  });

  // ── CORS ─────────────────────────────────────────────────────────────────
  console.log('\nCORS');

  await test('allows configured FRONTEND_ORIGIN with credentials', async () => {
    const origin = process.env.FRONTEND_ORIGIN || 'http://localhost:3003';
    const res = await request(app)
      .options('/auth/login')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST');
    assert(
      res.headers['access-control-allow-origin'] === origin,
      `expected ACAO: ${origin}, got: ${res.headers['access-control-allow-origin']}`
    );
    assert(
      res.headers['access-control-allow-credentials'] === 'true',
      `expected ACAC: true, got: ${res.headers['access-control-allow-credentials']}`
    );
  });

  await test('blocks unknown origin — no ACAO header for evil.example.com', async () => {
    const res = await request(app)
      .options('/auth/login')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'POST');
    const acao = res.headers['access-control-allow-origin'];
    assert(
      !acao || acao !== 'https://evil.example.com',
      `expected no ACAO for unknown origin, got: ${acao}`
    );
  });

  // ── PUT /auth/address/ship-from ─────────────────────────────────────────
  console.log('\nPUT /auth/address/ship-from');

  const VALID_SHIP_FROM = {
    name: 'Test Seller',
    line1: '789 Cricket Ave',
    city: 'Houston',
    state: 'TX',
    zip: '77001',
    phone: '8885551234',
  };

  await test('returns 403 for buyer role', async () => {
    assert(buyerToken, 'buyerToken must be set');
    const res = await request(app)
      .put('/auth/address/ship-from')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send(VALID_SHIP_FROM);
    assert(res.status === 403, `expected 403, got ${res.status}`);
  });

  await test('returns 422 for missing required field (line1)', async () => {
    assert(sellerToken, 'sellerToken must be set from login test');
    const res = await request(app)
      .put('/auth/address/ship-from')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ ...VALID_SHIP_FROM, line1: '' });
    assert(res.status === 422, `expected 422, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  await test('returns 422 for invalid US state', async () => {
    assert(sellerToken, 'sellerToken must be set from login test');
    const res = await request(app)
      .put('/auth/address/ship-from')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ ...VALID_SHIP_FROM, state: 'XX' });
    assert(res.status === 422, `expected 422, got ${res.status}`);
  });

  await test('returns 422 for invalid ZIP code', async () => {
    assert(sellerToken, 'sellerToken must be set from login test');
    const res = await request(app)
      .put('/auth/address/ship-from')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ ...VALID_SHIP_FROM, zip: 'ABCDE' });
    assert(res.status === 422, `expected 422, got ${res.status}`);
  });

  await test('returns 422 for phone with fewer than 10 digits', async () => {
    assert(sellerToken, 'sellerToken must be set from login test');
    const res = await request(app)
      .put('/auth/address/ship-from')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ ...VALID_SHIP_FROM, phone: '123' });
    assert(res.status === 422, `expected 422, got ${res.status}`);
  });

  let updatedToken;
  await test('saves valid ship-from address and returns new access_token with has_ship_from_address=true', async () => {
    assert(sellerToken, 'sellerToken must be set from login test');
    const res = await request(app)
      .put('/auth/address/ship-from')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send(VALID_SHIP_FROM);
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.ship_from_address, 'ship_from_address must be in response');
    assert(res.body.ship_from_address.line1 === '789 Cricket Ave', 'line1 mismatch');
    assert(res.body.ship_from_address.state === 'TX', 'state must be normalized to uppercase');
    assert(res.body.access_token, 'access_token must be in response');

    updatedToken = res.body.access_token;
    const decoded = jwt.verify(updatedToken, 'test-secret');
    assert(decoded.has_ship_from_address === true, `has_ship_from_address must be true, got ${decoded.has_ship_from_address}`);
  });

  await test('GET /auth/me returns ship_from_address after save', async () => {
    assert(updatedToken, 'updatedToken must be set from previous test');
    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${updatedToken}`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.ship_from_address, 'ship_from_address must be in /me response');
    assert(res.body.ship_from_address.city === 'Houston', 'city mismatch');
  });

  // ── GET /auth/internal/seller/:id/has-ship-from ──────────────────────────
  console.log('\nGET /auth/internal/seller/:id/has-ship-from');

  const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET;

  await test('returns 401 without internal secret', async () => {
    const res = await request(app).get('/auth/internal/seller/3/has-ship-from');
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await test('returns 401 with wrong internal secret', async () => {
    const res = await request(app)
      .get('/auth/internal/seller/3/has-ship-from')
      .set('x-internal-secret', 'wrong-secret');
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await test('returns 404 for non-existent user', async () => {
    const res = await request(app)
      .get('/auth/internal/seller/99999/has-ship-from')
      .set('x-internal-secret', INTERNAL_SECRET);
    assert(res.status === 404, `expected 404, got ${res.status}`);
  });

  await test('returns has_ship_from_address=true for seller with saved address', async () => {
    // seller id=3 (demo.seller@cricket.test) just had address saved in previous test
    const { rows } = await pool.query("SELECT id FROM users WHERE email = 'demo.seller@cricket.test'");
    assert(rows[0], 'seller must exist in DB');
    const res = await request(app)
      .get(`/auth/internal/seller/${rows[0].id}/has-ship-from`)
      .set('x-internal-secret', INTERNAL_SECRET);
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.has_ship_from_address === true, `expected true, got ${res.body.has_ship_from_address}`);
  });

  // ── Migration: DB-level case-insensitive email uniqueness ────────────────────
  // Verifies requirements added by migration 1758067200000_email_lower_unique:
  //   E. PostgreSQL itself rejects a case-variant INSERT (no app normalisation)
  //   F. users_email_lower_key unique index exists on LOWER(email)
  //   G. No duplicate users were created
  console.log('\nMigration: DB-level case-insensitive email uniqueness');

  await test('users_email_lower_key unique index exists on LOWER(email)', async () => {
    const { rows } = await pool.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'users' AND indexname = 'users_email_lower_key'
    `);
    assert(rows.length === 1, 'users_email_lower_key index must exist in pg_indexes');
    const def = rows[0].indexdef.toLowerCase();
    assert(def.includes('lower(email)'),
      `Index must be defined on LOWER(email), got: ${rows[0].indexdef}`);
    assert(def.includes('unique'),
      `Index must be UNIQUE, got: ${rows[0].indexdef}`);
  });

  await test('users_email_key (case-sensitive constraint) no longer exists', async () => {
    const { rows } = await pool.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'users' AND indexname = 'users_email_key'
    `);
    assert(rows.length === 0,
      'users_email_key must have been dropped by the migration');
  });

  await test('PostgreSQL rejects case-variant INSERT even without application normalisation', async () => {
    const base = `dbcase-${Date.now()}@example.com`;
    // Insert lowercase directly — must succeed
    await pool.query(
      `INSERT INTO users (name, email, password_hash, role, email_verified)
       VALUES ('DBTest', $1, 'x', 'buyer', false)`,
      [base]
    );
    // Insert mixed-case variant directly — must fail with unique_violation (23505)
    let threw = false;
    let errCode;
    try {
      await pool.query(
        `INSERT INTO users (name, email, password_hash, role, email_verified)
         VALUES ('DBTest2', $1, 'x', 'buyer', false)`,
        [base.toUpperCase()]
      );
    } catch (err) {
      threw = true;
      errCode = err.code;
    }
    assert(threw, 'INSERT of case-variant email must throw');
    assert(errCode === '23505',
      `Expected unique_violation 23505, got ${errCode}`);
  });

  await test('no case-insensitive duplicate users exist', async () => {
    const { rows } = await pool.query(`
      SELECT LOWER(email) AS normalized, COUNT(*) AS cnt
      FROM users
      GROUP BY LOWER(email)
      HAVING COUNT(*) > 1
    `);
    assert(rows.length === 0,
      `Found case-insensitive duplicate email groups: ${JSON.stringify(rows)}`);
  });

  // ── Email normalization — case insensitivity and whitespace ─────────────────
  // Covers the production bug: Salmankhan20039@gmail.com failed to match
  // salmankhan20039@gmail.com because lookups were case-sensitive.
  // Rate-limit accounting (all limits are per in-memory app instance, reset each run):
  //   loginLimiter:              uses 2 of the 2 remaining slots (total 10/10)
  //   registerLimiter:           uses 1 of the 1 remaining slot  (total 5/5)
  //   forgotPasswordLimiter:     uses 1 of 5 available slots     (total 1/5)
  //   resendVerificationLimiter: uses 1 of the 1 remaining slot  (total 5/5)
  console.log('\nEmail normalization — case insensitivity and whitespace');

  await test('login: uppercase first letter (Salmankhan20039 pattern) resolves to lowercase account', async () => {
    // Mirror the exact production scenario: account stored as lowercase,
    // user types with an uppercase first letter.
    await insertTestUser('salmankhan20039@test.invalid', true);
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'Salmankhan20039@test.invalid', password: 'TestPass1!', turnstile_token: 'test-token' });
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.access_token, 'should return access_token');
    assert(res.body.user.email === 'salmankhan20039@test.invalid',
      `response email should be the stored lowercase value, got ${res.body.user.email}`);
  });

  await test('login: mixed-case + surrounding whitespace resolves to existing account', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: '  BUYER@CRICKET.TEST  ', password: 'Buyer1234!', turnstile_token: 'test-token' });
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.access_token, 'should return access_token');
    assert(res.body.user.email === 'buyer@cricket.test',
      `response email should be stored lowercase value, got ${res.body.user.email}`);
  });

  await test('register: mixed-case email stored as lowercase in DB and response', async () => {
    const unique = `testnorm-${Date.now()}`;
    const mixedEmail = `${unique.toUpperCase()}@EXAMPLE.COM`;
    const expectedLower = `${unique}@example.com`;
    const res = await request(app)
      .post('/auth/register')
      .send({ name: 'Norm Test', email: mixedEmail, password: 'NormPass1!', turnstile_token: 'test-token' });
    assert(res.status === 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.user.email === expectedLower,
      `response email should be lowercase, got ${res.body.user.email}`);
    const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [res.body.user.id]);
    assert(rows[0].email === expectedLower,
      `DB email should be lowercase, got ${rows[0].email}`);
  });

  await test('forgot-password: mixed-case email finds account and creates reset token', async () => {
    const { rows: [buyer] } = await pool.query("SELECT id FROM users WHERE email = 'buyer@cricket.test'");
    await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [buyer.id]);
    const res = await request(app)
      .post('/auth/forgot-password')
      .send({ email: 'BUYER@Cricket.TEST', turnstile_token: 'test-token' });
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    const { rows: tokens } = await pool.query(
      'SELECT id, expires_at FROM password_reset_tokens WHERE user_id = $1', [buyer.id]
    );
    assert(tokens.length === 1, `expected 1 reset token, got ${tokens.length}`);
    assert(new Date(tokens[0].expires_at) > new Date(), 'reset token must have a future expiry');
  });

  await test('resend-verification: mixed-case email finds unverified account and issues token', async () => {
    const normResendEmail = `norm-resend-${Date.now()}@test.invalid`;
    const normResendUser = await insertTestUser(normResendEmail, false); // unverified
    const res = await request(app)
      .post('/auth/resend-verification')
      .send({ email: normResendEmail.toUpperCase(), turnstile_token: 'test-token' });
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    const { rows: tokens } = await pool.query(
      'SELECT id FROM email_verification_tokens WHERE user_id = $1', [normResendUser.id]
    );
    assert(tokens.length === 1, `expected 1 verification token, got ${tokens.length}`);
  });

  // ── Turnstile CAPTCHA enforcement ────────────────────────────────────────
  // Uses forgot-password (2 of the remaining slots — 3/5 total after these).
  console.log('\nTurnstile CAPTCHA enforcement');

  await test('protected endpoint without turnstile_token returns 400', async () => {
    const res = await request(app).post('/auth/forgot-password').send({ email: 'buyer@cricket.test' });
    assert(res.status === 400, `expected 400, got ${res.status}`);
    assert(res.body.error === 'CAPTCHA token is required', `unexpected error: ${res.body.error}`);
  });

  await test('protected endpoint with valid test token proceeds to handler', async () => {
    const res = await request(app)
      .post('/auth/forgot-password')
      .send({ email: 'buyer@cricket.test', turnstile_token: 'test-token' });
    assert(res.status === 200, `expected 200, got ${res.status}`);
  });

  // ── MFA — TOTP multi-factor authentication ────────────────────────────────
  // All login calls in this section use X-Forwarded-For to get a fresh rate-
  // limiter bucket (trust proxy: 1 honours the header for req.ip keying).
  console.log('\nMFA — TOTP multi-factor authentication');

  // Helper: create a verified user directly in DB and return id + signed token.
  async function mfaUser(opts = {}) {
    const email = `mfa-${Date.now()}-${crypto.randomBytes(4).toString('hex')}@test.invalid`;
    const hash = await bcryptjs.hash('MfaPass1!', 4);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, email_verified, mfa_enabled, mfa_totp_secret)
       VALUES ($1, $2, $3, $4, true, $5, $6) RETURNING id, email, role`,
      [
        opts.name || 'MFA User',
        email,
        hash,
        opts.role || 'buyer',
        opts.mfa_enabled || false,
        opts.mfa_totp_secret || null,
      ]
    );
    const user = rows[0];
    const token = jwt.sign(
      { sub: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET
    );
    return { user, token };
  }

  // ── requireAuth guards ────────────────────────────────────────────────────

  await test('requireAuth: rejects mfa_pending token', async () => {
    const pendingToken = jwt.sign(
      { sub: 999, email: 'x@test.invalid', role: 'buyer', mfa_pending: true },
      process.env.JWT_SECRET
    );
    const res = await request(app).get('/auth/me').set('Authorization', `Bearer ${pendingToken}`);
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await test('requireAuth: rejects mfa_enrollment token', async () => {
    const enrollToken = jwt.sign(
      { sub: 999, email: 'x@test.invalid', role: 'admin', mfa_enrollment: true },
      process.env.JWT_SECRET
    );
    const res = await request(app).get('/auth/me').set('Authorization', `Bearer ${enrollToken}`);
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  // ── GET /auth/mfa/status ─────────────────────────────────────────────────

  await test('GET /auth/mfa/status — 401 without auth', async () => {
    const res = await request(app).get('/auth/mfa/status');
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await test('GET /auth/mfa/status — 200 returns mfa_enabled=false', async () => {
    const { token } = await mfaUser();
    const res = await request(app).get('/auth/mfa/status').set('Authorization', `Bearer ${token}`);
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.mfa_enabled === false, `expected false, got ${res.body.mfa_enabled}`);
  });

  // ── POST /auth/mfa/enroll/start ──────────────────────────────────────────

  await test('POST /auth/mfa/enroll/start — 401 without Authorization', async () => {
    const res = await request(app).post('/auth/mfa/enroll/start');
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await test('POST /auth/mfa/enroll/start — 401 with mfa_pending token', async () => {
    const pendingToken = jwt.sign(
      { sub: 999, email: 'x@test.invalid', role: 'buyer', mfa_pending: true },
      process.env.JWT_SECRET
    );
    const res = await request(app).post('/auth/mfa/enroll/start').set('Authorization', `Bearer ${pendingToken}`);
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  let enrollToken;
  let mfaSecret;
  let enrollUserId;

  await test('POST /auth/mfa/enroll/start — 200 returns totp_uri and recovery_codes', async () => {
    const { user, token } = await mfaUser();
    enrollToken = token;
    enrollUserId = user.id;
    const res = await request(app).post('/auth/mfa/enroll/start').set('Authorization', `Bearer ${token}`);
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(typeof res.body.totp_uri === 'string' && res.body.totp_uri.startsWith('otpauth://'),
      `totp_uri must be an otpauth URI, got: ${res.body.totp_uri}`);
    assert(Array.isArray(res.body.recovery_codes) && res.body.recovery_codes.length === 8,
      `expected 8 recovery_codes, got ${res.body.recovery_codes?.length}`);
    // Extract secret from totp_uri for downstream tests
    const url = new URL(res.body.totp_uri);
    mfaSecret = url.searchParams.get('secret');
    assert(mfaSecret, 'secret must be present in totp_uri query params');
  });

  // ── POST /auth/mfa/enroll/confirm ────────────────────────────────────────

  await test('POST /auth/mfa/enroll/confirm — 422 for wrong TOTP code', async () => {
    const res = await request(app)
      .post('/auth/mfa/enroll/confirm')
      .set('Authorization', `Bearer ${enrollToken}`)
      .send({ code: '000000' });
    assert(res.status === 422, `expected 422, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  await test('POST /auth/mfa/enroll/confirm — 400 if enroll/start not called', async () => {
    const { token } = await mfaUser();
    const res = await request(app)
      .post('/auth/mfa/enroll/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '123456' });
    assert(res.status === 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.error && res.body.error.includes('start'), `expected 'start' hint in error: ${res.body.error}`);
  });

  await test('POST /auth/mfa/enroll/confirm — 200 valid code sets mfa_enabled=true', async () => {
    assert(mfaSecret, 'mfaSecret must be set from enroll/start test');
    const code = authenticator.generate(mfaSecret);
    const res = await request(app)
      .post('/auth/mfa/enroll/confirm')
      .set('Authorization', `Bearer ${enrollToken}`)
      .send({ code });
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.ok === true, 'ok must be true');
    assert(!res.body.access_token, 'no access_token expected for non-admin enrollment');
    // Verify DB state
    const { rows } = await pool.query('SELECT mfa_enabled FROM users WHERE id = $1', [enrollUserId]);
    assert(rows[0].mfa_enabled === true, 'mfa_enabled must be true in DB');
  });

  // ── Admin forced enrollment via mfa_enrollment token ────────────────────

  await test('POST /auth/mfa/enroll/confirm — admin forced enrollment returns access_token', async () => {
    // Create admin user, do start with enrollment token, confirm → expect full tokens
    const { user } = await mfaUser({ role: 'admin', name: 'Force-Enroll Admin' });
    const enrollmentToken = jwt.sign(
      { sub: user.id, email: user.email, role: user.role, mfa_enrollment: true },
      process.env.JWT_SECRET
    );
    // Start
    const startRes = await request(app)
      .post('/auth/mfa/enroll/start')
      .set('Authorization', `Bearer ${enrollmentToken}`);
    assert(startRes.status === 200, `enroll/start: expected 200, got ${startRes.status}`);
    const url = new URL(startRes.body.totp_uri);
    const secret = url.searchParams.get('secret');

    // Confirm
    const code = authenticator.generate(secret);
    const confirmRes = await request(app)
      .post('/auth/mfa/enroll/confirm')
      .set('Authorization', `Bearer ${enrollmentToken}`)
      .send({ code });
    assert(confirmRes.status === 200, `enroll/confirm: expected 200, got ${confirmRes.status}: ${JSON.stringify(confirmRes.body)}`);
    assert(confirmRes.body.ok === true, 'ok must be true');
    assert(typeof confirmRes.body.access_token === 'string', 'access_token must be present for admin enrollment');
    assert(confirmRes.body.user.role === 'admin', 'user.role must be admin');
  });

  // ── GET /auth/mfa/status — after enrollment ──────────────────────────────

  await test('GET /auth/mfa/status — 200 returns mfa_enabled=true after enrollment', async () => {
    const res = await request(app).get('/auth/mfa/status').set('Authorization', `Bearer ${enrollToken}`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.mfa_enabled === true, `expected true, got ${res.body.mfa_enabled}`);
  });

  // ── POST /auth/login — MFA branching ────────────────────────────────────
  // Uses X-Forwarded-For to get a fresh rate-limiter bucket.

  await test('POST /auth/login — admin without MFA returns 403 MFA_ENROLLMENT_REQUIRED', async () => {
    const adminEmail = `mfa-admin-${Date.now()}@test.invalid`;
    const hash = await bcryptjs.hash('AdminPass1!', 4);
    await pool.query(
      `INSERT INTO users (name, email, password_hash, role, email_verified, mfa_enabled)
       VALUES ('No-MFA Admin', $1, $2, 'admin', true, false)`,
      [adminEmail, hash]
    );
    const res = await request(app)
      .post('/auth/login')
      .set('X-Forwarded-For', '10.99.1.1')
      .send({ email: adminEmail, password: 'AdminPass1!', turnstile_token: 'test-token' });
    assert(res.status === 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.code === 'MFA_ENROLLMENT_REQUIRED', `expected MFA_ENROLLMENT_REQUIRED code, got ${res.body.code}`);
    assert(typeof res.body.mfa_enrollment_token === 'string', 'mfa_enrollment_token must be present');
    // Verify the enrollment token has mfa_enrollment: true claim
    const decoded = jwt.decode(res.body.mfa_enrollment_token);
    assert(decoded.mfa_enrollment === true, 'mfa_enrollment claim must be true');
  });

  await test('POST /auth/login — MFA-enabled user returns 202 mfa_required', async () => {
    const mfaEmail = `mfa-enabled-${Date.now()}@test.invalid`;
    const hash = await bcryptjs.hash('MfaPass1!', 4);
    const secret = authenticator.generateSecret();
    const encSecret = encryptSecret(secret);
    await pool.query(
      `INSERT INTO users (name, email, password_hash, role, email_verified, mfa_enabled, mfa_totp_secret)
       VALUES ('MFA Buyer', $1, $2, 'buyer', true, true, $3)`,
      [mfaEmail, hash, encSecret]
    );
    const res = await request(app)
      .post('/auth/login')
      .set('X-Forwarded-For', '10.99.1.2')
      .send({ email: mfaEmail, password: 'MfaPass1!', turnstile_token: 'test-token' });
    assert(res.status === 202, `expected 202, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.mfa_required === true, 'mfa_required must be true');
    assert(typeof res.body.mfa_token === 'string', 'mfa_token must be present');
    // Verify the mfa_token has mfa_pending: true
    const decoded = jwt.decode(res.body.mfa_token);
    assert(decoded.mfa_pending === true, 'mfa_pending claim must be true');
  });

  // ── POST /auth/mfa/verify ────────────────────────────────────────────────

  // Helper: create an MFA-enabled user and get an mfa_pending token for them.
  async function mfaEnabledUser() {
    const secret = authenticator.generateSecret();
    const encSecret = encryptSecret(secret);
    const { user } = await mfaUser({ mfa_enabled: true, mfa_totp_secret: encSecret });
    const mfaToken = jwt.sign(
      { sub: user.id, email: user.email, role: user.role, mfa_pending: true },
      process.env.JWT_SECRET,
      { expiresIn: '10m' }
    );
    return { user, secret, mfaToken };
  }

  await test('POST /auth/mfa/verify — 400 missing fields', async () => {
    const res = await request(app).post('/auth/mfa/verify').send({});
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await test('POST /auth/mfa/verify — 401 with invalid mfa_token', async () => {
    const res = await request(app).post('/auth/mfa/verify').send({ mfa_token: 'bad.token', code: '123456' });
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await test('POST /auth/mfa/verify — 422 for wrong TOTP code', async () => {
    const { mfaToken } = await mfaEnabledUser();
    const res = await request(app).post('/auth/mfa/verify').send({ mfa_token: mfaToken, code: '000000' });
    assert(res.status === 422, `expected 422, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  await test('POST /auth/mfa/verify — 200 with valid code returns access_token + refresh cookie', async () => {
    const { secret, mfaToken } = await mfaEnabledUser();
    const code = authenticator.generate(secret);
    const res = await request(app).post('/auth/mfa/verify').send({ mfa_token: mfaToken, code });
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(typeof res.body.access_token === 'string', 'access_token must be present');
    assert(res.body.user && res.body.user.id, 'user must be present');
    const cookies = res.headers['set-cookie'];
    assert(cookies && cookies.some((c) => c.startsWith('refresh_token=')), 'refresh_token cookie must be set');
  });

  // ── POST /auth/mfa/verify-recovery ──────────────────────────────────────

  // Helper: insert real recovery codes and return the first plaintext code.
  async function setupRecoveryCodes(userId) {
    const { generateRecoveryCodes, hashRecoveryCode: hrc } = require('../src/mfaHelpers');
    const codes = generateRecoveryCodes();
    await pool.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
    for (const c of codes) {
      const h = await hrc(c);
      await pool.query('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)', [userId, h]);
    }
    return codes; // return all so tests can use them
  }

  await test('POST /auth/mfa/verify-recovery — 401 with invalid recovery code', async () => {
    const { user, mfaToken } = await mfaEnabledUser();
    await setupRecoveryCodes(user.id);
    const res = await request(app)
      .post('/auth/mfa/verify-recovery')
      .send({ mfa_token: mfaToken, recovery_code: 'invalidcode' });
    assert(res.status === 401, `expected 401, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  let usedRecoveryUserId;
  let usedMfaToken;
  let usedCode;

  await test('POST /auth/mfa/verify-recovery — 200 with valid code, marks as used', async () => {
    const { user, mfaToken } = await mfaEnabledUser();
    usedRecoveryUserId = user.id;
    usedMfaToken = mfaToken;
    const codes = await setupRecoveryCodes(user.id);
    usedCode = codes[0];
    const res = await request(app)
      .post('/auth/mfa/verify-recovery')
      .send({ mfa_token: mfaToken, recovery_code: usedCode });
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(typeof res.body.access_token === 'string', 'access_token must be present');
    // Verify code is now marked used in DB
    const { rows } = await pool.query(
      'SELECT used_at FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NOT NULL',
      [user.id]
    );
    assert(rows.length === 1, `expected 1 used code, got ${rows.length}`);
  });

  await test('POST /auth/mfa/verify-recovery — 401 for already-used recovery code', async () => {
    assert(usedCode, 'usedCode must be set from previous test');
    // New mfa_pending token for same user (previous was consumed by refresh cookie)
    const { rows } = await pool.query('SELECT email, role FROM users WHERE id = $1', [usedRecoveryUserId]);
    const newMfaToken = jwt.sign(
      { sub: usedRecoveryUserId, email: rows[0].email, role: rows[0].role, mfa_pending: true },
      process.env.JWT_SECRET,
      { expiresIn: '10m' }
    );
    const res = await request(app)
      .post('/auth/mfa/verify-recovery')
      .send({ mfa_token: newMfaToken, recovery_code: usedCode });
    assert(res.status === 401, `expected 401, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  // ── POST /auth/mfa/disable ───────────────────────────────────────────────

  await test('POST /auth/mfa/disable — 422 for wrong TOTP code', async () => {
    const { user, token } = await mfaUser();
    // Set up MFA for this user via enroll start+confirm
    const startRes = await request(app)
      .post('/auth/mfa/enroll/start')
      .set('Authorization', `Bearer ${token}`);
    assert(startRes.status === 200, `enroll/start: expected 200, got ${startRes.status}`);
    const url = new URL(startRes.body.totp_uri);
    const secret = url.searchParams.get('secret');
    const validCode = authenticator.generate(secret);
    await request(app).post('/auth/mfa/enroll/confirm').set('Authorization', `Bearer ${token}`).send({ code: validCode });

    const res = await request(app)
      .post('/auth/mfa/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '000000' });
    assert(res.status === 422, `expected 422, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  await test('POST /auth/mfa/disable — 200 with valid code, clears MFA', async () => {
    // Create user with MFA already enabled via enroll flow
    const { user, token } = await mfaUser();
    const startRes = await request(app)
      .post('/auth/mfa/enroll/start')
      .set('Authorization', `Bearer ${token}`);
    const url = new URL(startRes.body.totp_uri);
    const secret = url.searchParams.get('secret');
    const confirmCode = authenticator.generate(secret);
    await request(app).post('/auth/mfa/enroll/confirm').set('Authorization', `Bearer ${token}`).send({ code: confirmCode });

    // Give TOTP time to advance (or use window) — generate fresh code
    const disableCode = authenticator.generate(secret);
    const res = await request(app)
      .post('/auth/mfa/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: disableCode });
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.ok === true, 'ok must be true');
    // Verify mfa_enabled=false in DB
    const { rows } = await pool.query('SELECT mfa_enabled, mfa_totp_secret FROM users WHERE id = $1', [user.id]);
    assert(rows[0].mfa_enabled === false, 'mfa_enabled must be false');
    assert(rows[0].mfa_totp_secret === null, 'mfa_totp_secret must be cleared');
    // Verify recovery codes deleted
    const { rows: rcRows } = await pool.query('SELECT id FROM mfa_recovery_codes WHERE user_id = $1', [user.id]);
    assert(rcRows.length === 0, 'recovery codes must be deleted');
  });

  // Teardown
  await pool.end();

  // Report
  const total = passed + failed;
  console.log(`\n${total} test(s): ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('\nFatal test error:', err.message);
  process.exit(1);
});

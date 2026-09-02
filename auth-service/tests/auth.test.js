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
// Clear Stripe keys so tests run in stub mode (no real API calls)
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.ADMIN_JWT_SECRET;

const request = require('supertest');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { buildApp } = require('../src/app');
const crypto = require('crypto');
const bcryptjs = require('bcryptjs');

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
    email             TEXT        NOT NULL UNIQUE,
    password_hash     TEXT        NOT NULL,
    role              TEXT        NOT NULL DEFAULT 'buyer',
    stripe_account_id TEXT,
    email_verified    BOOLEAN     NOT NULL DEFAULT false,
    ship_from_address JSONB,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT users_role_check CHECK (role IN ('buyer','seller','admin'))
  );
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT        NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);

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
    const res = await request(app).post('/auth/register').send({ email: uniqueEmail() });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  let registeredEmail;
  await test('returns 201 with verification message for valid registration', async () => {
    // (2/5)
    registeredEmail = uniqueEmail();
    const res = await request(app)
      .post('/auth/register')
      .send({ name: 'Test User', email: registeredEmail, password: 'ValidPass1!' });
    assert(res.status === 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.message, 'should have a message');
    assert(res.body.user && res.body.user.id > 0, 'should return user with id');
    assert(res.body.user.role === 'buyer', 'default role should be buyer');
  });

  await test('returns 409 for duplicate email', async () => {
    // Two calls: first creates user (3/5), second is duplicate (4/5)
    const email = uniqueEmail();
    await request(app).post('/auth/register').send({ name: 'A', email, password: 'Pass1234!' });
    const res = await request(app).post('/auth/register').send({ name: 'B', email, password: 'Other1!' });
    assert(res.status === 409, `expected 409, got ${res.status}`);
    assert(res.body.error, 'should have error message');
  });

  // ── POST /auth/login — invalid credentials ────────────────────────────────
  console.log('\nPOST /auth/login — invalid credentials');

  await test('returns 401 for invalid password', async () => {
    const res = await request(app).post('/auth/login')
      .send({ email: 'buyer@cricket.test', password: 'WrongPassword!' });
    assert(res.status === 401, `expected 401, got ${res.status}`);
    assert(res.body.error === 'Invalid credentials', `unexpected error: ${res.body.error}`);
  });

  await test('returns 401 for non-existent email', async () => {
    const res = await request(app).post('/auth/login')
      .send({ email: 'nobody@nowhere.com', password: 'Whatever1!' });
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await test('returns 403 for unverified account', async () => {
    // Use the successfully registered (but unverified) user from the registration test above.
    // This avoids a 6th /auth/register call which would hit the rate limiter (max 5/hr).
    assert(registeredEmail, 'registeredEmail must be set from the registration test');
    const res = await request(app).post('/auth/login').send({ email: registeredEmail, password: 'ValidPass1!' });
    assert(res.status === 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  await test('returns 400 when fields are missing', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'a@b.com' });
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
    const res = await request(app).post('/auth/resend-verification').send({});
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await test('unknown email returns generic 200 without leaking existence', async () => {
    const res = await request(app)
      .post('/auth/resend-verification')
      .send({ email: 'nobody-resend@nowhere.invalid' });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.message, 'should have message');
  });

  await test('already-verified user returns generic 200 and no token is created', async () => {
    const res = await request(app)
      .post('/auth/resend-verification')
      .send({ email: 'buyer@cricket.test' });
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
      .send({ email: registeredEmail });
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
      .send({ email: 'buyer@cricket.test', password: 'Buyer1234!' });
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.access_token, 'should return access_token');
    assert(res.body.user.role === 'buyer', `expected buyer, got ${res.body.user.role}`);
    buyerToken = res.body.access_token;
    buyerRefreshCookie = res.headers['set-cookie'];
  });

  await test('seeded seller (demo.seller@cricket.test) can log in', async () => {
    const res = await request(app).post('/auth/login')
      .send({ email: 'demo.seller@cricket.test', password: 'Demo1234!' });
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.access_token, 'should return access_token');
    assert(res.body.user.role === 'seller', `expected seller, got ${res.body.user.role}`);
    sellerToken = res.body.access_token;
    sellerRefreshCookie = res.headers['set-cookie'];
  });

  await test('seeded admin (admin@cricket.test) can log in', async () => {
    const res = await request(app).post('/auth/login')
      .send({ email: 'admin@cricket.test', password: 'Admin1234!' });
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.access_token, 'should return access_token');
    assert(res.body.user.role === 'admin', `expected admin, got ${res.body.user.role}`);
    adminToken = res.body.access_token;
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
    assert(adminToken, 'adminToken must be set from login test');
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

// Listing-service integration tests against an isolated PostgreSQL database.
//
// Prerequisites:
//   1. Docker container running (docker-compose up listing-db)
//   2. listing_db_test database created (pg: CREATE DATABASE listing_db_test)
//   3. DATABASE_URL_TEST set (default: postgres://listing_user:listing_pass@localhost:5432/listing_db_test)
//
// Run: node tests/listings.test.js
'use strict';

// Set DATABASE_URL before any app module is required so that db.js
// creates its pool against the test database.
process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST ||
  'postgres://listing_user:listing_pass@localhost:5432/listing_db_test';
process.env.JWT_SECRET = 'test-secret';
// Deliberately different from JWT_SECRET to prove the two are independent.
process.env.INTERNAL_SERVICE_SECRET = 'test-internal-svc-secret-32chars!!';

const request = require('supertest');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { buildApp } = require('../src/app');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = buildApp();

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeToken(userId, role = 'user') {
  return jwt.sign({ sub: userId, role }, 'test-secret', { expiresIn: '1h' });
}

const SELLER_ID = 1000;
const OTHER_ID = 1001;
const sellerToken = makeToken(SELLER_ID);
const otherToken = makeToken(OTHER_ID);
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET; // 'test-internal-svc-secret-32chars!!'

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS listings (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    seller_id      BIGINT  NOT NULL,
    title          TEXT    NOT NULL,
    description    TEXT    NOT NULL DEFAULT '',
    price_cents    INTEGER NOT NULL,
    category       TEXT    NOT NULL DEFAULT 'other',
    condition      TEXT    NOT NULL DEFAULT 'used_good',
    status         TEXT    NOT NULL DEFAULT 'active',
    meta_title     TEXT,
    meta_description TEXT,
    tags           TEXT,
    quality_score  INTEGER,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT listings_category_check
      CHECK (category IN ('bat','helmet','pads','gloves','kit-bag','other')),
    CONSTRAINT listings_condition_check
      CHECK (condition IN ('new','used_good','used_fair')),
    CONSTRAINT listings_status_check
      CHECK (status IN ('active','sold','inactive'))
  );
  CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
  CREATE INDEX IF NOT EXISTS idx_listings_seller  ON listings(seller_id);
  CREATE TABLE IF NOT EXISTS listing_photos (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    listing_id    BIGINT  NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    filename      TEXT    NOT NULL,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

async function cleanup() {
  await pool.query(
    'TRUNCATE TABLE listing_photos, listings RESTART IDENTITY CASCADE'
  );
}

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

// ── Test suite ────────────────────────────────────────────────────────────────

async function run() {
  console.log('Listing service — PostgreSQL integration tests\n');

  await pool.query(SCHEMA_SQL);

  // POST /listings
  console.log('POST /listings');

  await cleanup();
  await test('creates a listing and returns it with an empty photos array', async () => {
    const res = await request(app)
      .post('/listings')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Gray-Nicolls Bat', price_cents: 9995, category: 'bat', condition: 'new', description: 'Top quality' });
    assert(res.status === 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.id > 0, 'id should be positive integer');
    assert(res.body.title === 'Gray-Nicolls Bat', 'title mismatch');
    assert(res.body.price_cents === 9995, 'price_cents mismatch');
    assert(res.body.status === 'active', 'status should default to active');
    assert(Array.isArray(res.body.photos) && res.body.photos.length === 0, 'photos should be empty array');
  });

  await cleanup();
  await test('returns 400 when title is missing', async () => {
    const res = await request(app)
      .post('/listings')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ price_cents: 1000 });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await cleanup();
  await test('returns 400 for non-positive price_cents', async () => {
    const res = await request(app)
      .post('/listings')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Bat', price_cents: 0 });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await cleanup();
  await test('returns 400 for invalid category', async () => {
    const res = await request(app)
      .post('/listings')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'X', price_cents: 500, category: 'shoes' });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await cleanup();
  await test('returns 401 when no auth token', async () => {
    const res = await request(app)
      .post('/listings')
      .send({ title: 'X', price_cents: 500 });
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  // GET /listings/:id
  console.log('\nGET /listings/:id');

  await cleanup();
  await test('returns listing with photos array', async () => {
    const create = await request(app)
      .post('/listings')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Helmet', price_cents: 2000, category: 'helmet', condition: 'used_good' });
    const { id } = create.body;
    const res = await request(app).get(`/listings/${id}`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.id === id, 'id mismatch');
    assert(Array.isArray(res.body.photos), 'photos should be array');
  });

  await cleanup();
  await test('returns 404 for nonexistent id', async () => {
    const res = await request(app).get('/listings/999999');
    assert(res.status === 404, `expected 404, got ${res.status}`);
  });

  // GET /listings (search + list)
  console.log('\nGET /listings');

  await cleanup();
  await test('returns only active listings', async () => {
    await request(app).post('/listings').set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Active Bat', price_cents: 1000, category: 'bat', condition: 'new' });
    const res = await request(app).get('/listings');
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.total >= 1, 'total should be at least 1');
    assert(Array.isArray(res.body.listings), 'listings should be array');
    assert(res.body.listings.every(l => l.status === 'active'), 'all listings should be active');
  });

  await cleanup();
  await test('filters by category', async () => {
    await request(app).post('/listings').set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'My Bat', price_cents: 1000, category: 'bat', condition: 'new' });
    await request(app).post('/listings').set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'My Helmet', price_cents: 2000, category: 'helmet', condition: 'new' });
    const res = await request(app).get('/listings?category=bat');
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.listings.length >= 1, 'should have at least 1 result');
    assert(res.body.listings.every(l => l.category === 'bat'), 'all returned should be bats');
  });

  await cleanup();
  await test('filters by price range', async () => {
    await request(app).post('/listings').set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Cheap', price_cents: 500, category: 'other', condition: 'new' });
    await request(app).post('/listings').set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Expensive', price_cents: 10000, category: 'other', condition: 'new' });
    const res = await request(app).get('/listings?min_price=400&max_price=1000');
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.listings.every(l => l.price_cents >= 400 && l.price_cents <= 1000), 'price range filter failed');
  });

  await cleanup();
  await test('paginates results', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app).post('/listings').set('Authorization', `Bearer ${sellerToken}`)
        .send({ title: `Bat ${i}`, price_cents: 1000, category: 'bat', condition: 'new' });
    }
    const res = await request(app).get('/listings?limit=2&page=1');
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.listings.length === 2, `expected 2 listings, got ${res.body.listings.length}`);
    assert(res.body.total === 5, `expected total=5, got ${res.body.total}`);
    assert(res.body.page === 1, 'page should be 1');
  });

  // GET /listings/mine
  console.log('\nGET /listings/mine');

  await cleanup();
  await test("returns only the caller's own listings", async () => {
    await request(app).post('/listings').set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Seller Bat', price_cents: 1000, category: 'bat', condition: 'new' });
    await request(app).post('/listings').set('Authorization', `Bearer ${otherToken}`)
      .send({ title: 'Other Bat', price_cents: 1500, category: 'bat', condition: 'new' });
    const res = await request(app).get('/listings/mine').set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.listings.every(l => String(l.seller_id) === String(SELLER_ID)), 'should only see own listings');
  });

  await cleanup();
  await test('includes sold and inactive listings for the owner', async () => {
    const create = await request(app).post('/listings').set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'My Bat', price_cents: 1000, category: 'bat', condition: 'new' });
    const id = create.body.id;
    await request(app).patch(`/listings/${id}/mark-sold`).set('x-internal-secret', INTERNAL_SECRET);
    const res = await request(app).get('/listings/mine').set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const soldListing = res.body.listings.find(l => l.id === id);
    assert(soldListing && soldListing.status === 'sold', 'sold listing should appear in mine');
  });

  // PATCH /listings/:id
  console.log('\nPATCH /listings/:id');

  await cleanup();
  await test('updates title and price_cents', async () => {
    const create = await request(app).post('/listings').set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Old Title', price_cents: 1000, category: 'bat', condition: 'new' });
    const id = create.body.id;
    const res = await request(app).patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'New Title', price_cents: 2500 });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.title === 'New Title', 'title should be updated');
    assert(res.body.price_cents === 2500, 'price_cents should be updated');
  });

  await cleanup();
  await test('returns 403 for non-owner update', async () => {
    const create = await request(app).post('/listings').set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'My Bat', price_cents: 1000, category: 'bat', condition: 'new' });
    const id = create.body.id;
    const res = await request(app).patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ title: 'Hijacked' });
    assert(res.status === 403, `expected 403, got ${res.status}`);
  });

  await cleanup();
  await test('returns 400 when no valid fields provided', async () => {
    const create = await request(app).post('/listings').set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'My Bat', price_cents: 1000, category: 'bat', condition: 'new' });
    const id = create.body.id;
    const res = await request(app).patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ unknown_field: 'x' });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  // Internal mark-sold / mark-active
  console.log('\nPATCH /listings/:id/mark-sold and mark-active');

  await cleanup();
  await test('mark-sold sets status=sold', async () => {
    const create = await request(app).post('/listings').set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'For Sale', price_cents: 5000, category: 'bat', condition: 'new' });
    const id = create.body.id;
    const res = await request(app).patch(`/listings/${id}/mark-sold`)
      .set('x-internal-secret', INTERNAL_SECRET);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.status === 'sold', 'status should be sold');
  });

  await cleanup();
  await test('mark-active restores status=active after sold', async () => {
    const create = await request(app).post('/listings').set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'For Sale', price_cents: 5000, category: 'bat', condition: 'new' });
    const id = create.body.id;
    await request(app).patch(`/listings/${id}/mark-sold`).set('x-internal-secret', INTERNAL_SECRET);
    const res = await request(app).patch(`/listings/${id}/mark-active`)
      .set('x-internal-secret', INTERNAL_SECRET);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.status === 'active', 'status should be active');
  });

  await cleanup();
  await test('mark-sold returns 401 without internal secret', async () => {
    const create = await request(app).post('/listings').set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'For Sale', price_cents: 5000, category: 'bat', condition: 'new' });
    const id = create.body.id;
    const res = await request(app).patch(`/listings/${id}/mark-sold`);
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  // Internal service auth — 5-scenario security matrix
  console.log('\nInternal service auth security');

  await cleanup();
  await test('correct INTERNAL_SERVICE_SECRET allows mark-sold', async () => {
    const create = await request(app).post('/listings').set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Auth Test Bat', price_cents: 7500, category: 'bat', condition: 'new' });
    const id = create.body.id;
    const res = await request(app).patch(`/listings/${id}/mark-sold`)
      .set('x-internal-secret', INTERNAL_SECRET);
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.status === 'sold', 'status should be sold');
  });

  await cleanup();
  await test('correct INTERNAL_SERVICE_SECRET allows mark-active', async () => {
    const create = await request(app).post('/listings').set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Auth Test Bat', price_cents: 7500, category: 'bat', condition: 'new' });
    const id = create.body.id;
    await request(app).patch(`/listings/${id}/mark-sold`).set('x-internal-secret', INTERNAL_SECRET);
    const res = await request(app).patch(`/listings/${id}/mark-active`)
      .set('x-internal-secret', INTERNAL_SECRET);
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.status === 'active', 'status should be active');
  });

  await cleanup();
  await test('missing x-internal-secret header is rejected with 401', async () => {
    const create = await request(app).post('/listings').set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Auth Test Bat', price_cents: 7500, category: 'bat', condition: 'new' });
    const id = create.body.id;
    const res = await request(app).patch(`/listings/${id}/mark-sold`);
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await cleanup();
  await test('incorrect x-internal-secret is rejected with 401', async () => {
    const create = await request(app).post('/listings').set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Auth Test Bat', price_cents: 7500, category: 'bat', condition: 'new' });
    const id = create.body.id;
    const res = await request(app).patch(`/listings/${id}/mark-sold`)
      .set('x-internal-secret', 'wrong-secret-value');
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await cleanup();
  await test('valid user JWT in x-internal-secret cannot replace INTERNAL_SERVICE_SECRET', async () => {
    const create = await request(app).post('/listings').set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Auth Test Bat', price_cents: 7500, category: 'bat', condition: 'new' });
    const id = create.body.id;
    // Passing a valid JWT token where an internal secret is expected must be rejected
    const res = await request(app).patch(`/listings/${id}/mark-sold`)
      .set('x-internal-secret', sellerToken);
    assert(res.status === 401, `expected 401, got ${res.status}: JWT must not substitute for INTERNAL_SERVICE_SECRET`);
  });

  await cleanup();
  await test('mismatched internal secrets (simulating different service configs) are rejected', async () => {
    const create = await request(app).post('/listings').set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Auth Test Bat', price_cents: 7500, category: 'bat', condition: 'new' });
    const id = create.body.id;
    // Simulate escrow-service configured with a different INTERNAL_SERVICE_SECRET
    const escrowServiceSecret = 'different-escrow-svc-secret-32chars!!';
    const res = await request(app).patch(`/listings/${id}/mark-sold`)
      .set('x-internal-secret', escrowServiceSecret);
    assert(res.status === 401, `expected 401 for mismatched service secrets, got ${res.status}`);
  });

  // DELETE /listings/:id
  console.log('\nDELETE /listings/:id');

  await cleanup();
  await test('soft-deletes by setting status=inactive', async () => {
    const create = await request(app).post('/listings').set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'To Delete', price_cents: 1000, category: 'bat', condition: 'new' });
    const id = create.body.id;
    const delRes = await request(app).delete(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(delRes.status === 200, `expected 200, got ${delRes.status}`);
    // Should not appear in public list
    const listRes = await request(app).get('/listings');
    assert(!listRes.body.listings.some(l => l.id === id), 'inactive listing should not appear in public list');
    // Should appear in /mine as inactive
    const mineRes = await request(app).get('/listings/mine').set('Authorization', `Bearer ${sellerToken}`);
    const mine = mineRes.body.listings.find(l => l.id === id);
    assert(mine && mine.status === 'inactive', 'deleted listing should show as inactive in /mine');
  });

  await cleanup();
  await test('returns 403 when non-owner tries to delete', async () => {
    const create = await request(app).post('/listings').set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'My Bat', price_cents: 1000, category: 'bat', condition: 'new' });
    const id = create.body.id;
    const res = await request(app).delete(`/listings/${id}`)
      .set('Authorization', `Bearer ${otherToken}`);
    assert(res.status === 403, `expected 403, got ${res.status}`);
  });

  // Teardown
  await pool.end();

  // Report
  const total = passed + failed;
  console.log(`\n${total} test(s): ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('\nFatal test setup error:', err.message);
  process.exit(1);
});

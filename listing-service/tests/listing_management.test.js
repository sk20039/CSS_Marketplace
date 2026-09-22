// Seller listing management integration tests — deactivate, reactivate, and
// permanent draft deletion, plus PATCH status rejection.
//
// Covers:
//   - PATCH rejects every status value (active, inactive, draft, sold, arbitrary)
//   - PATCH still updates content fields normally
//   - DELETE /:id (deactivate) only works for active; 409 for all other statuses
//   - POST /:id/reactivate success, wrong seller, wrong status, escrow sync failure,
//     concurrent race (one 200 one 409)
//   - DELETE /:id/permanent success with photo cleanup, wrong seller, wrong status,
//     concurrent deletion
//   - Public visibility: deactivated listing absent from search; reactivated returns
//
// Run: node tests/listing_management.test.js
'use strict';

process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST ||
  'postgres://listing_user:listing_pass@localhost:5432/listing_db_test';
process.env.JWT_SECRET = 'test-secret';
process.env.INTERNAL_SERVICE_SECRET = 'test-internal-svc-secret-32chars!!';

const http = require('http');
const path = require('path');
const fs = require('fs');
const request = require('supertest');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { buildApp } = require('../src/app');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = buildApp();

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeToken(userId, role = 'seller', has_ship_from_address = true) {
  return jwt.sign({ sub: userId, role, has_ship_from_address }, 'test-secret', { expiresIn: '1h' });
}

const SELLER_ID  = 3000;
const OTHER_ID   = 3001;
const sellerToken = makeToken(SELLER_ID);
const otherToken  = makeToken(OTHER_ID);

const PKG_DIMS = { weight_oz: 16, pkg_length_in: 30, pkg_width_in: 5, pkg_height_in: 3 };

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS listings (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    seller_id      BIGINT  NOT NULL,
    title          TEXT    NOT NULL,
    description    TEXT    NOT NULL DEFAULT '',
    price_cents    INTEGER,
    category       TEXT    NOT NULL DEFAULT 'other',
    condition      TEXT    NOT NULL DEFAULT 'used_good',
    status         TEXT    NOT NULL DEFAULT 'active',
    meta_title     TEXT,
    meta_description TEXT,
    tags           TEXT,
    quality_score  INTEGER,
    weight_oz      INTEGER,
    pkg_length_in  NUMERIC(5,1),
    pkg_width_in   NUMERIC(5,1),
    pkg_height_in  NUMERIC(5,1),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT listings_category_check
      CHECK (category IN ('bat','helmet','pads','gloves','kit-bag','other')),
    CONSTRAINT listings_condition_check
      CHECK (condition IN ('new','used_good','used_fair')),
    CONSTRAINT listings_status_check
      CHECK (status IN ('active','sold','inactive','draft'))
  );
  CREATE INDEX IF NOT EXISTS idx_lmgmt_status ON listings(status);
  CREATE INDEX IF NOT EXISTS idx_lmgmt_seller ON listings(seller_id);
  CREATE TABLE IF NOT EXISTS listing_photos (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    listing_id    BIGINT  NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    filename      TEXT    NOT NULL,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

async function setupSchema() {
  await pool.query(SCHEMA_SQL);
}

async function cleanup() {
  await pool.query('TRUNCATE listing_photos, listings RESTART IDENTITY CASCADE');
}

// Insert a listing directly with a specific status for setup.
async function insertListing(overrides = {}) {
  const defaults = {
    seller_id: SELLER_ID,
    title: 'Test Listing',
    price_cents: 5000,
    category: 'bat',
    condition: 'used_good',
    status: 'active',
    weight_oz: 16,
    pkg_length_in: 30,
    pkg_width_in: 5,
    pkg_height_in: 3,
  };
  const o = { ...defaults, ...overrides };
  const { rows } = await pool.query(
    `INSERT INTO listings
       (seller_id, title, price_cents, category, condition, status,
        weight_oz, pkg_length_in, pkg_width_in, pkg_height_in)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [o.seller_id, o.title, o.price_cents, o.category, o.condition, o.status,
     o.weight_oz, o.pkg_length_in, o.pkg_width_in, o.pkg_height_in]
  );
  return rows[0].id;
}

// Insert a photo record for a listing (file need not exist for most tests).
async function insertPhoto(listingId, filename) {
  const { rows } = await pool.query(
    'INSERT INTO listing_photos (listing_id, filename) VALUES ($1, $2) RETURNING id',
    [listingId, filename]
  );
  return rows[0].id;
}

// ── Mock escrow server ────────────────────────────────────────────────────────
// Controls what /api/sync/listing returns so reactivation tests can exercise
// success, failure, timeout, and call-count verification without a real escrow.

let mockEscrowBehavior = 'success'; // 'success' | 'fail' | 'hang'
let mockEscrowCallCount = 0;        // reset per test as needed
let mockEscrowServer;
let mockEscrowPort;

async function startMockEscrow() {
  return new Promise((resolve) => {
    mockEscrowServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/api/sync/listing') {
          mockEscrowCallCount++;
          if (mockEscrowBehavior === 'success') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else if (mockEscrowBehavior === 'fail') {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Escrow unavailable' }));
          } else if (mockEscrowBehavior === 'hang') {
            // Never respond — forces fetch to hit the AbortController timeout.
            // The socket is kept open; the test's timeout kills it via signal.
          }
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });
    mockEscrowServer.listen(0, '127.0.0.1', () => {
      mockEscrowPort = mockEscrowServer.address().port;
      resolve();
    });
  });
}

async function stopMockEscrow() {
  return new Promise((resolve, reject) => {
    mockEscrowServer.closeAllConnections?.();
    mockEscrowServer.close((err) => (err ? reject(err) : resolve()));
  });
}

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const errors = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (e) {
    failed++;
    errors.push({ name, message: e.message });
    process.stdout.write(`  ✗ ${name}: ${e.message}\n`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function runTests() {
  await setupSchema();
  await startMockEscrow();
  // Point the app at the mock escrow; read at request time so this takes effect.
  process.env.ESCROW_SERVICE_URL = `http://127.0.0.1:${mockEscrowPort}`;

  // ── PATCH: status rejection ──────────────────────────────────────────────

  process.stdout.write('\nPATCH status rejection\n');

  await test('rejects status=active', async () => {
    await cleanup();
    const id = await insertListing({ status: 'active' });
    const res = await request(app).patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ status: 'active', title: 'New Title' });
    assert(res.status === 400, `expected 400, got ${res.status}`);
    assert(res.body.error.includes('not allowed via PATCH'), res.body.error);
  });

  await test('rejects status=inactive', async () => {
    await cleanup();
    const id = await insertListing({ status: 'active' });
    const res = await request(app).patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ status: 'inactive' });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await test('rejects status=draft', async () => {
    await cleanup();
    const id = await insertListing({ status: 'active' });
    const res = await request(app).patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ status: 'draft' });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await test('rejects status=sold', async () => {
    await cleanup();
    const id = await insertListing({ status: 'active' });
    const res = await request(app).patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ status: 'sold' });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await test('rejects arbitrary status value', async () => {
    await cleanup();
    const id = await insertListing({ status: 'active' });
    const res = await request(app).patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ status: 'published' });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await test('still updates content fields when no status field is present', async () => {
    await cleanup();
    const id = await insertListing({ status: 'active' });
    const res = await request(app).patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Updated Title' });
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.title === 'Updated Title', 'title not updated');
    assert(res.body.status === 'active', 'status should not have changed');
  });

  // ── DELETE /:id (deactivate) ─────────────────────────────────────────────

  process.stdout.write('\nDELETE /:id (deactivate)\n');

  await test('active listing → 200, status becomes inactive', async () => {
    await cleanup();
    const id = await insertListing({ status: 'active' });
    const res = await request(app).delete(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.ok === true, 'expected ok: true');
    const { rows } = await pool.query('SELECT status FROM listings WHERE id = $1', [id]);
    assert(rows[0].status === 'inactive', 'DB status should be inactive');
  });

  await test('draft listing → 409', async () => {
    await cleanup();
    const id = await insertListing({ status: 'draft', price_cents: null });
    const res = await request(app).delete(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 409, `expected 409, got ${res.status}`);
  });

  await test('inactive listing → 409', async () => {
    await cleanup();
    const id = await insertListing({ status: 'inactive' });
    const res = await request(app).delete(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 409, `expected 409, got ${res.status}`);
  });

  await test('sold listing → 409', async () => {
    await cleanup();
    const id = await insertListing({ status: 'sold' });
    const res = await request(app).delete(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 409, `expected 409, got ${res.status}`);
  });

  await test('wrong seller → 403', async () => {
    await cleanup();
    const id = await insertListing({ status: 'active' });
    const res = await request(app).delete(`/listings/${id}`)
      .set('Authorization', `Bearer ${otherToken}`);
    assert(res.status === 403, `expected 403, got ${res.status}`);
  });

  await test('not found → 404', async () => {
    const res = await request(app).delete('/listings/999999')
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 404, `expected 404, got ${res.status}`);
  });

  // ── POST /:id/reactivate ─────────────────────────────────────────────────

  process.stdout.write('\nPOST /:id/reactivate\n');

  await test('inactive listing, sync succeeds → 200, status becomes active', async () => {
    await cleanup();
    mockEscrowBehavior = 'success';
    const id = await insertListing({ status: 'inactive' });
    const res = await request(app).post(`/listings/${id}/reactivate`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.ok === true, 'expected ok: true');
    assert(res.body.listing.status === 'active', 'listing should be active');
    const { rows } = await pool.query('SELECT status FROM listings WHERE id = $1', [id]);
    assert(rows[0].status === 'active', 'DB status should be active');
  });

  await test('active listing → 409', async () => {
    await cleanup();
    const id = await insertListing({ status: 'active' });
    const res = await request(app).post(`/listings/${id}/reactivate`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 409, `expected 409, got ${res.status}`);
  });

  await test('draft listing → 409', async () => {
    await cleanup();
    const id = await insertListing({ status: 'draft', price_cents: null });
    const res = await request(app).post(`/listings/${id}/reactivate`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 409, `expected 409, got ${res.status}`);
  });

  await test('sold listing → 409', async () => {
    await cleanup();
    const id = await insertListing({ status: 'sold' });
    const res = await request(app).post(`/listings/${id}/reactivate`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 409, `expected 409, got ${res.status}`);
  });

  await test('wrong seller → 403', async () => {
    await cleanup();
    const id = await insertListing({ status: 'inactive' });
    const res = await request(app).post(`/listings/${id}/reactivate`)
      .set('Authorization', `Bearer ${otherToken}`);
    assert(res.status === 403, `expected 403, got ${res.status}`);
    // Listing must remain inactive
    const { rows } = await pool.query('SELECT status FROM listings WHERE id = $1', [id]);
    assert(rows[0].status === 'inactive', 'status must remain inactive after 403');
  });

  await test('not found → 404', async () => {
    const res = await request(app).post('/listings/999999/reactivate')
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 404, `expected 404, got ${res.status}`);
  });

  await test('escrow sync fails → 502, listing stays inactive', async () => {
    await cleanup();
    mockEscrowBehavior = 'fail';
    const id = await insertListing({ status: 'inactive' });
    const res = await request(app).post(`/listings/${id}/reactivate`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 502, `expected 502, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.code === 'ESCROW_SYNC_FAILED', 'expected ESCROW_SYNC_FAILED code');
    // Critical: listing must still be inactive
    const { rows } = await pool.query('SELECT status FROM listings WHERE id = $1', [id]);
    assert(rows[0].status === 'inactive', 'listing must remain inactive after sync failure');
    mockEscrowBehavior = 'success';
  });

  await test('concurrent reactivation — exactly one 200, one 409', async () => {
    await cleanup();
    mockEscrowBehavior = 'success';
    const id = await insertListing({ status: 'inactive' });
    const [r1, r2] = await Promise.all([
      request(app).post(`/listings/${id}/reactivate`).set('Authorization', `Bearer ${sellerToken}`),
      request(app).post(`/listings/${id}/reactivate`).set('Authorization', `Bearer ${sellerToken}`),
    ]);
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    assert(statuses[0] === 200, `expected one 200, got ${statuses[0]} and ${statuses[1]}`);
    assert(statuses[1] === 409, `expected one 409, got ${statuses[0]} and ${statuses[1]}`);
    // DB must be active (not re-deactivated)
    const { rows } = await pool.query('SELECT status FROM listings WHERE id = $1', [id]);
    assert(rows[0].status === 'active', 'listing should be active after one winner reactivated it');
  });

  await test('incomplete listing (missing price) → 422, zero escrow calls', async () => {
    await cleanup();
    mockEscrowBehavior = 'success';
    mockEscrowCallCount = 0;
    // Insert an inactive listing with no price (fails validateListingForPublish)
    const id = await insertListing({ status: 'inactive', price_cents: null });
    const res = await request(app).post(`/listings/${id}/reactivate`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 422, `expected 422, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(Array.isArray(res.body.missing) && res.body.missing.includes('price_cents'),
      `missing should include price_cents, got: ${JSON.stringify(res.body.missing)}`);
    // Listing must remain inactive
    const { rows } = await pool.query('SELECT status FROM listings WHERE id = $1', [id]);
    assert(rows[0].status === 'inactive', 'listing must remain inactive after 422');
    // Escrow must not have been contacted
    assert(mockEscrowCallCount === 0, `escrow should not be called on validation failure, got ${mockEscrowCallCount} calls`);
  });

  await test('incomplete listing (missing all package dims) → 422, zero escrow calls', async () => {
    await cleanup();
    mockEscrowCallCount = 0;
    const id = await pool.query(
      `INSERT INTO listings (seller_id, title, price_cents, category, condition, status)
       VALUES ($1, 'NoDims Bat', 5000, 'bat', 'used_good', 'inactive') RETURNING id`,
      [SELLER_ID]
    ).then((r) => r.rows[0].id);
    const res = await request(app).post(`/listings/${id}/reactivate`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 422, `expected 422, got ${res.status}`);
    const missing = res.body.missing || [];
    assert(missing.includes('weight_oz'), `expected weight_oz in missing: ${JSON.stringify(missing)}`);
    assert(mockEscrowCallCount === 0, `escrow must not be called, got ${mockEscrowCallCount}`);
    const { rows } = await pool.query('SELECT status FROM listings WHERE id = $1', [id]);
    assert(rows[0].status === 'inactive', 'listing must stay inactive');
  });

  await test('escrow timeout → 502, listing stays inactive', async () => {
    await cleanup();
    mockEscrowBehavior = 'hang';
    // Use a very short timeout so the test completes quickly
    process.env.ESCROW_SYNC_TIMEOUT_MS = '300';
    const id = await insertListing({ status: 'inactive' });
    const res = await request(app).post(`/listings/${id}/reactivate`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .timeout(5000);
    assert(res.status === 502, `expected 502, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.code === 'ESCROW_SYNC_FAILED', `expected ESCROW_SYNC_FAILED, got ${res.body.code}`);
    const { rows } = await pool.query('SELECT status FROM listings WHERE id = $1', [id]);
    assert(rows[0].status === 'inactive', 'listing must remain inactive after timeout');
    // Restore
    delete process.env.ESCROW_SYNC_TIMEOUT_MS;
    mockEscrowBehavior = 'success';
  });

  await test('successful reactivation triggers exactly one escrow sync call', async () => {
    await cleanup();
    mockEscrowBehavior = 'success';
    mockEscrowCallCount = 0;
    const id = await insertListing({ status: 'inactive' });
    const res = await request(app).post(`/listings/${id}/reactivate`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(mockEscrowCallCount === 1, `expected exactly 1 escrow call, got ${mockEscrowCallCount}`);
  });

  // ── DELETE /:id/permanent ────────────────────────────────────────────────

  process.stdout.write('\nDELETE /:id/permanent\n');

  await test('draft with no photos → 200, listing deleted from DB', async () => {
    await cleanup();
    const id = await insertListing({ status: 'draft', price_cents: null });
    const res = await request(app).delete(`/listings/${id}/permanent`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.ok === true, 'expected ok: true');
    const { rows } = await pool.query('SELECT id FROM listings WHERE id = $1', [id]);
    assert(rows.length === 0, 'listing should be gone from DB');
  });

  await test('draft with photos → 200, listing + photo DB records deleted, files deleted', async () => {
    await cleanup();
    // UPLOADS_DIR in listingRoutes is resolved at module-load time from the
    // same env-var logic. Default (no UPLOADS_DIR env) resolves to
    // <service-root>/uploads/. Write test files there and verify removal.
    const uploadsDir = process.env.UPLOADS_DIR
      ? path.resolve(process.env.UPLOADS_DIR)
      : path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

    const id = await insertListing({ status: 'draft', price_cents: null });
    const fname1 = `lmgmt_test_${id}_file1.jpg`;
    const fname2 = `lmgmt_test_${id}_file2.jpg`;
    fs.writeFileSync(path.join(uploadsDir, fname1), 'fake');
    fs.writeFileSync(path.join(uploadsDir, fname2), 'fake');
    await insertPhoto(id, fname1);
    await insertPhoto(id, fname2);

    const res = await request(app).delete(`/listings/${id}/permanent`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

    // DB records gone
    const { rows: listingRows } = await pool.query('SELECT id FROM listings WHERE id = $1', [id]);
    assert(listingRows.length === 0, 'listing should be deleted from DB');
    const { rows: photoRows } = await pool.query('SELECT id FROM listing_photos WHERE listing_id = $1', [id]);
    assert(photoRows.length === 0, 'photo records should be deleted from DB');

    // Give async unlink calls a moment to complete
    await new Promise((r) => setTimeout(r, 100));

    // Files removed from disk
    assert(!fs.existsSync(path.join(uploadsDir, fname1)), `${fname1} should be deleted from disk`);
    assert(!fs.existsSync(path.join(uploadsDir, fname2)), `${fname2} should be deleted from disk`);
  });

  await test('active listing → 409', async () => {
    await cleanup();
    const id = await insertListing({ status: 'active' });
    const res = await request(app).delete(`/listings/${id}/permanent`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 409, `expected 409, got ${res.status}`);
    // Listing should still exist
    const { rows } = await pool.query('SELECT id FROM listings WHERE id = $1', [id]);
    assert(rows.length === 1, 'listing must not be deleted');
  });

  await test('inactive listing → 409', async () => {
    await cleanup();
    const id = await insertListing({ status: 'inactive' });
    const res = await request(app).delete(`/listings/${id}/permanent`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 409, `expected 409, got ${res.status}`);
  });

  await test('wrong seller → 403', async () => {
    await cleanup();
    const id = await insertListing({ status: 'draft', price_cents: null });
    const res = await request(app).delete(`/listings/${id}/permanent`)
      .set('Authorization', `Bearer ${otherToken}`);
    assert(res.status === 403, `expected 403, got ${res.status}`);
    // Listing must still exist
    const { rows } = await pool.query('SELECT id FROM listings WHERE id = $1', [id]);
    assert(rows.length === 1, 'listing must not be deleted');
  });

  await test('not found → 404', async () => {
    const res = await request(app).delete('/listings/999999/permanent')
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 404, `expected 404, got ${res.status}`);
  });

  await test('concurrent permanent delete — one 200, one 404 (second finds nothing)', async () => {
    await cleanup();
    const id = await insertListing({ status: 'draft', price_cents: null });
    const [r1, r2] = await Promise.all([
      request(app).delete(`/listings/${id}/permanent`).set('Authorization', `Bearer ${sellerToken}`),
      request(app).delete(`/listings/${id}/permanent`).set('Authorization', `Bearer ${sellerToken}`),
    ]);
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    assert(statuses[0] === 200, `expected one 200, got ${statuses}`);
    assert(statuses[1] === 404, `expected one 404, got ${statuses}`);
    const { rows } = await pool.query('SELECT id FROM listings WHERE id = $1', [id]);
    assert(rows.length === 0, 'listing should be gone');
  });

  // ── Public visibility ────────────────────────────────────────────────────

  process.stdout.write('\nPublic visibility\n');

  await test('active listing appears in GET / search', async () => {
    await cleanup();
    await insertListing({ status: 'active', title: 'Visible Bat' });
    const res = await request(app).get('/listings').query({ q: 'Visible' });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.total >= 1, 'should find the active listing');
  });

  await test('after deactivate, listing absent from GET / search', async () => {
    await cleanup();
    const id = await insertListing({ status: 'active', title: 'Deactivatable Bat' });
    await request(app).delete(`/listings/${id}`).set('Authorization', `Bearer ${sellerToken}`);
    const res = await request(app).get('/listings').query({ q: 'Deactivatable' });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.total === 0, 'deactivated listing should not appear in search');
  });

  await test('after reactivate, listing appears in GET / search again', async () => {
    await cleanup();
    mockEscrowBehavior = 'success';
    const id = await insertListing({ status: 'inactive', title: 'Reactivatable Bat' });
    await request(app).post(`/listings/${id}/reactivate`).set('Authorization', `Bearer ${sellerToken}`);
    const res = await request(app).get('/listings').query({ q: 'Reactivatable' });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.total >= 1, 'reactivated listing should appear in search');
  });

  await test('inactive listing still accessible via GET /:id (not hidden like drafts)', async () => {
    await cleanup();
    const id = await insertListing({ status: 'inactive', title: 'Inactive Bat' });
    const res = await request(app).get(`/listings/${id}`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.status === 'inactive', 'should return inactive listing');
  });

  await test('draft listing returns 404 from GET /:id', async () => {
    await cleanup();
    const id = await insertListing({ status: 'draft', price_cents: null });
    const res = await request(app).get(`/listings/${id}`);
    assert(res.status === 404, `expected 404, got ${res.status}`);
  });

  // ── Teardown ─────────────────────────────────────────────────────────────

  await cleanup();
  await stopMockEscrow();
  delete process.env.ESCROW_SERVICE_URL;
  await pool.end();

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (errors.length > 0) {
    process.stdout.write('\nFailed tests:\n');
    for (const e of errors) {
      process.stdout.write(`  ${e.name}: ${e.message}\n`);
    }
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});

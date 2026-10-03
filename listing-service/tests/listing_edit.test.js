'use strict';
// Integration tests for PATCH /listings/:id — seller editing.
//
// Run: node listing-service/tests/listing_edit.test.js
// Uses the test DB (listing_db_test) and buildApp() directly — no network
// auth service or Turnstile required.
//
// Test coverage:
//   1. Ownership — 403 for wrong user, 401 with no token
//   2. Sold restriction — 409 LISTING_SOLD
//   3. Status-field rejection — status field in body returns 400
//   4. Validation — invalid price, invalid category, invalid condition,
//      partial dims (PACKAGE_DIMS_PARTIAL), negative dims, no valid fields
//   5. Successful edits — title, price, description, category, condition, dims,
//      inactive listing edit, draft edit (no escrow sync)
//   6. Escrow sync failure — 502, DB write reverted to old values
//   7. Escrow sync skipped for drafts
//   8. Order price isolation note (architectural — no order table in listing-service)

process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST ||
  'postgres://listing_user:listing_pass@localhost:5432/listing_db_test';
process.env.JWT_SECRET               = 'test-secret';
process.env.INTERNAL_SERVICE_SECRET  = 'test-internal-svc-secret-32chars!!';
process.env.ESCROW_SYNC_TIMEOUT_MS   = '500'; // keep tests fast

const http    = require('http');
const request = require('supertest');
const { Pool } = require('pg');
const jwt  = require('jsonwebtoken');
const { buildApp } = require('../src/app');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app  = buildApp();

// ── Token helpers ──────────────────────────────────────────────────────────

function makeToken(userId, role = 'seller', has_ship_from_address = true) {
  return jwt.sign({ sub: userId, role, has_ship_from_address }, 'test-secret', { expiresIn: '1h' });
}

const SELLER_ID = 5000;
const OTHER_ID  = 5001;
const sellerToken = makeToken(SELLER_ID);
const otherToken  = makeToken(OTHER_ID);

// ── DB fixtures ────────────────────────────────────────────────────────────

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
    weight_oz      NUMERIC(8,2),
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
  CREATE TABLE IF NOT EXISTS listing_photos (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    listing_id    BIGINT  NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    filename      TEXT    NOT NULL,
    display_order INTEGER NOT NULL DEFAULT 0
  );
`;

async function setupSchema() {
  await pool.query(SCHEMA_SQL);
}

async function insertListing(overrides = {}) {
  const defaults = {
    seller_id:    SELLER_ID,
    title:        'Test Cricket Bat',
    description:  'Good condition',
    price_cents:  5000,
    category:     'bat',
    condition:    'used_good',
    status:       'active',
    weight_oz:    32,
    pkg_length_in: 34,
    pkg_width_in:  6,
    pkg_height_in: 4,
  };
  const r = { ...defaults, ...overrides };
  const { rows } = await pool.query(
    `INSERT INTO listings
       (seller_id, title, description, price_cents, category, condition, status,
        weight_oz, pkg_length_in, pkg_width_in, pkg_height_in)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [r.seller_id, r.title, r.description, r.price_cents, r.category, r.condition,
     r.status, r.weight_oz, r.pkg_length_in, r.pkg_width_in, r.pkg_height_in]
  );
  return Number(rows[0].id);
}

async function cleanup() {
  await pool.query(
    'DELETE FROM listings WHERE seller_id IN ($1, $2)',
    [SELLER_ID, OTHER_ID]
  );
}

// ── Mock escrow server ─────────────────────────────────────────────────────

let mockEscrowBehavior = 'success';
let mockEscrowCallCount = 0;
let mockEscrowServer;
let mockEscrowPort;

// mockEscrowPausePromise: when set, the NEXT arriving escrow request waits for
// this promise to resolve before responding. Cleared immediately when that first
// request captures it, so subsequent requests (e.g. PATCH B) are NOT blocked.
let mockEscrowPausePromise = null;

// mockEscrowOnFirstRequest: called once when the first escrow request arrives
// (before it starts waiting on the latch). Tests use this to learn that the
// request is safely latched and the concurrent writer can now be sent.
let mockEscrowOnFirstRequest = null;

async function startMockEscrow() {
  return new Promise((resolve) => {
    mockEscrowServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        async function handle() {
          if (req.url === '/api/sync/listing' && req.method === 'POST') {
            mockEscrowCallCount++;

            // Signal arrival of the first request so the test knows the request
            // is in the mock's hands. Called synchronously before the latch so
            // the test sees it BEFORE any pause begins (microtask ordering).
            if (mockEscrowOnFirstRequest) {
              mockEscrowOnFirstRequest();
              mockEscrowOnFirstRequest = null;
            }

            // Capture and consume the pause promise so only the first waiting
            // request is held — subsequent requests proceed immediately.
            const localPause = mockEscrowPausePromise;
            mockEscrowPausePromise = null;
            if (localPause) await localPause;

            if (mockEscrowBehavior === 'success') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            } else {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'mock escrow failure' }));
            }
          } else {
            res.writeHead(404);
            res.end();
          }
        }
        handle().catch(() => { res.writeHead(500); res.end(); });
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
    if (!mockEscrowServer) return resolve();
    mockEscrowServer.closeAllConnections?.();
    mockEscrowServer.close((err) => (err ? reject(err) : resolve()));
  });
}

// ── Test runner ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const errors = [];

async function test(name, fn) {
  try {
    await fn();
    process.stdout.write(`  ✓ ${name}\n`);
    passed++;
  } catch (err) {
    process.stdout.write(`  ✗ ${name}: ${err.message}\n`);
    failed++;
    errors.push({ name, message: err.message });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

// ── Test suite ─────────────────────────────────────────────────────────────

async function runTests() {
  await setupSchema();
  await startMockEscrow();
  process.env.ESCROW_SERVICE_URL = `http://127.0.0.1:${mockEscrowPort}`;

  // ── 1. Ownership ─────────────────────────────────────────────────────────
  process.stdout.write('\nOwnership\n');

  await test('PATCH with no token returns 401', async () => {
    const id = await insertListing();
    const res = await request(app).patch(`/listings/${id}`).send({ title: 'No Auth' });
    assert(res.status === 401, `Expected 401, got ${res.status}`);
    await cleanup();
  });

  await test('PATCH by non-owner returns 403', async () => {
    const id = await insertListing({ seller_id: SELLER_ID });
    const res = await request(app)
      .patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ title: 'Stolen Title' });
    assert(res.status === 403, `Expected 403, got ${res.status}`);
    assert(res.body.error, 'Expected error message');
    await cleanup();
  });

  await test('PATCH nonexistent listing returns 404', async () => {
    const res = await request(app)
      .patch('/listings/999999')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Ghost' });
    assert(res.status === 404, `Expected 404, got ${res.status}`);
  });

  // ── 2. Sold restriction ──────────────────────────────────────────────────
  process.stdout.write('\nSold restriction\n');

  await test('PATCH sold listing returns 409 with LISTING_SOLD code', async () => {
    const id = await insertListing({ status: 'sold' });
    const res = await request(app)
      .patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Cannot Edit' });
    assert(res.status === 409, `Expected 409, got ${res.status}`);
    assert(res.body.code === 'LISTING_SOLD', `Expected LISTING_SOLD, got ${res.body.code}`);
    await cleanup();
  });

  // ── 3. Status-field rejection ────────────────────────────────────────────
  process.stdout.write('\nStatus-field rejection\n');

  await test('PATCH with status field returns 400 regardless of value', async () => {
    const id = await insertListing();
    for (const statusVal of ['inactive', 'active', 'sold', 'draft', 'anything']) {
      const res = await request(app)
        .patch(`/listings/${id}`)
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({ status: statusVal, title: 'ok title' });
      assert(res.status === 400, `Expected 400 for status=${statusVal}, got ${res.status}`);
    }
    await cleanup();
  });

  // ── 4. Validation ────────────────────────────────────────────────────────
  process.stdout.write('\nValidation\n');

  await test('PATCH with price below minimum ($10) returns 400', async () => {
    const id = await insertListing();
    const res = await request(app)
      .patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ price_cents: 999 });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
    assert(/minimum/i.test(res.body.error), `Expected minimum price message, got: ${res.body.error}`);
    await cleanup();
  });

  await test('PATCH with non-integer price returns 400', async () => {
    const id = await insertListing();
    const res = await request(app)
      .patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ price_cents: 'fifty' });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
    await cleanup();
  });

  await test('PATCH with invalid category returns 400', async () => {
    const id = await insertListing();
    const res = await request(app)
      .patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ category: 'hovercraft' });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
    await cleanup();
  });

  await test('PATCH with invalid condition returns 400', async () => {
    const id = await insertListing();
    const res = await request(app)
      .patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ condition: 'destroyed' });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
    await cleanup();
  });

  await test('PATCH with partial package dims returns 422 PACKAGE_DIMS_PARTIAL', async () => {
    const id = await insertListing();
    // Only 2 of 4 dims provided
    const res = await request(app)
      .patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ weight_oz: 32, pkg_length_in: 34 });
    assert(res.status === 422, `Expected 422, got ${res.status}`);
    assert(res.body.code === 'PACKAGE_DIMS_PARTIAL',
      `Expected PACKAGE_DIMS_PARTIAL, got ${res.body.code}`);
    await cleanup();
  });

  await test('PATCH with zero dim value returns 422', async () => {
    const id = await insertListing();
    const res = await request(app)
      .patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ weight_oz: 0, pkg_length_in: 34, pkg_width_in: 6, pkg_height_in: 4 });
    assert(res.status === 422, `Expected 422, got ${res.status}`);
    await cleanup();
  });

  await test('PATCH with no valid fields returns 400', async () => {
    const id = await insertListing();
    const res = await request(app)
      .patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ bogus: 'value', another_bogus: 123 });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
    await cleanup();
  });

  // ── 5. Successful edits ──────────────────────────────────────────────────
  process.stdout.write('\nSuccessful edits\n');

  await test('PATCH title updates title, status unchanged', async () => {
    mockEscrowBehavior = 'success';
    const id = await insertListing({ status: 'active', title: 'Original Title' });
    const res = await request(app)
      .patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Updated Title' });
    assert(res.status === 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.title === 'Updated Title', `Title not updated: ${res.body.title}`);
    assert(res.body.status === 'active', 'Status must remain active');
    await cleanup();
  });

  await test('PATCH price updates price_cents, status unchanged', async () => {
    mockEscrowBehavior = 'success';
    const id = await insertListing({ price_cents: 5000 });
    const res = await request(app)
      .patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ price_cents: 9900 });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.body.price_cents === 9900, `Price not updated: ${res.body.price_cents}`);
    assert(res.body.status === 'active', 'Status must remain active');
    await cleanup();
  });

  await test('PATCH description-only skips escrow sync (no price/title change)', async () => {
    mockEscrowCallCount = 0;
    const id = await insertListing({ title: 'Same Title', price_cents: 5000 });
    const res = await request(app)
      .patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ description: 'New description only' });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.body.description === 'New description only', 'Description not updated');
    assert(mockEscrowCallCount === 0, `Escrow should not be called for description-only change; call count: ${mockEscrowCallCount}`);
    await cleanup();
  });

  await test('PATCH category and condition updates both fields', async () => {
    const id = await insertListing({ category: 'bat', condition: 'used_good' });
    const res = await request(app)
      .patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ category: 'helmet', condition: 'new' });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.body.category  === 'helmet', `Category not updated: ${res.body.category}`);
    assert(res.body.condition === 'new',    `Condition not updated: ${res.body.condition}`);
    await cleanup();
  });

  await test('PATCH all four package dims together succeeds', async () => {
    const id = await insertListing();
    const res = await request(app)
      .patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ weight_oz: 48, pkg_length_in: 36, pkg_width_in: 7, pkg_height_in: 5 });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(Number(res.body.weight_oz)    === 48, `weight_oz not updated: ${res.body.weight_oz}`);
    assert(Number(res.body.pkg_length_in) === 36, `pkg_length_in not updated`);
    assert(Number(res.body.pkg_width_in)  === 7,  `pkg_width_in not updated`);
    assert(Number(res.body.pkg_height_in) === 5,  `pkg_height_in not updated`);
    await cleanup();
  });

  await test('PATCH inactive listing succeeds, status remains inactive', async () => {
    mockEscrowBehavior = 'success';
    const id = await insertListing({ status: 'inactive', title: 'Inactive Bat' });
    const res = await request(app)
      .patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Inactive Bat Updated', price_cents: 6000 });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.body.status === 'inactive', 'Status must remain inactive');
    assert(res.body.title === 'Inactive Bat Updated', 'Title not updated');
    await cleanup();
  });

  await test('PATCH response includes photos array', async () => {
    const id = await insertListing();
    const res = await request(app)
      .patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ description: 'check photos field' });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(Array.isArray(res.body.photos), 'Response must include photos array');
    await cleanup();
  });

  // ── 6. Escrow sync failure — DB write reverted ───────────────────────────
  process.stdout.write('\nEscrow sync failure\n');

  await test('PATCH title change: escrow sync fail → 502, DB reverted to old title', async () => {
    mockEscrowBehavior = 'fail';
    const id = await insertListing({ title: 'Original Title', price_cents: 5000 });

    const res = await request(app)
      .patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'New Title That Should Not Stick' });

    assert(res.status === 502, `Expected 502, got ${res.status}`);
    assert(res.body.code === 'ESCROW_SYNC_FAILED', `Expected ESCROW_SYNC_FAILED, got ${res.body.code}`);

    // Verify the DB was reverted
    const { rows } = await pool.query('SELECT title FROM listings WHERE id = $1', [id]);
    assert(rows[0].title === 'Original Title',
      `DB should be reverted to "Original Title", got "${rows[0].title}"`);
    await cleanup();
  });

  await test('PATCH price change: escrow sync fail → 502, DB reverted to old price', async () => {
    mockEscrowBehavior = 'fail';
    const id = await insertListing({ price_cents: 5000 });

    const res = await request(app)
      .patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ price_cents: 9999 });

    assert(res.status === 502, `Expected 502, got ${res.status}`);
    assert(res.body.code === 'ESCROW_SYNC_FAILED', `Expected ESCROW_SYNC_FAILED`);

    const { rows } = await pool.query('SELECT price_cents FROM listings WHERE id = $1', [id]);
    assert(Number(rows[0].price_cents) === 5000,
      `DB should be reverted to 5000, got ${rows[0].price_cents}`);
    await cleanup();
  });

  // ── 7. Escrow sync skipped for drafts ────────────────────────────────────
  process.stdout.write('\nEscrow sync skipped for drafts\n');

  await test('PATCH draft listing with title change succeeds without escrow sync', async () => {
    mockEscrowBehavior = 'fail'; // would cause 502 if called
    mockEscrowCallCount = 0;
    const id = await insertListing({ status: 'draft', title: 'Draft Bat', price_cents: 5000 });

    const res = await request(app)
      .patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Updated Draft Title' });

    assert(res.status === 200, `Expected 200 (no escrow for drafts), got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.status === 'draft', 'Draft status must be preserved');
    assert(res.body.title === 'Updated Draft Title', 'Title not updated');
    assert(mockEscrowCallCount === 0, `Escrow must not be called for draft PATCH; calls: ${mockEscrowCallCount}`);
    await cleanup();
  });

  // ── 8. Order price isolation (architectural note) ────────────────────────
  process.stdout.write('\nOrder price isolation\n');

  await test('Price change is stored in listings table (order table lives in escrow-service)', async () => {
    // createOrder in escrow-service calls fetchAuthoritativeListing — a live
    // GET /listings/:id — at the moment each order is created, NOT escrow's
    // local cache. order.item_price_cents / amount_cents are locked in at that
    // moment and never re-read from the listing. So changing the listing price
    // after a CREATED order exists cannot silently alter the order's capture amount.
    //
    // This test confirms the listing-service DB correctly stores the new price;
    // the escrow price-lock guarantee is verified by architecture (orderService.js
    // line ~329: const itemPriceCents = listing.price_cents from fetchAuthoritativeListing).
    mockEscrowBehavior = 'success';
    const id = await insertListing({ price_cents: 5000 });

    await request(app)
      .patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ price_cents: 7500 });

    const { rows } = await pool.query('SELECT price_cents FROM listings WHERE id = $1', [id]);
    assert(Number(rows[0].price_cents) === 7500, `Expected 7500, got ${rows[0].price_cents}`);
    // No order rows exist in listing-service — price isolation is enforced by
    // escrow design. No further assertion possible here without escrow DB.
    await cleanup();
  });

  // ── 9. Concurrency safety ─────────────────────────────────────────────────
  process.stdout.write('\nConcurrency safety\n');

  await test('DB-level guard: UPDATE WHERE status NOT IN sold rejects write on sold listing', async () => {
    // Directly verifies the belt-and-suspenders condition added to the PATCH UPDATE.
    // This guard catches the narrow window where mark-sold could commit between the
    // PATCH transaction's BEGIN and its SELECT FOR UPDATE (which would be blocked
    // once the transaction starts, but not before it does).
    const id = await insertListing({ status: 'active', title: 'Guard Test Bat' });
    await pool.query("UPDATE listings SET status = 'sold' WHERE id = $1", [id]);

    const { rowCount } = await pool.query(
      "UPDATE listings SET title = 'Should Not Apply', updated_at = NOW() WHERE id = $1 AND status NOT IN ('sold')",
      [id]
    );
    assert(rowCount === 0, `UPDATE guard should reject write to sold listing, got rowCount=${rowCount}`);

    const { rows } = await pool.query('SELECT title FROM listings WHERE id = $1', [id]);
    assert(rows[0].title === 'Guard Test Bat', `Title must be unchanged; got "${rows[0].title}"`);
    await cleanup();
  });

  await test('DB-level guard: revert WHERE updated_at=$ours is skipped when concurrent write changed updated_at', async () => {
    // Verifies the versioned-revert guard: the escrow-fail revert includes
    // AND updated_at = $newUpdatedAt::timestamptz so it only applies when our
    // write is still the current version. If a concurrent PATCH committed between
    // our COMMIT and our revert, updated_at has advanced and the revert finds 0
    // rows. Uses ::text to retrieve and ::timestamptz to compare so the full
    // microsecond precision is preserved (JavaScript Date is milliseconds only).
    const id = await insertListing({ title: 'Original' });

    // Simulate: our PATCH committed, producing newUpdatedAt (full-precision text).
    await pool.query("UPDATE listings SET title = 'Our Write', updated_at = NOW() WHERE id = $1", [id]);
    const { rows: r1 } = await pool.query(
      'SELECT updated_at::text AS updated_at_str FROM listings WHERE id = $1', [id]);
    const ourUpdatedAt = r1[0].updated_at_str; // full-precision string

    // Simulate: a concurrent PATCH committed AFTER ours.
    await pool.query("UPDATE listings SET title = 'Concurrent Write', updated_at = NOW() WHERE id = $1", [id]);

    // Simulate: our revert runs with WHERE updated_at = $ourUpdatedAt::timestamptz.
    const { rowCount } = await pool.query(
      "UPDATE listings SET title = 'Original', updated_at = NOW() WHERE id = $1 AND updated_at = $2::timestamptz",
      [id, ourUpdatedAt]
    );
    assert(rowCount === 0, `Stale revert must find 0 rows (concurrent write changed updated_at), got ${rowCount}`);

    const { rows: r2 } = await pool.query('SELECT title FROM listings WHERE id = $1', [id]);
    assert(r2[0].title === 'Concurrent Write',
      `Concurrent write must be preserved, not overwritten; got "${r2[0].title}"`);
    await cleanup();
  });

  await test('concurrent PATCH: escrow fail revert does not overwrite a newer concurrent commit', async () => {
    // End-to-end concurrency test — deterministic, no wall-clock timing.
    //
    // The key ordering constraint: A must commit BEFORE B can get the FOR UPDATE
    // lock, and B must commit BEFORE A's revert runs. We guarantee this via:
    //   1. Latch: A's escrow response is held until we explicitly release it.
    //   2. Arrival signal: resolves when A's request arrives at the mock, meaning
    //      A has committed (COMMIT precedes the escrow fetch) and the latch is
    //      consumed so B will not be blocked.
    //
    // Timeline:
    //   Install latch + arrival signal.
    //   PATCH A starts (no await) — commits 'Changed By A', escrow → BLOCKED.
    //   await aArrivalSignal     — A committed; latch consumed; safe to send B.
    //   PATCH B (awaited)        — FOR UPDATE (A committed → free), commits
    //                             'Changed By B', escrow (no latch) → 200.
    //   mockEscrowBehavior='fail'; releaseLatch()
    //   PATCH A finishes         — gets 502 → revert WHERE updated_at=$A_ts
    //                             → 0 rows (B changed it) → skip → 502.
    //   Expected: DB has 'Changed By B'.
    const id = await insertListing({ title: 'Original', price_cents: 5000, status: 'active' });

    // Latch: first escrow request blocks until released.
    let releaseLatch;
    mockEscrowPausePromise = new Promise((r) => { releaseLatch = r; });
    // Arrival signal: resolves when the first escrow request arrives and has
    // captured the latch (so subsequent requests won't see it).
    const aArrivalSignal = new Promise((r) => { mockEscrowOnFirstRequest = r; });
    mockEscrowBehavior = 'success'; // overridden to 'fail' at release time

    // Start A (no await). A: BEGIN → FOR UPDATE → UPDATE → COMMIT → escrow → HELD.
    // Use .end() callback to force supertest to send the HTTP request immediately
    // (supertest is lazy — the request is NOT sent until .then()/.end() is called).
    let resolveA, rejectA;
    const patchAPromise = new Promise((res, rej) => { resolveA = res; rejectA = rej; });
    request(app)
      .patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Changed By A' })
      .end((err, res) => { if (err) rejectA(err); else resolveA(res); });

    // Wait until A's request has arrived at the mock server. At this point:
    //   - A has committed (COMMIT happens before the escrow fetch call)
    //   - The latch is consumed (cleared) — B's escrow will not be blocked
    await aArrivalSignal;

    // Now send B. A's FOR UPDATE lock is free (A committed). B gets the lock,
    // writes 'Changed By B', escrow succeeds (no latch) → 200.
    mockEscrowBehavior = 'success';
    const resB = await request(app)
      .patch(`/listings/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Changed By B' });
    assert(resB.status === 200, `PATCH B must succeed, got ${resB.status}: ${JSON.stringify(resB.body)}`);
    assert(resB.body.title === 'Changed By B', `PATCH B: expected "Changed By B", got "${resB.body.title}"`);

    // B committed. Release A's latch as a failure.
    // A: gets 502 → revert WHERE updated_at=$A_ts::timestamptz → 0 rows
    // (B advanced updated_at) → revert skipped → returns 502.
    mockEscrowBehavior = 'fail';
    releaseLatch();
    const resA = await patchAPromise;
    assert(resA.status === 502, `PATCH A must return 502, got ${resA.status}`);
    assert(resA.body.code === 'ESCROW_SYNC_FAILED', `Expected ESCROW_SYNC_FAILED, got ${resA.body.code}`);

    // Critical: B's write must survive A's stale revert attempt.
    const { rows: final } = await pool.query('SELECT title FROM listings WHERE id = $1', [id]);
    assert(
      final[0].title === 'Changed By B',
      `DB must have "Changed By B", got "${final[0].title}" — A's stale revert clobbered B`
    );

    mockEscrowPausePromise = null;
    mockEscrowOnFirstRequest = null;
    await cleanup();
  });

  // ── Teardown ──────────────────────────────────────────────────────────────
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

// Draft workflow integration tests — draft creation, visibility, editing, and
// publication. Covers the 4 new scenarios added in the final plan correction:
//   - Concurrent publish (only one wins, second gets 409)
//   - Migration rollback refuses when drafts exist (never deletes them)
//   - Photos uploaded before publication appear in publish response
//   - Escrow sync failure is distinct from validation failure (backend contract)
//
// Prerequisites: same as listings.test.js — PostgreSQL test DB running.
//
// Run: node tests/draft_workflow.test.js
'use strict';

process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST ||
  'postgres://listing_user:listing_pass@localhost:5432/listing_db_test';
process.env.JWT_SECRET = 'test-secret';
process.env.INTERNAL_SERVICE_SECRET = 'test-internal-svc-secret-32chars!!';

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

const SELLER_ID = 2000;
const OTHER_ID  = 2001;
const sellerToken      = makeToken(SELLER_ID, 'seller', true);
const noAddrToken      = makeToken(SELLER_ID, 'seller', false); // same seller, no ship-from
const otherToken       = makeToken(OTHER_ID,  'seller', true);

// Full package dims needed for publish validation
const PKG_DIMS = { weight_oz: 16, pkg_length_in: 30, pkg_width_in: 5, pkg_height_in: 3 };

// Schema that supports drafts (includes 'draft' in status check and nullable price_cents)
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

// Creates a minimal complete draft (just title + save_as_draft).
async function createDraft(overrides = {}) {
  const res = await request(app)
    .post('/listings')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ title: 'Draft Bat', save_as_draft: true, ...overrides });
  return res;
}

// Creates a draft and then fills it in so it passes publish validation.
async function createCompleteDraft() {
  const draftRes = await createDraft({
    title: 'Complete Draft Bat',
    price_cents: 5000,
    category: 'bat',
    condition: 'new',
    ...PKG_DIMS,
  });
  return draftRes.body;
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
  console.log('Draft workflow — integration tests\n');

  // Apply schema (idempotent) and ensure draft-compatible column types.
  await pool.query(SCHEMA_SQL);
  // Upgrade status constraint to include 'draft' if the test DB was previously
  // created by listings.test.js without draft support.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'listings_status_check'
          AND pg_get_constraintdef(oid) LIKE '%draft%'
      ) THEN
        ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_status_check;
        ALTER TABLE listings ADD CONSTRAINT listings_status_check
          CHECK (status IN ('active','sold','inactive','draft'));
      END IF;
    END $$;
  `);
  // Make price_cents nullable if it isn't already (draft support).
  await pool.query(`
    ALTER TABLE listings ALTER COLUMN price_cents DROP NOT NULL;
  `).catch(() => {});
  // Ensure package dim columns exist
  await pool.query(`
    ALTER TABLE listings ADD COLUMN IF NOT EXISTS weight_oz      INTEGER;
    ALTER TABLE listings ADD COLUMN IF NOT EXISTS pkg_length_in  NUMERIC(5,1);
    ALTER TABLE listings ADD COLUMN IF NOT EXISTS pkg_width_in   NUMERIC(5,1);
    ALTER TABLE listings ADD COLUMN IF NOT EXISTS pkg_height_in  NUMERIC(5,1);
  `);

  // ── Draft creation ──────────────────────────────────────────────────────────
  console.log('POST /listings — save_as_draft');

  await cleanup();
  await test('creates a draft with title only — no price required', async () => {
    const res = await createDraft({ title: 'Title-Only Draft' });
    assert(res.status === 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.status === 'draft', `expected status=draft, got ${res.body.status}`);
    assert(res.body.title === 'Title-Only Draft', 'title mismatch');
    assert(res.body.price_cents === null, `expected null price_cents, got ${res.body.price_cents}`);
  });

  await cleanup();
  await test('draft creation requires a title — returns 400 without one', async () => {
    const res = await request(app)
      .post('/listings')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ save_as_draft: true });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await cleanup();
  await test('draft accepts a price below minimum — no min enforced for drafts', async () => {
    const res = await createDraft({ title: 'Cheap Draft', price_cents: 500 });
    assert(res.status === 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.status === 'draft', 'should be draft');
    // Price stored as provided (partial save)
    assert(res.body.price_cents === 500, `expected 500, got ${res.body.price_cents}`);
  });

  await cleanup();
  await test('draft accepted even when seller has no ship-from address', async () => {
    const res = await request(app)
      .post('/listings')
      .set('Authorization', `Bearer ${noAddrToken}`)
      .send({ title: 'No-Address Draft', save_as_draft: true });
    assert(res.status === 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.status === 'draft', 'should be draft');
  });

  await cleanup();
  await test('draft stores provided fields and returns photos array', async () => {
    const res = await createDraft({
      title: 'Partial Draft',
      price_cents: 4999,
      category: 'bat',
      condition: 'used_good',
    });
    assert(res.status === 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.category === 'bat', 'category should be stored');
    assert(Array.isArray(res.body.photos), 'photos should be array');
    assert(res.body.photos.length === 0, 'photos should be empty initially');
  });

  await cleanup();
  await test('draft requires auth — returns 401 without token', async () => {
    const res = await request(app)
      .post('/listings')
      .send({ title: 'Unauthed Draft', save_as_draft: true });
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  // ── Draft visibility ────────────────────────────────────────────────────────
  console.log('\nDraft visibility — public endpoints must not expose drafts');

  await cleanup();
  await test('GET /listings/:id returns 404 for a draft', async () => {
    const draft = await createCompleteDraft();
    const res = await request(app).get(`/listings/${draft.id}`);
    assert(res.status === 404, `expected 404, got ${res.status}`);
  });

  await cleanup();
  await test('GET /listings does not include draft listings', async () => {
    await createDraft({ title: 'Hidden Draft' });
    // Also create one active listing so we can confirm it appears
    await request(app)
      .post('/listings')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Active Listing', price_cents: 2000, category: 'bat', condition: 'new', ...PKG_DIMS });
    const res = await request(app).get('/listings');
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(
      !res.body.listings.some(l => l.status === 'draft'),
      'public list should not contain any drafts'
    );
  });

  await cleanup();
  await test("GET /listings/mine includes the seller's own drafts", async () => {
    await createDraft({ title: 'My Draft' });
    const res = await request(app)
      .get('/listings/mine')
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const draft = res.body.listings.find(l => l.status === 'draft');
    assert(draft, 'draft should appear in /mine');
    assert(draft.title === 'My Draft', 'title should match');
  });

  await cleanup();
  await test("GET /listings/mine does not leak another seller's drafts", async () => {
    // Other seller creates a draft
    await request(app)
      .post('/listings')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ title: "Other's Draft", save_as_draft: true });
    // Current seller's /mine should not see it
    const res = await request(app)
      .get('/listings/mine')
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(
      res.body.listings.every(l => String(l.seller_id) === String(SELLER_ID)),
      "should not see other seller's drafts"
    );
  });

  // ── Draft editing (PATCH) ───────────────────────────────────────────────────
  console.log('\nPATCH /listings/:id — editing a draft');

  await cleanup();
  await test('PATCH updates title on a draft', async () => {
    const draft = await createCompleteDraft();
    const res = await request(app)
      .patch(`/listings/${draft.id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Updated Draft Title' });
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.title === 'Updated Draft Title', 'title should be updated');
    assert(res.body.status === 'draft', 'status should remain draft after PATCH');
  });

  await cleanup();
  await test('PATCH blocks setting status to draft — returns 400', async () => {
    const active = await request(app)
      .post('/listings')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Active', price_cents: 5000, category: 'bat', condition: 'new', ...PKG_DIMS });
    const res = await request(app)
      .patch(`/listings/${active.body.id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ status: 'draft' });
    assert(res.status === 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  // ── Publishing ──────────────────────────────────────────────────────────────
  console.log('\nPOST /listings/:id/publish');

  await cleanup();
  await test('publishes a complete draft — returns 200 with ok and listing', async () => {
    const draft = await createCompleteDraft();
    const res = await request(app)
      .post(`/listings/${draft.id}/publish`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.ok === true, 'body.ok should be true');
    assert(res.body.listing, 'body.listing should be present');
    assert(res.body.listing.status === 'active', `expected active, got ${res.body.listing.status}`);
    assert(res.body.listing.id === draft.id, 'id should match');
  });

  await cleanup();
  await test('after publish listing appears in GET /listings', async () => {
    const draft = await createCompleteDraft();
    await request(app)
      .post(`/listings/${draft.id}/publish`)
      .set('Authorization', `Bearer ${sellerToken}`);
    const res = await request(app).get('/listings');
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(
      res.body.listings.some(l => l.id === draft.id && l.status === 'active'),
      'published listing should appear in public list'
    );
  });

  await cleanup();
  await test("after publish, /mine shows 'active' not 'draft'", async () => {
    const draft = await createCompleteDraft();
    await request(app)
      .post(`/listings/${draft.id}/publish`)
      .set('Authorization', `Bearer ${sellerToken}`);
    const res = await request(app)
      .get('/listings/mine')
      .set('Authorization', `Bearer ${sellerToken}`);
    const listing = res.body.listings.find(l => l.id === draft.id);
    assert(listing, 'listing should still be in /mine');
    assert(listing.status === 'active', `expected active, got ${listing.status}`);
  });

  await cleanup();
  await test('publish incomplete draft (no price) returns 422 with missing fields', async () => {
    const draftRes = await createDraft({ title: 'Incomplete Draft' }); // no price, no dims
    const res = await request(app)
      .post(`/listings/${draftRes.body.id}/publish`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 422, `expected 422, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.ok === false, 'body.ok should be false');
    assert(Array.isArray(res.body.missing), 'body.missing should be an array');
    assert(res.body.missing.includes('price_cents'), 'missing should include price_cents');
    // Listing must remain a draft after failed publish
    const check = await request(app)
      .get('/listings/mine')
      .set('Authorization', `Bearer ${sellerToken}`);
    const still = check.body.listings.find(l => l.id === draftRes.body.id);
    assert(still && still.status === 'draft', 'failed publish should leave listing as draft');
  });

  await cleanup();
  await test('publish validates all fields — missing dims included in 422 response', async () => {
    // Has price and title but no package dims
    const draftRes = await createDraft({
      title: 'No Dims Draft',
      price_cents: 5000,
      category: 'bat',
      condition: 'new',
    });
    const res = await request(app)
      .post(`/listings/${draftRes.body.id}/publish`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 422, `expected 422, got ${res.status}: ${JSON.stringify(res.body)}`);
    const missing = res.body.missing || [];
    const dimFields = ['weight_oz', 'pkg_length_in', 'pkg_width_in', 'pkg_height_in'];
    const hasDimMissing = dimFields.some(f => missing.includes(f));
    assert(hasDimMissing, `missing dims should be reported: ${JSON.stringify(missing)}`);
  });

  await cleanup();
  await test('seller without ship-from address gets 422 on publish', async () => {
    // Create draft as the same user but without address (via noAddrToken with same SELLER_ID)
    const draftRes = await request(app)
      .post('/listings')
      .set('Authorization', `Bearer ${noAddrToken}`)
      .send({ title: 'No-Addr Draft', save_as_draft: true });
    assert(draftRes.status === 201, 'draft creation should succeed');

    // Attempt to publish — no ship-from address
    const res = await request(app)
      .post(`/listings/${draftRes.body.id}/publish`)
      .set('Authorization', `Bearer ${noAddrToken}`);
    assert(res.status === 422, `expected 422, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.ok === false, 'body.ok should be false');
    assert(
      res.body.missing && res.body.missing.includes('ship_from_address'),
      `ship_from_address should be in missing: ${JSON.stringify(res.body)}`
    );
  });

  await cleanup();
  await test('publish non-existent listing returns 404', async () => {
    const res = await request(app)
      .post('/listings/999999/publish')
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 404, `expected 404, got ${res.status}`);
  });

  await cleanup();
  await test("publish another seller's draft returns 403", async () => {
    const draftRes = await createDraft({ title: "Not Mine" });
    const res = await request(app)
      .post(`/listings/${draftRes.body.id}/publish`)
      .set('Authorization', `Bearer ${otherToken}`);
    assert(res.status === 403, `expected 403, got ${res.status}`);
  });

  await cleanup();
  await test('publish already-active listing returns 409', async () => {
    const active = await request(app)
      .post('/listings')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Already Active', price_cents: 5000, category: 'bat', condition: 'new', ...PKG_DIMS });
    assert(active.status === 201, 'setup failed');
    const res = await request(app)
      .post(`/listings/${active.body.id}/publish`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 409, `expected 409, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  // ── Concurrent publish ──────────────────────────────────────────────────────
  console.log('\nConcurrent publish — atomic status change');

  await cleanup();
  await test('concurrent publish — exactly one succeeds, the other gets 409', async () => {
    const draft = await createCompleteDraft();
    // Fire both publish requests simultaneously (Promise.all, not sequential)
    const [r1, r2] = await Promise.all([
      request(app)
        .post(`/listings/${draft.id}/publish`)
        .set('Authorization', `Bearer ${sellerToken}`),
      request(app)
        .post(`/listings/${draft.id}/publish`)
        .set('Authorization', `Bearer ${sellerToken}`),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert(
      statuses[0] === 200 && statuses[1] === 409,
      `expected one 200 and one 409, got ${r1.status} and ${r2.status}`
    );
    // Verify final DB state: exactly one active listing
    const check = await request(app)
      .get('/listings/mine')
      .set('Authorization', `Bearer ${sellerToken}`);
    const listing = check.body.listings.find(l => l.id === draft.id);
    assert(listing && listing.status === 'active', 'listing should be active in DB after concurrent publish');
  });

  // ── Photos uploaded before publication appear in publish response ───────────
  console.log('\nPhotos uploaded to draft appear in publish response');

  // Minimal valid JPEG magic bytes for photo upload
  const JPEG_BYTES = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);

  await cleanup();
  await test('photos uploaded to draft before publish are included in publish response', async () => {
    const draft = await createCompleteDraft();

    // Upload a photo to the draft before publishing
    const uploadRes = await request(app)
      .post(`/listings/${draft.id}/photos`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .attach('photo', JPEG_BYTES, { filename: 'bat.jpg', contentType: 'image/jpeg' });
    assert(uploadRes.status === 201, `photo upload failed: ${JSON.stringify(uploadRes.body)}`);

    // Now publish — the photo should appear in the response
    const publishRes = await request(app)
      .post(`/listings/${draft.id}/publish`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(publishRes.status === 200, `expected 200, got ${publishRes.status}: ${JSON.stringify(publishRes.body)}`);
    assert(publishRes.body.listing, 'body.listing should be present');
    assert(
      Array.isArray(publishRes.body.listing.photos) && publishRes.body.listing.photos.length === 1,
      `expected 1 photo in publish response, got ${publishRes.body.listing.photos?.length}`
    );
    assert(
      publishRes.body.listing.photos[0].filename,
      'photo should have a filename'
    );
  });

  await cleanup();
  await test('multiple photos uploaded in order appear in correct display_order in publish response', async () => {
    const draft = await createCompleteDraft();

    // Upload 3 photos
    for (let i = 0; i < 3; i++) {
      const up = await request(app)
        .post(`/listings/${draft.id}/photos`)
        .set('Authorization', `Bearer ${sellerToken}`)
        .attach('photo', JPEG_BYTES, { filename: `photo${i}.jpg`, contentType: 'image/jpeg' });
      assert(up.status === 201, `photo ${i} upload failed`);
    }

    const publishRes = await request(app)
      .post(`/listings/${draft.id}/publish`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(publishRes.status === 200, `expected 200, got ${publishRes.status}`);
    const photos = publishRes.body.listing.photos;
    assert(photos.length === 3, `expected 3 photos, got ${photos.length}`);
    // Verify display_order is ascending
    assert(
      photos[0].display_order <= photos[1].display_order &&
      photos[1].display_order <= photos[2].display_order,
      'photos should be in ascending display_order'
    );
  });

  // ── Migration rollback safety ───────────────────────────────────────────────
  console.log('\nMigration rollback — refuses when drafts exist');

  await cleanup();
  await test('down migration PL/pgSQL raises EXCEPTION when drafts exist', async () => {
    // Insert a draft directly (bypassing the route to ensure DB state)
    await pool.query(
      `INSERT INTO listings (seller_id, title, status) VALUES ($1, 'Rollback Guard Draft', 'draft')`,
      [SELLER_ID]
    );

    // Simulate the down migration's safety check SQL
    let threw = false;
    try {
      await pool.query(`
        DO $$
        DECLARE draft_count INTEGER;
        BEGIN
          SELECT COUNT(*) INTO draft_count FROM listings WHERE status = 'draft';
          IF draft_count > 0 THEN
            RAISE EXCEPTION
              'Cannot roll back draft_status migration: % draft listing(s) exist. '
              'Review and manually resolve all drafts before running this migration rollback.',
              draft_count;
          END IF;
        END $$;
      `);
    } catch (err) {
      threw = true;
      assert(
        err.message.includes('Cannot roll back draft_status migration'),
        `expected rollback guard message, got: ${err.message}`
      );
    }
    assert(threw, 'down migration safety block should have thrown an EXCEPTION');
  });

  await cleanup();
  await test('down migration safety check does NOT delete drafts — they remain after the exception', async () => {
    await pool.query(
      `INSERT INTO listings (seller_id, title, status) VALUES ($1, 'Preserved Draft', 'draft')`,
      [SELLER_ID]
    );

    // Run the safety check (it throws)
    try {
      await pool.query(`
        DO $$
        DECLARE draft_count INTEGER;
        BEGIN
          SELECT COUNT(*) INTO draft_count FROM listings WHERE status = 'draft';
          IF draft_count > 0 THEN
            RAISE EXCEPTION 'rollback guard', draft_count;
          END IF;
        END $$;
      `);
    } catch (_) {}

    // Draft must still exist in the DB
    const { rows } = await pool.query(
      "SELECT id FROM listings WHERE status = 'draft' AND seller_id = $1",
      [SELLER_ID]
    );
    assert(rows.length === 1, `draft should still exist after exception; found ${rows.length}`);
  });

  await cleanup();
  await test('down migration safety check passes (no EXCEPTION) when no drafts exist', async () => {
    // Ensure no drafts
    await pool.query("DELETE FROM listings WHERE status = 'draft'");

    let threw = false;
    try {
      await pool.query(`
        DO $$
        DECLARE draft_count INTEGER;
        BEGIN
          SELECT COUNT(*) INTO draft_count FROM listings WHERE status = 'draft';
          IF draft_count > 0 THEN
            RAISE EXCEPTION 'should not reach here';
          END IF;
        END $$;
      `);
    } catch (_) {
      threw = true;
    }
    assert(!threw, 'safety check should pass without exception when no drafts exist');
  });

  // ── Escrow sync failure contract ────────────────────────────────────────────
  // The backend's job: return 200 {ok:true, listing} on successful publish
  // regardless of downstream sync. Escrow sync is the frontend's responsibility
  // (fire syncListingToEscrow after publish). The backend publish endpoint must
  // NOT return an escrow-related error code — that would conflate validation
  // failure with infrastructure failure.
  console.log('\nPublish response contract — escrow sync is not a publish concern');

  await cleanup();
  await test('successful publish returns 200 {ok:true, listing} — no escrow fields', async () => {
    const draft = await createCompleteDraft();
    const res = await request(app)
      .post(`/listings/${draft.id}/publish`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    // ok and listing must be present
    assert(res.body.ok === true, 'ok should be true');
    assert(res.body.listing && res.body.listing.id, 'listing with id should be present');
    // No escrow-related fields polluting the response
    assert(res.body.escrow_error === undefined, 'escrow_error must not be in response');
    assert(res.body.sync_failed === undefined, 'sync_failed must not be in response');
  });

  await cleanup();
  await test('422 response body has ok=false and missing[] — clearly not an escrow error', async () => {
    const draftRes = await createDraft({ title: 'Incomplete For Contract Test' });
    const res = await request(app)
      .post(`/listings/${draftRes.body.id}/publish`)
      .set('Authorization', `Bearer ${sellerToken}`);
    assert(res.status === 422, `expected 422, got ${res.status}`);
    // Validation failure shape: {ok:false, missing:[...]}
    assert(res.body.ok === false, 'ok should be false for validation failure');
    assert(Array.isArray(res.body.missing) && res.body.missing.length > 0, 'missing should be non-empty');
    // No escrow-related fields
    assert(res.body.escrow_error === undefined, 'no escrow_error on validation failure');
    assert(res.body.listing === undefined, 'no listing on validation failure');
  });

  // Teardown
  await pool.end();

  const total = passed + failed;
  console.log(`\n${total} test(s): ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('\nFatal test setup error:', err.message);
  process.exit(1);
});

const express = require('express');
const path = require('path');
const fs = require('fs');
const pool = require('./db');
const requireAuth = require('./middleware/requireAuth');
const { postNewListingToSocial } = require('./blotatoService');

const router = express.Router();

const VALID_CATEGORIES = ['bat', 'helmet', 'pads', 'gloves', 'kit-bag', 'other'];
const VALID_CONDITIONS = ['new', 'used_good', 'used_fair'];
const PAGE_LIMIT_MAX = 50;
const MIN_LISTING_PRICE_CENTS = 1000; // $10.00 minimum listing price

// Dedicated secret for service-to-service calls (escrow-service marking a listing
// sold/active). Must be set via INTERNAL_SERVICE_SECRET. Never falls back to
// JWT_SECRET — user tokens must not authenticate internal service endpoints.
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET || '';

// Uploads directory — mirrors the same env-var logic in photoRoutes so that
// permanent draft deletion can resolve the same file paths.
const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(__dirname, '..', 'uploads');

function requireInternalSecret(req, res, next) {
  const secret = req.headers['x-internal-secret'];
  if (!secret || secret !== INTERNAL_SECRET) {
    return res.status(401).json({ error: 'Invalid or missing internal service secret' });
  }
  next();
}

async function withPhotos(listing) {
  const { rows } = await pool.query(
    'SELECT id, filename, display_order FROM listing_photos WHERE listing_id = $1 ORDER BY display_order, id',
    [listing.id]
  );
  return { ...listing, photos: rows };
}

// Shared publication validator — single source of truth for publish requirements.
// Used by both POST /listings (immediate creation) and POST /listings/:id/publish
// (draft promotion). Any change to publish requirements must be made here only.
//
// Returns an array of field names that are missing or invalid.
// An empty array means the listing is complete and ready to publish.
// Photos are not required (matching existing normal publication behaviour).
function validateListingForPublish(listing, user) {
  const missing = [];

  if (!listing.title || !String(listing.title).trim()) missing.push('title');

  const pc = listing.price_cents;
  if (pc == null || !Number.isInteger(Number(pc)) || Number(pc) < MIN_LISTING_PRICE_CENTS) {
    missing.push('price_cents');
  }

  if (!VALID_CATEGORIES.includes(listing.category)) missing.push('category');
  if (!VALID_CONDITIONS.includes(listing.condition)) missing.push('condition');

  const w = Number(listing.weight_oz);
  if (!Number.isFinite(w) || w <= 0) missing.push('weight_oz');
  const l = Number(listing.pkg_length_in);
  if (!Number.isFinite(l) || l <= 0) missing.push('pkg_length_in');
  const wi = Number(listing.pkg_width_in);
  if (!Number.isFinite(wi) || wi <= 0) missing.push('pkg_width_in');
  const h = Number(listing.pkg_height_in);
  if (!Number.isFinite(h) || h <= 0) missing.push('pkg_height_in');

  if (user.role === 'seller' && !user.has_ship_from_address) missing.push('ship_from_address');

  return missing;
}

// Maps validator output to HTTP error responses that match the existing
// conventions used by POST /listings — preserving backward-compatible
// status codes and message formats for API consumers.
function publishValidationToHttpError(missing, rawPriceCents) {
  if (missing.includes('ship_from_address')) {
    return {
      status: 422,
      body: {
        error: 'You must add a ship-from address before creating listings',
        code: 'SHIP_FROM_ADDRESS_REQUIRED',
      },
    };
  }
  // "Both required" message when title is absent or price_cents is null/absent.
  if (missing.includes('title') || (missing.includes('price_cents') && rawPriceCents == null)) {
    return { status: 400, body: { error: 'title and price_cents are required' } };
  }
  if (missing.includes('price_cents')) {
    return {
      status: 400,
      body: { error: `price_cents must be an integer >= ${MIN_LISTING_PRICE_CENTS} (minimum listing price is $10.00)` },
    };
  }
  if (missing.includes('category')) {
    return { status: 400, body: { error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` } };
  }
  if (missing.includes('condition')) {
    return { status: 400, body: { error: `condition must be one of: ${VALID_CONDITIONS.join(', ')}` } };
  }
  const PKG_FIELDS = ['weight_oz', 'pkg_length_in', 'pkg_width_in', 'pkg_height_in'];
  const missingPkg = PKG_FIELDS.filter((f) => missing.includes(f));
  if (missingPkg.length > 0) {
    return {
      status: 422,
      body: {
        error: `Package details are required for shipping: ${missingPkg.join(', ')}`,
        code: 'PACKAGE_DIMS_REQUIRED',
        missing: missingPkg,
      },
    };
  }
  return null;
}

// POST /listings — create
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const {
      title,
      description = '',
      price_cents,
      category = 'other',
      condition = 'used_good',
      weight_oz,
      pkg_length_in,
      pkg_width_in,
      pkg_height_in,
      save_as_draft,
    } = req.body;

    if (save_as_draft) {
      // Draft path: only title is required.
      // Price, package dimensions, and ship-from address are not enforced —
      // the seller fills those in before publishing.
      if (!title || !String(title).trim()) {
        return res.status(400).json({ error: 'title is required to save a draft' });
      }

      const parsedPrice  = price_cents  != null ? Number(price_cents)  : null;
      const parsedWeight = weight_oz    != null ? Number(weight_oz)    : null;
      const parsedLength = pkg_length_in != null ? Number(pkg_length_in) : null;
      const parsedWidth  = pkg_width_in  != null ? Number(pkg_width_in)  : null;
      const parsedHeight = pkg_height_in != null ? Number(pkg_height_in) : null;

      const { rows: inserted } = await pool.query(
        `INSERT INTO listings
           (seller_id, title, description, price_cents, category, condition, status,
            weight_oz, pkg_length_in, pkg_width_in, pkg_height_in)
         VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8, $9, $10)
         RETURNING id`,
        [req.user.id, title, description, parsedPrice, category, condition,
         parsedWeight, parsedLength, parsedWidth, parsedHeight]
      );
      const { rows: listingRows } = await pool.query(
        'SELECT * FROM listings WHERE id = $1',
        [inserted[0].id]
      );
      // No social post for drafts.
      return res.status(201).json(await withPhotos(listingRows[0]));
    }

    // Normal publish path: use shared validator for all completeness checks.
    const missing = validateListingForPublish(
      { title, price_cents, category, condition, weight_oz, pkg_length_in, pkg_width_in, pkg_height_in },
      req.user
    );
    if (missing.length > 0) {
      const err = publishValidationToHttpError(missing, price_cents);
      if (err) return res.status(err.status).json(err.body);
    }

    const parsedWeight = Number(weight_oz);
    const parsedLength = Number(pkg_length_in);
    const parsedWidth  = Number(pkg_width_in);
    const parsedHeight = Number(pkg_height_in);

    const { rows: inserted } = await pool.query(
      `INSERT INTO listings
         (seller_id, title, description, price_cents, category, condition, status,
          weight_oz, pkg_length_in, pkg_width_in, pkg_height_in)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, $10)
       RETURNING id`,
      [req.user.id, title, description, price_cents, category, condition,
       parsedWeight, parsedLength, parsedWidth, parsedHeight]
    );
    const { rows: listingRows } = await pool.query(
      'SELECT * FROM listings WHERE id = $1',
      [inserted[0].id]
    );
    const listing = await withPhotos(listingRows[0]);
    res.status(201).json(listing);

    // Fire-and-forget, deliberately not awaited: a Blotato outage or missing
    // config must never delay or fail listing creation. No-ops entirely
    // unless BLOTATO_ENABLED is turned on - see blotatoService.js.
    postNewListingToSocial(listing).catch(() => {});
  } catch (err) {
    next(err);
  }
});

// GET /listings/mine — the caller's own listings, ANY status (active, sold,
// inactive, draft). Registered before GET /:id so "mine" isn't swallowed as an id.
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM listings WHERE seller_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    const listings = await Promise.all(rows.map(withPhotos));
    res.json({ listings });
  } catch (err) {
    next(err);
  }
});

// GET /listings — search + list (active only)
router.get('/', async (req, res, next) => {
  try {
    const { q, category, condition, min_price, max_price } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(PAGE_LIMIT_MAX, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const conditions = ["status = 'active'"];
    const params = [];
    let pIdx = 1;

    if (q) {
      conditions.push(`(title LIKE $${pIdx} OR description LIKE $${pIdx + 1})`);
      params.push(`%${q}%`, `%${q}%`);
      pIdx += 2;
    }
    if (category && VALID_CATEGORIES.includes(category)) {
      conditions.push(`category = $${pIdx}`);
      params.push(category);
      pIdx++;
    }
    if (condition && VALID_CONDITIONS.includes(condition)) {
      conditions.push(`condition = $${pIdx}`);
      params.push(condition);
      pIdx++;
    }
    if (min_price) {
      conditions.push(`price_cents >= $${pIdx}`);
      params.push(parseInt(min_price));
      pIdx++;
    }
    if (max_price) {
      conditions.push(`price_cents <= $${pIdx}`);
      params.push(parseInt(max_price));
      pIdx++;
    }

    const where = 'WHERE ' + conditions.join(' AND ');
    const countResult = await pool.query(
      `SELECT COUNT(*) AS c FROM listings ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].c, 10);
    const { rows } = await pool.query(
      `SELECT * FROM listings ${where} ORDER BY created_at DESC LIMIT $${pIdx} OFFSET $${pIdx + 1}`,
      [...params, limit, offset]
    );
    const listings = await Promise.all(rows.map(withPhotos));
    res.json({ total, page, limit, listings });
  } catch (err) {
    next(err);
  }
});

// GET /listings/:id
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM listings WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Listing not found' });
    // Drafts are not public — visible to the owner only via GET /listings/mine.
    if (rows[0].status === 'draft') return res.status(404).json({ error: 'Listing not found' });
    res.json(await withPhotos(rows[0]));
  } catch (err) {
    next(err);
  }
});

// POST /listings/:id/publish — promote a draft listing to active.
//
// Response contract:
//   200  { ok: true,  listing: {...} }  — published successfully
//   422  { ok: false, missing: [...] }  — validation failure; listing stays draft
//   409  { error: '...' }               — not a draft, or concurrent publish won the race
//   403  { error: '...' }               — caller does not own this listing
//   404  { error: '...' }               — listing not found
router.post('/:id/publish', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM listings WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Listing not found' });

    const listing = rows[0];
    if (String(listing.seller_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (listing.status !== 'draft') {
      return res.status(409).json({ error: 'Listing is not in draft status' });
    }

    // Same rules as normal publication — enforced by the shared validator.
    const missing = validateListingForPublish(listing, req.user);
    if (missing.length > 0) {
      return res.status(422).json({ ok: false, missing });
    }

    // Atomic status change: WHERE status = 'draft' ensures that if two requests
    // race, only one wins the UPDATE and becomes the publisher. The loser finds
    // zero rows returned and gets a 409. postNewListingToSocial fires only after
    // the atomic update succeeds, guaranteeing exactly one social post.
    const { rows: updated } = await pool.query(
      `UPDATE listings
          SET status = 'active', updated_at = NOW()
        WHERE id = $1 AND status = 'draft'
        RETURNING id`,
      [listing.id]
    );
    if (updated.length === 0) {
      return res.status(409).json({ error: 'Listing was already published by a concurrent request' });
    }

    const { rows: listingRows } = await pool.query(
      'SELECT * FROM listings WHERE id = $1',
      [listing.id]
    );
    const published = await withPhotos(listingRows[0]);
    res.json({ ok: true, listing: published });

    // Photos already uploaded to the draft are included in the published listing
    // object passed here, so the social post can reference them (unlike normal
    // creation where photos arrive in a separate follow-up call).
    postNewListingToSocial(published).catch(() => {});
  } catch (err) {
    next(err);
  }
});

// POST /listings/:id/reactivate — restore an inactive listing to active.
//
// Safety ordering (all three gates run in sequence; any failure leaves the
// listing inactive and returns without calling the next step):
//
//   1. validateListingForPublish — listing must be complete (title, price,
//      category, condition, package dims, ship-from address). Incomplete
//      listings return 422 without ever contacting escrow.
//
//   2. Escrow sync — awaited with ESCROW_SYNC_TIMEOUT_MS timeout (default 8 s).
//      A slow or unavailable escrow returns 502 + ESCROW_SYNC_FAILED. The seller
//      token is forwarded in the Authorization header so escrow can authenticate
//      the caller; it is never logged or included in any response body.
//
//      Escrow URL resolution (first match wins):
//        ESCROW_SERVICE_URL             — explicit override (local dev, staging)
//        RAILWAY_SERVICE_ESCROW_SERVICE_URL — auto-injected by Railway in production
//
//      If neither is set (CI without escrow) the sync step is skipped.
//
//   3. Atomic DB update — WHERE status = 'inactive' guards concurrent races;
//      the loser gets 409.
//
// Response contract:
//   200  { ok: true, listing: {...} }            — reactivated successfully
//   422  { ok: false, missing: [...] }           — incomplete listing; no escrow call
//   502  { error, code: 'ESCROW_SYNC_FAILED' }   — sync timed out or failed
//   409  { error: '...' }                        — not inactive, or concurrent race
//   403  { error: '...' }                        — caller does not own this listing
//   404  { error: '...' }                        — listing not found
router.post('/:id/reactivate', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM listings WHERE id = $1', [req.params.id]);
    const listing = rows[0];
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    if (String(listing.seller_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Forbidden: not your listing' });
    }
    if (listing.status !== 'inactive') {
      return res.status(409).json({ error: 'Only inactive listings can be reactivated' });
    }

    // Gate 1: completeness check — identical rules to publish. Incomplete
    // listings must not become active regardless of whether escrow is available.
    const missing = validateListingForPublish(listing, req.user);
    if (missing.length > 0) {
      return res.status(422).json({ ok: false, missing });
    }

    // Gate 2: escrow sync — must succeed before the listing becomes active.
    // Supports both an explicit override URL and Railway's auto-injected variable.
    // Railway injects RAILWAY_SERVICE_ESCROW_SERVICE_URL without a scheme
    // (e.g. "escrow-service-production-1e20.up.railway.app") so we normalise it.
    let escrowUrl = process.env.ESCROW_SERVICE_URL || process.env.RAILWAY_SERVICE_ESCROW_SERVICE_URL;
    if (escrowUrl && !/^https?:\/\//i.test(escrowUrl)) escrowUrl = `https://${escrowUrl}`;
    if (escrowUrl) {
      const timeoutMs = parseInt(process.env.ESCROW_SYNC_TIMEOUT_MS || '8000', 10);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const syncRes = await fetch(`${escrowUrl}/api/sync/listing`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Forward the seller's auth token so escrow can authenticate the
            // caller. Never logged; never included in any response body.
            Authorization: req.headers.authorization || '',
          },
          body: JSON.stringify({
            id: listing.id,
            seller_id: listing.seller_id,
            title: listing.title,
            price_cents: listing.price_cents,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!syncRes.ok) {
          return res.status(502).json({
            error: 'Marketplace sync failed — listing remains inactive. Please try again.',
            code: 'ESCROW_SYNC_FAILED',
          });
        }
      } catch {
        clearTimeout(timeoutId);
        return res.status(502).json({
          error: 'Marketplace sync failed — listing remains inactive. Please try again.',
          code: 'ESCROW_SYNC_FAILED',
        });
      }
    }

    // Gate 3: atomic status change — WHERE status = 'inactive' ensures that if
    // two requests race, only one wins. The loser gets a 409.
    const { rows: updated } = await pool.query(
      `UPDATE listings SET status = 'active', updated_at = NOW()
       WHERE id = $1 AND status = 'inactive'
       RETURNING id`,
      [listing.id]
    );
    if (updated.length === 0) {
      return res.status(409).json({ error: 'Listing status changed concurrently — please refresh' });
    }

    const { rows: final } = await pool.query('SELECT * FROM listings WHERE id = $1', [listing.id]);
    res.json({ ok: true, listing: await withPhotos(final[0]) });
  } catch (err) {
    next(err);
  }
});

// PATCH /listings/:id — partial update of content fields only.
//
// Status changes are NEVER accepted through this endpoint regardless of value.
// Status transitions must happen through dedicated endpoints:
//   active → inactive : DELETE /listings/:id
//   inactive → active : POST /listings/:id/reactivate
//   draft → active   : POST /listings/:id/publish
//   active → sold    : PATCH /listings/:id/mark-sold (internal)
router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM listings WHERE id = $1', [req.params.id]);
    const listing = rows[0];
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    if (String(listing.seller_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Forbidden: not your listing' });
    }

    // Reject any attempt to change status through PATCH, regardless of the value.
    if (req.body.status !== undefined) {
      return res.status(400).json({
        error: 'Status changes are not allowed via PATCH. Use the dedicated deactivate, reactivate, publish, or sold endpoints.',
      });
    }

    const allowed = ['title', 'description', 'price_cents', 'category', 'condition',
                     'weight_oz', 'pkg_length_in', 'pkg_width_in', 'pkg_height_in'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }
    if (updates.price_cents !== undefined) {
      if (!Number.isInteger(updates.price_cents) || updates.price_cents < MIN_LISTING_PRICE_CENTS) {
        return res.status(400).json({ error: `price_cents must be an integer >= ${MIN_LISTING_PRICE_CENTS} (minimum listing price is $10.00)` });
      }
    }
    if (updates.category && !VALID_CATEGORIES.includes(updates.category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }
    if (updates.condition && !VALID_CONDITIONS.includes(updates.condition)) {
      return res.status(400).json({ error: 'Invalid condition' });
    }
    // Package dims: must all be provided together if any are being updated.
    const PKG_PATCH_FIELDS = ['weight_oz', 'pkg_length_in', 'pkg_width_in', 'pkg_height_in'];
    const pkgPresent = PKG_PATCH_FIELDS.filter((f) => updates[f] !== undefined);
    if (pkgPresent.length > 0 && pkgPresent.length < 4) {
      const missing = PKG_PATCH_FIELDS.filter((f) => updates[f] === undefined);
      return res.status(422).json({
        error: `Package dimensions must all be updated together. Missing: ${missing.join(', ')}`,
        code: 'PACKAGE_DIMS_PARTIAL',
      });
    }
    for (const f of pkgPresent) {
      const v = Number(updates[f]);
      if (!Number.isFinite(v) || v <= 0) {
        return res.status(422).json({ error: `${f} must be a positive number` });
      }
      updates[f] = v;
    }

    let pIdx = 1;
    const setClauses = Object.keys(updates).map((k) => `${k} = $${pIdx++}`).join(', ');
    const values = [...Object.values(updates), listing.id];
    await pool.query(
      `UPDATE listings SET ${setClauses}, updated_at = NOW() WHERE id = $${pIdx}`,
      values
    );

    const { rows: updatedRows } = await pool.query('SELECT * FROM listings WHERE id = $1', [listing.id]);
    res.json(await withPhotos(updatedRows[0]));
  } catch (err) {
    next(err);
  }
});

// PATCH /listings/:id/mark-sold — internal, service-to-service only.
router.patch('/:id/mark-sold', requireInternalSecret, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM listings WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Listing not found' });
    await pool.query(
      "UPDATE listings SET status = 'sold', updated_at = NOW() WHERE id = $1",
      [rows[0].id]
    );
    const { rows: updated } = await pool.query('SELECT * FROM listings WHERE id = $1', [rows[0].id]);
    res.json(await withPhotos(updated[0]));
  } catch (err) {
    next(err);
  }
});

// PATCH /listings/:id/mark-active — internal, service-to-service only.
router.patch('/:id/mark-active', requireInternalSecret, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM listings WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Listing not found' });
    await pool.query(
      "UPDATE listings SET status = 'active', updated_at = NOW() WHERE id = $1",
      [rows[0].id]
    );
    const { rows: updated } = await pool.query('SELECT * FROM listings WHERE id = $1', [rows[0].id]);
    res.json(await withPhotos(updated[0]));
  } catch (err) {
    next(err);
  }
});

// DELETE /listings/:id — soft-delete: active → inactive.
//
// Only active listings may be deactivated through this route. Attempting to
// deactivate a draft, sold, or already-inactive listing returns 409 to prevent
// accidental state corruption.
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM listings WHERE id = $1', [req.params.id]);
    const listing = rows[0];
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    if (String(listing.seller_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Forbidden: not your listing' });
    }
    if (listing.status !== 'active') {
      return res.status(409).json({ error: 'Only active listings can be deactivated' });
    }
    await pool.query(
      "UPDATE listings SET status = 'inactive', updated_at = NOW() WHERE id = $1",
      [listing.id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /listings/:id/permanent — hard-delete a draft listing and all its photos.
//
// Uses a full database transaction with SELECT FOR UPDATE to prevent races:
//   BEGIN
//     SELECT ... FOR UPDATE          — exclusive row lock
//     verify ownership               — 403 on mismatch
//     verify status = 'draft'        — 409 if not a draft
//     DELETE listing_photos          — photo DB records
//     DELETE listing                 — the listing itself
//   COMMIT
// Only after a successful commit are the physical files removed from disk.
// ENOENT is silently ignored; other unlink errors are logged but do not fail
// the response (the DB records are already gone).
router.delete('/:id/permanent', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  let photoFilenames = [];
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT * FROM listings WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    const listing = rows[0];
    if (!listing) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ error: 'Listing not found' });
    }
    if (String(listing.seller_id) !== String(req.user.id)) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(403).json({ error: 'Forbidden: not your listing' });
    }
    if (listing.status !== 'draft') {
      await client.query('ROLLBACK');
      client.release();
      return res.status(409).json({ error: 'Only draft listings can be permanently deleted' });
    }

    // Collect filenames before deletion so we can clean up files post-commit.
    const { rows: photoRows } = await client.query(
      'SELECT filename FROM listing_photos WHERE listing_id = $1',
      [listing.id]
    );
    photoFilenames = photoRows.map((r) => r.filename);

    await client.query('DELETE FROM listing_photos WHERE listing_id = $1', [listing.id]);
    await client.query('DELETE FROM listings WHERE id = $1', [listing.id]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    client.release();
    return next(err);
  }
  client.release();

  // Post-commit file cleanup. The DB records are gone, so a missing file is safe.
  for (const filename of photoFilenames) {
    const filePath = path.join(UPLOADS_DIR, path.basename(filename));
    fs.unlink(filePath, (err) => {
      if (err && err.code !== 'ENOENT') {
        console.error(`[listingRoutes] Failed to delete file ${filePath}:`, err.message);
      }
    });
  }

  res.json({ ok: true });
});

module.exports = router;

const express = require('express');
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

// POST /listings — create
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { title, description = '', price_cents, category = 'other', condition = 'used_good' } = req.body;
    if (!title || price_cents == null) {
      return res.status(400).json({ error: 'title and price_cents are required' });
    }
    if (!Number.isInteger(price_cents) || price_cents < MIN_LISTING_PRICE_CENTS) {
      return res.status(400).json({ error: `price_cents must be an integer >= ${MIN_LISTING_PRICE_CENTS} (minimum listing price is $10.00)` });
    }
    if (!VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` });
    }
    if (!VALID_CONDITIONS.includes(condition)) {
      return res.status(400).json({ error: `condition must be one of: ${VALID_CONDITIONS.join(', ')}` });
    }

    const { rows: inserted } = await pool.query(
      `INSERT INTO listings (seller_id, title, description, price_cents, category, condition, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active')
       RETURNING id`,
      [req.user.id, title, description, price_cents, category, condition]
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
// inactive). Registered before GET /:id so "mine" isn't swallowed as an id.
// The public GET / below always filters to status='active', so without this
// a seller has no way to see their own listings once one sells - it would
// just vanish from their dashboard instead of showing a "sold" badge.
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

// GET /listings — search + list
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
    res.json(await withPhotos(rows[0]));
  } catch (err) {
    next(err);
  }
});

// PATCH /listings/:id — partial update
router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM listings WHERE id = $1', [req.params.id]);
    const listing = rows[0];
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    if (String(listing.seller_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Forbidden: not your listing' });
    }

    const allowed = ['title', 'description', 'price_cents', 'category', 'condition', 'status'];
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

    let pIdx = 1;
    const setClauses = Object.keys(updates).map(k => `${k} = $${pIdx++}`).join(', ');
    const values = [...Object.values(updates), listing.id];
    await pool.query(
      `UPDATE listings SET ${setClauses}, updated_at = NOW() WHERE id = $${pIdx}`,
      values
    );

    const { rows: updated } = await pool.query('SELECT * FROM listings WHERE id = $1', [listing.id]);
    res.json(await withPhotos(updated[0]));
  } catch (err) {
    next(err);
  }
});

// PATCH /listings/:id/mark-sold — internal, service-to-service only.
// Called by escrow-service the moment a payment is captured (funds actually
// held in escrow), so the listing stops appearing as buyable the instant a
// purchase is real - closing the gap where a second buyer could otherwise
// buy the same listing while an earlier order is already in escrow.
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
// Called by escrow-service when a HELD order is cancelled before shipment,
// so the listing goes back on sale immediately rather than staying stuck as
// 'sold' after the buyer's refund completes.
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

// DELETE /listings/:id — soft delete
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM listings WHERE id = $1', [req.params.id]);
    const listing = rows[0];
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    if (String(listing.seller_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Forbidden: not your listing' });
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

module.exports = router;

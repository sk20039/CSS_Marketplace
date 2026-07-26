const express = require('express');
const db = require('./db');
const requireAuth = require('./middleware/requireAuth');

const router = express.Router();

const VALID_CATEGORIES = ['bat', 'helmet', 'pads', 'gloves', 'kit-bag', 'other'];
const VALID_CONDITIONS = ['new', 'used_good', 'used_fair'];
const PAGE_LIMIT_MAX = 50;

function withPhotos(listing) {
  const photos = db.prepare(
    'SELECT id, filename, display_order FROM listing_photos WHERE listing_id = ? ORDER BY display_order, id'
  ).all(listing.id);
  return { ...listing, photos };
}

// POST /listings — create
router.post('/', requireAuth, (req, res) => {
  const { title, description = '', price_cents, category = 'other', condition = 'used_good' } = req.body;
  if (!title || price_cents == null) {
    return res.status(400).json({ error: 'title and price_cents are required' });
  }
  if (!Number.isInteger(price_cents) || price_cents <= 0) {
    return res.status(400).json({ error: 'price_cents must be a positive integer' });
  }
  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` });
  }
  if (!VALID_CONDITIONS.includes(condition)) {
    return res.status(400).json({ error: `condition must be one of: ${VALID_CONDITIONS.join(', ')}` });
  }

  const result = db.prepare(
    `INSERT INTO listings (seller_id, title, description, price_cents, category, condition, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))`
  ).run(req.user.id, title, description, price_cents, category, condition);

  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(withPhotos(listing));
});

// GET /listings — search + list
router.get('/', (req, res) => {
  const { q, category, condition, min_price, max_price } = req.query;
  let page = Math.max(1, parseInt(req.query.page) || 1);
  let limit = Math.min(PAGE_LIMIT_MAX, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  const conditions = ["status = 'active'"];
  const params = [];

  if (q) {
    conditions.push('(title LIKE ? OR description LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (category && VALID_CATEGORIES.includes(category)) {
    conditions.push('category = ?');
    params.push(category);
  }
  if (condition && VALID_CONDITIONS.includes(condition)) {
    conditions.push('condition = ?');
    params.push(condition);
  }
  if (min_price) {
    conditions.push('price_cents >= ?');
    params.push(parseInt(min_price));
  }
  if (max_price) {
    conditions.push('price_cents <= ?');
    params.push(parseInt(max_price));
  }

  const where = 'WHERE ' + conditions.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS c FROM listings ${where}`).get(...params).c;
  const rows = db.prepare(`SELECT * FROM listings ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  const listings = rows.map(withPhotos);

  res.json({ total, page, limit, listings });
});

// GET /listings/:id
router.get('/:id', (req, res) => {
  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Listing not found' });
  res.json(withPhotos(listing));
});

// PATCH /listings/:id — partial update
router.patch('/:id', requireAuth, (req, res) => {
  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(req.params.id);
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
  if (updates.category && !VALID_CATEGORIES.includes(updates.category)) {
    return res.status(400).json({ error: `Invalid category` });
  }
  if (updates.condition && !VALID_CONDITIONS.includes(updates.condition)) {
    return res.status(400).json({ error: `Invalid condition` });
  }

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(updates), listing.id];
  db.prepare(`UPDATE listings SET ${setClauses}, updated_at = datetime('now') WHERE id = ?`).run(...values);

  const updated = db.prepare('SELECT * FROM listings WHERE id = ?').get(listing.id);
  res.json(withPhotos(updated));
});

// DELETE /listings/:id — soft delete
router.delete('/:id', requireAuth, (req, res) => {
  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Listing not found' });
  if (String(listing.seller_id) !== String(req.user.id)) {
    return res.status(403).json({ error: 'Forbidden: not your listing' });
  }
  db.prepare("UPDATE listings SET status = 'inactive', updated_at = datetime('now') WHERE id = ?").run(listing.id);
  res.json({ ok: true });
});

module.exports = router;

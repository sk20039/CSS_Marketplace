'use strict';

const express = require('express');
const db = require('./db');
const requireAuth = require('./middleware/requireAuth');
const { scoreListingQuality } = require('./seoScorer');
const { generateSeoSuggestions } = require('./claudeClient');

const router = express.Router();

// Shared helper — same pattern as listingRoutes.js withPhotos
function withPhotos(listing) {
  const photos = db.prepare(
    'SELECT id, filename, display_order FROM listing_photos WHERE listing_id = ? ORDER BY display_order, id'
  ).all(listing.id);
  return { ...listing, photos };
}

// ---------------------------------------------------------------------------
// POST /listings/:id/seo/audit
// Authenticated. Runs the quality scorer + SEO suggestion generator and
// returns the results WITHOUT persisting them (audit only).
// ---------------------------------------------------------------------------
router.post('/:id/seo/audit', requireAuth, async (req, res, next) => {
  try {
    const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    if (String(listing.seller_id) !== String(req.user.id) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: not your listing' });
    }

    const listingWithPhotos = withPhotos(listing);
    const { score, tier, breakdown, issues } = scoreListingQuality(listingWithPhotos);
    const suggestions = await generateSeoSuggestions(listingWithPhotos);
    const { claude_used, ...suggestionFields } = suggestions;

    return res.json({
      listing_id: listing.id,
      quality_score: score,
      score_tier: tier,
      score_breakdown: breakdown,
      issues,
      suggestions: suggestionFields,
      claude_used: claude_used ?? false,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /listings/:id/seo/apply
// Authenticated. Seller only. Applies SEO fields to the listing and
// re-scores the quality_score column.
// ---------------------------------------------------------------------------
router.post('/:id/seo/apply', requireAuth, (req, res, next) => {
  try {
    const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    if (String(listing.seller_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Forbidden: not your listing' });
    }

    const { title, description, meta_title, meta_description, tags } = req.body;

    // Validation
    if (meta_title !== undefined && meta_title !== null) {
      if (typeof meta_title !== 'string' || meta_title.length > 60) {
        return res.status(400).json({ error: 'meta_title must be a string of max 60 characters' });
      }
    }
    if (meta_description !== undefined && meta_description !== null) {
      if (typeof meta_description !== 'string' || meta_description.length > 155) {
        return res.status(400).json({ error: 'meta_description must be a string of max 155 characters' });
      }
    }

    // Validate title and description
    if (title !== undefined) {
      if (title === null || typeof title !== 'string' || title.trim().length === 0) {
        return res.status(400).json({ error: 'title must be a non-empty string' });
      }
    }
    if (description !== undefined && description !== null && typeof description !== 'string') {
      return res.status(400).json({ error: 'description must be a string' });
    }
    if (tags !== undefined && !Array.isArray(tags)) {
      return res.status(400).json({ error: 'tags must be an array of strings' });
    }

    // Build update fields
    const updates = {};
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (meta_title !== undefined) updates.meta_title = meta_title;
    if (meta_description !== undefined) updates.meta_description = meta_description;
    if (tags !== undefined) updates.tags = JSON.stringify(tags);

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid SEO fields provided' });
    }

    const setClauses = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    const values = [...Object.values(updates), listing.id];
    db.prepare(`UPDATE listings SET ${setClauses}, updated_at = datetime('now') WHERE id = ?`).run(...values);

    // Re-fetch and re-score so quality_score reflects the applied changes
    const updated = db.prepare('SELECT * FROM listings WHERE id = ?').get(listing.id);
    const updatedWithPhotos = withPhotos(updated);
    const { score } = scoreListingQuality(updatedWithPhotos);
    db.prepare('UPDATE listings SET quality_score = ? WHERE id = ?').run(score, listing.id);

    const final = db.prepare('SELECT * FROM listings WHERE id = ?').get(listing.id);
    return res.json(withPhotos(final));
  } catch (err) {
    next(err);
  }
});

module.exports = router;

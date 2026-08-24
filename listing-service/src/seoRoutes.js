'use strict';

const express = require('express');
const pool = require('./db');
const requireAuth = require('./middleware/requireAuth');
const { scoreListingQuality } = require('./seoScorer');
const { generateSeoSuggestions } = require('./claudeClient');

const router = express.Router();

// Shared helper — same pattern as listingRoutes.js withPhotos
async function withPhotos(listing) {
  const { rows } = await pool.query(
    'SELECT id, filename, display_order FROM listing_photos WHERE listing_id = $1 ORDER BY display_order, id',
    [listing.id]
  );
  return { ...listing, photos: rows };
}

// ---------------------------------------------------------------------------
// POST /listings/:id/seo/audit
// Authenticated. Runs the quality scorer + SEO suggestion generator and
// returns the results WITHOUT persisting them (audit only).
// ---------------------------------------------------------------------------
router.post('/:id/seo/audit', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM listings WHERE id = $1', [req.params.id]);
    const listing = rows[0];
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    if (String(listing.seller_id) !== String(req.user.id) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: not your listing' });
    }

    const listingWithPhotos = await withPhotos(listing);
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
router.post('/:id/seo/apply', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM listings WHERE id = $1', [req.params.id]);
    const listing = rows[0];
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

    let pIdx = 1;
    const setClauses = Object.keys(updates).map((k) => `${k} = $${pIdx++}`).join(', ');
    const values = [...Object.values(updates), listing.id];
    await pool.query(
      `UPDATE listings SET ${setClauses}, updated_at = NOW() WHERE id = $${pIdx}`,
      values
    );

    // Re-fetch and re-score so quality_score reflects the applied changes
    const { rows: updatedRows } = await pool.query('SELECT * FROM listings WHERE id = $1', [listing.id]);
    const updatedWithPhotos = await withPhotos(updatedRows[0]);
    const { score } = scoreListingQuality(updatedWithPhotos);
    await pool.query('UPDATE listings SET quality_score = $1 WHERE id = $2', [score, listing.id]);

    const { rows: finalRows } = await pool.query('SELECT * FROM listings WHERE id = $1', [listing.id]);
    return res.json(await withPhotos(finalRows[0]));
  } catch (err) {
    next(err);
  }
});

module.exports = router;

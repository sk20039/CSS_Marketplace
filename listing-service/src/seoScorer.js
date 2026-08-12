'use strict';

const CRICKET_BRANDS = [
  'gray-nicolls', 'kookaburra', 'gunn & moore', 'gm', 'sg', 'mrf', 'ss',
  'dukes', 'readers', 'newbery', 'puma', 'adidas', 'salix', 'spartan', 'ca sports',
];

const CRICKET_VOCAB = [
  'english willow', 'kashmir willow', 'sweet spot', 'edges', 'handle', 'grip',
  'linseed', 'toe guard', 'weight', 'oz', 'grams', 'ping', 'short handle',
  'long handle', 'scalloped', 'bow', 'spine',
];

const CATEGORY_KEYWORDS = ['bat', 'helmet', 'pads', 'gloves', 'kit bag'];
const CONDITION_SIGNALS = ['new', 'used', 'grade 1', 'grade 2', 'grade 3', 'lightly used'];

function scoreTier(score) {
  if (score >= 85) return 'Excellent';
  if (score >= 65) return 'Good';
  if (score >= 40) return 'Good start';
  return 'Needs work';
}

/**
 * Pure function — no side effects, no I/O.
 *
 * @param {object} listing - listing row from DB, may include `photos` array
 * @returns {{ score: number, tier: string, breakdown: object, issues: string[] }}
 */
function scoreListingQuality(listing) {
  const breakdown = {};
  const issues = [];

  const title = (listing.title || '').toLowerCase();
  const description = (listing.description || '').toLowerCase();
  const photos = listing.photos || [];

  // --- Title length (max 10) ---
  const titleLen = (listing.title || '').length;
  let titleLengthScore = 0;
  if (titleLen >= 50 && titleLen <= 120) titleLengthScore = 10;
  else if (titleLen >= 30) titleLengthScore = 8;
  else if (titleLen >= 10) titleLengthScore = 5;
  else if (titleLen > 0) titleLengthScore = 0;
  if (titleLen < 10) issues.push('Title is too short — add the brand name and equipment type');
  breakdown.title_length = titleLengthScore;

  // --- Title has brand keyword (max 10) ---
  let brandScore = 0;
  for (const brand of CRICKET_BRANDS) {
    if (title.includes(brand)) brandScore = Math.min(10, brandScore + 5);
  }
  if (brandScore === 0) issues.push('Add a brand name to your title (e.g. Gray-Nicolls, Kookaburra, GM)');
  breakdown.title_brand = brandScore;

  // --- Title has category keyword (max 5) ---
  const hasCategoryKw = CATEGORY_KEYWORDS.some((kw) => title.includes(kw));
  breakdown.title_category = hasCategoryKw ? 5 : 0;

  // --- Title has condition signal (max 5) ---
  const hasConditionSignal = CONDITION_SIGNALS.some((s) => title.includes(s));
  breakdown.title_condition = hasConditionSignal ? 5 : 0;

  // --- Description length (max 15) ---
  const descLen = (listing.description || '').length;
  let descLengthScore = 0;
  if (descLen >= 150) descLengthScore = 15;
  else if (descLen >= 50) descLengthScore = 10;
  else if (descLen >= 1) descLengthScore = 5;
  if (descLen === 0) issues.push('Description is missing — buyers want to know age, weight, and any damage');
  else if (descLen < 50) issues.push('Description is very short — aim for at least 150 characters');
  breakdown.description_length = descLengthScore;

  // --- Description has cricket terms (max 10) ---
  let vocabScore = 0;
  for (const term of CRICKET_VOCAB) {
    if (description.includes(term)) vocabScore = Math.min(10, vocabScore + 2);
  }
  if (vocabScore === 0 && descLen > 0) {
    issues.push('Add cricket-specific details like willow type, weight, or grade');
  }
  breakdown.description_cricket_terms = vocabScore;

  // --- Has >= 1 photo (max 15) ---
  const photoCount = photos.length;
  const hasPhoto = photoCount >= 1;
  breakdown.has_photo = hasPhoto ? 15 : 0;
  if (!hasPhoto) issues.push('No photos uploaded — listings with photos get far more interest');

  // --- Has >= 3 photos bonus (max 5) ---
  breakdown.has_three_photos = photoCount >= 3 ? 5 : 0;

  // --- Price > 0 (max 5) — always true for persisted listings ---
  breakdown.has_price = (listing.price_cents || 0) > 0 ? 5 : 0;

  // --- Category != 'other' (max 5) ---
  breakdown.specific_category = listing.category && listing.category !== 'other' ? 5 : 0;
  if (!listing.category || listing.category === 'other') {
    issues.push("Set a specific category (e.g. Bat, Helmet) instead of 'Other'");
  }

  // --- meta_title filled (max 5) ---
  breakdown.meta_title = listing.meta_title ? 5 : 0;
  if (!listing.meta_title) issues.push('Add an SEO title (meta_title) to improve Google visibility');

  // --- meta_description filled (max 5) ---
  breakdown.meta_description = listing.meta_description ? 5 : 0;
  if (!listing.meta_description) issues.push('Add an SEO description (meta_description) to improve click-through rates');

  // --- tags present >= 3 (max 5) ---
  let parsedTags = [];
  try {
    parsedTags = listing.tags ? JSON.parse(listing.tags) : [];
  } catch { parsedTags = []; }
  breakdown.tags = Array.isArray(parsedTags) && parsedTags.length >= 3 ? 5 : 0;
  if (!Array.isArray(parsedTags) || parsedTags.length < 3) {
    issues.push('Add at least 3 tags so buyers can find your listing more easily');
  }

  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const tier = scoreTier(score);

  return { score, tier, breakdown, issues };
}

module.exports = { scoreListingQuality, scoreTier };

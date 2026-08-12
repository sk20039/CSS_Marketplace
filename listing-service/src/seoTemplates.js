'use strict';

const CRICKET_BRANDS = [
  'gray-nicolls', 'kookaburra', 'gunn & moore', 'gm', 'sg', 'mrf', 'ss',
  'dukes', 'readers', 'newbery', 'puma', 'adidas', 'salix', 'spartan', 'ca sports',
];

const CATEGORY_LABELS = {
  bat: 'Cricket Bat',
  helmet: 'Cricket Helmet',
  pads: 'Cricket Pads',
  gloves: 'Cricket Gloves',
  'kit-bag': 'Cricket Kit Bag',
  other: 'Cricket Equipment',
};

const CONDITION_LABELS = {
  new: 'New',
  used_good: 'Used – Good Condition',
  used_fair: 'Used – Fair Condition',
};

// Brand-to-canonical-display-name mapping for nicer casing in suggestions.
const BRAND_DISPLAY = {
  'gray-nicolls': 'Gray-Nicolls',
  kookaburra: 'Kookaburra',
  'gunn & moore': 'Gunn & Moore',
  gm: 'GM',
  sg: 'SG',
  mrf: 'MRF',
  ss: 'SS',
  dukes: 'Dukes',
  readers: 'Readers',
  newbery: 'Newbery',
  puma: 'Puma',
  adidas: 'Adidas',
  salix: 'Salix',
  spartan: 'Spartan',
  'ca sports': 'CA Sports',
};

/**
 * Extract the first matching brand from the listing title.
 * Returns { key, display } or null.
 */
function extractBrand(title) {
  const lower = (title || '').toLowerCase();
  for (const brand of CRICKET_BRANDS) {
    if (lower.includes(brand)) {
      return { key: brand, display: BRAND_DISPLAY[brand] || brand };
    }
  }
  return null;
}

/**
 * Rules-based SEO suggestion generator. Pure function, no I/O.
 *
 * @param {object} listing
 * @returns {{ title: string, description: string, meta_title: string, meta_description: string, tags: string[] }}
 */
function generateTemplatedSuggestions(listing) {
  const categoryLabel = CATEGORY_LABELS[listing.category] || 'Cricket Equipment';
  const conditionLabel = CONDITION_LABELS[listing.condition] || listing.condition || '';
  const brand = extractBrand(listing.title);

  // Suggested title
  let suggestedTitle;
  if (brand) {
    suggestedTitle = `${brand.display} ${categoryLabel} – ${conditionLabel}`;
  } else {
    suggestedTitle = `${categoryLabel} – ${conditionLabel} | ${listing.title}`;
  }

  // meta_title: truncated to 60 chars
  const rawMetaTitle = `${suggestedTitle} | Cricket Market`;
  const meta_title = rawMetaTitle.length > 60 ? rawMetaTitle.slice(0, 57) + '…' : rawMetaTitle;

  // meta_description: first 155 chars of description if long enough, else template
  const desc = (listing.description || '').trim();
  let meta_description;
  if (desc.length >= 50) {
    meta_description = desc.length > 155 ? desc.slice(0, 152) + '…' : desc;
  } else {
    const fallback = `Buy a ${conditionLabel.toLowerCase()} ${categoryLabel.toLowerCase()} on Cricket Market. ${listing.title}.`;
    meta_description = fallback.length > 155 ? fallback.slice(0, 152) + '…' : fallback;
  }

  // tags: brand + category + condition + universal
  const tags = [];
  if (brand) tags.push(brand.display.toLowerCase(), brand.key);
  // Dedupe brand key vs display
  const uniqueTags = [...new Set([...tags])];

  uniqueTags.push(categoryLabel.toLowerCase());
  if (listing.category && listing.category !== 'other') uniqueTags.push(listing.category);
  if (conditionLabel) uniqueTags.push(conditionLabel.toLowerCase());
  uniqueTags.push('cricket equipment', 'USA cricket', 'buy cricket gear');

  // Final dedup
  const finalTags = [...new Set(uniqueTags)];

  return {
    title: suggestedTitle,
    description: listing.description || '', // unchanged — too risky to auto-rewrite prose
    meta_title,
    meta_description,
    tags: finalTags,
  };
}

module.exports = { generateTemplatedSuggestions };

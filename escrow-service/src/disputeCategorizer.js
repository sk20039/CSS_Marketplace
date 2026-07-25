// Auto-tags a free-text dispute reason against PRD §7's known valid/invalid
// dispute reason categories. This is informational only for the admin -
// per the Architect's plan, filing is NEVER hard-blocked based on this tag.
//
// Valid (buyer-favor leaning) reasons from the PRD:
//   - major undisclosed crack/damage
//   - fake/counterfeit
//   - wrong item received
//   - major mismatch from photos
// Invalid (seller-favor leaning) reasons from the PRD:
//   - changed mind
//   - doesn't like pickup/feel
//   - bat heavier than expected, IF weight was disclosed on the listing
//
// Coder's scope call: the current data model (build plan §Data model) does not
// track per-listing disclosed specs (e.g. "weight disclosed: yes/no"), so we
// cannot conditionally evaluate the "if weight was disclosed" clause. Any
// weight/heaviness complaint is conservatively tagged 'invalid' by default.
// This is flagged in the README/summary as an assumption beyond the plan's
// explicit spec, not a silent guess.

const VALID_PATTERNS = [
  /\bcrack(?:s|ed|ing)?\b/i,
  /\b(major )?damage[ds]?\b/i,
  /\bcounterfeit\b/i,
  /\bfake\b/i,
  /\bnot authentic\b/i,
  /\bwrong item\b/i,
  /\bwrong product\b/i,
  /\breceived.*wrong\b/i,
  /\b(doesn't|does not|didn't|did not) match.*photo/i,
  /\bmismatch.*photo/i,
  /\bphoto.*mismatch/i,
  /\bdifferent (item|product) than (the )?photo/i,
];

const INVALID_PATTERNS = [
  /change[sd]? (my |his |her |their )?mind/i,
  /don'?t (like|want) (it|the) (pickup|feel|grip)/i,
  /doesn'?t (like|feel) (right|good)/i,
  /not a fan of the feel/i,
  /pickup feel/i,
  /heavier than expected/i,
  /too heavy/i,
  /weight (feels|is) (off|different)/i,
];

function categorizeDispute(reasonText) {
  const text = (reasonText || '').trim();
  if (!text) {
    return { category: 'uncategorized', matchedPattern: null };
  }

  for (const pattern of VALID_PATTERNS) {
    if (pattern.test(text)) {
      return { category: 'valid', matchedPattern: pattern.toString() };
    }
  }
  for (const pattern of INVALID_PATTERNS) {
    if (pattern.test(text)) {
      return { category: 'invalid', matchedPattern: pattern.toString() };
    }
  }
  return { category: 'uncategorized', matchedPattern: null };
}

module.exports = { categorizeDispute };

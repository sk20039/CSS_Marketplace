'use strict';

/**
 * Structural content tests for the Privacy Policy page.
 * Verifies that the PostHog analytics disclosure is present, accurate, and
 * free of prohibited claims. Reads the source file directly — no browser needed.
 * Run with: node frontend/tests/privacyPolicy.test.js
 */

const fs   = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'legal', 'privacy', 'page.tsx'),
  'utf8'
);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

function assertContains(text, msg) {
  if (!src.includes(text)) throw new Error(msg || `Expected to find: ${JSON.stringify(text)}`);
}

function assertAbsent(text, msg) {
  if (src.includes(text)) throw new Error(msg || `Must NOT contain: ${JSON.stringify(text)}`);
}

// ── Last Updated date ─────────────────────────────────────────────────────

console.log('\nLast Updated date');
test('updated date is September 28, 2026', () =>
  assertContains('September 28, 2026'));

// ── Attorney review notice ────────────────────────────────────────────────

console.log('\nAttorney review notice');
test('attorney review notice is present', () =>
  assertContains('draft for attorney review'));
test('notice says subject to revision', () =>
  assertContains('subject\n        to revision before public launch'));

// ── Section 1.2 — Product analytics entry ─────────────────────────────────

console.log('\nSection 1.2 — Product analytics disclosure');

test('PostHog named as product analytics service', () =>
  assertContains('We use PostHog, a product analytics service'));

test('purpose stated: understand how visitors and registered users use Cricket Market', () =>
  assertContains('understand how visitors and registered users use Cricket Market'));

test('page origin and path listed', () =>
  assertContains('origin and path of pages visited'));

test('listing and order identifiers listed', () =>
  assertContains('listing and order identifiers'));

test('item category and condition listed', () =>
  assertContains('item\n          category, condition'));

test('broad price range listed (not exact price)', () =>
  assertContains('broad price range'));

test('search result count listed', () =>
  assertContains('search result count'));

test('whether text search was used listed', () =>
  assertContains('whether a text search was used'));

test('registration and login completion listed', () =>
  assertContains('registration and login completion'));

test('listing draft and publication steps listed', () =>
  assertContains('listing draft and publication steps'));

test('checkout and transaction milestones listed', () =>
  assertContains('checkout and\n          transaction milestones'));

test('shipping carrier and service listed', () =>
  assertContains('shipping carrier and service'));

test('browser type and version listed', () =>
  assertContains('browser type and version'));

test('device type listed', () =>
  assertContains('device\n          type'));

test('browser language listed', () =>
  assertContains('browser language'));

test('anonymous identifier for logged-out visitors described', () =>
  assertContains('temporary anonymous identifier held in browser memory'));

test('internal numeric account ID for logged-in users described', () =>
  assertContains('internal numeric account ID'));

test('logged-in events described as pseudonymous', () =>
  assertContains('those events are pseudonymous'));

test('URL query strings and fragments removed stated', () =>
  assertContains('URL query\n          strings and fragments are removed from page addresses before transmission'));

test('GeoIP enrichment disabled stated', () =>
  assertContains('GeoIP\n          enrichment is disabled'));

test('city, country, location not received stated', () =>
  assertContains('do not receive city, country, or approximate location data'));

test('names not intentionally transmitted', () =>
  assertContains('We do not intentionally transmit to PostHog: names'));

test('email addresses not intentionally transmitted', () =>
  assertContains('email addresses'));

test('phone numbers not intentionally transmitted', () =>
  assertContains('phone\n          numbers'));

test('postal addresses not intentionally transmitted', () =>
  assertContains('postal addresses'));

test('passwords not intentionally transmitted', () =>
  assertContains('passwords'));

test('authentication tokens not intentionally transmitted', () =>
  assertContains('authentication tokens'));

test('payment card details not intentionally transmitted', () =>
  assertContains('payment card details'));

test('private messages not intentionally transmitted', () =>
  assertContains('private messages'));

test('listing descriptions not intentionally transmitted', () =>
  assertContains('listing descriptions'));

test('raw search text not intentionally transmitted', () =>
  assertContains('raw search text'));

test('exact listing prices not intentionally transmitted', () =>
  assertContains('exact listing prices'));

test('exact payment amounts not intentionally transmitted', () =>
  assertContains('exact\n          payment amounts'));

test('shipping tracking numbers not intentionally transmitted', () =>
  assertContains('shipping tracking numbers'));

// ── Prohibited claims — Section 1.2 new text ─────────────────────────────

console.log('\nProhibited claims');

test('new product analytics entry does not claim all data is anonymized', () => {
  // The word 'anonymized' may exist elsewhere (Section 2 existing text) but must not
  // appear within the new product analytics LI block.
  const liStart = src.indexOf('<strong>Product analytics:</strong>');
  const liEnd   = src.indexOf('</LI>', liStart);
  const liText  = liStart > -1 && liEnd > -1 ? src.slice(liStart, liEnd) : '';
  if (liText.includes('anonymized')) {
    throw new Error('Product analytics entry must not claim all data is anonymized');
  }
});

test('new product analytics entry does not claim PostHog cannot receive IP', () => {
  const liStart = src.indexOf('<strong>Product analytics:</strong>');
  const liEnd   = src.indexOf('</LI>', liStart);
  const liText  = liStart > -1 && liEnd > -1 ? src.slice(liStart, liEnd) : '';
  if (liText.toLowerCase().includes('ip address') || liText.includes('cannot receive')) {
    throw new Error('Product analytics entry must not claim PostHog cannot receive an IP address');
  }
});

// ── Section 3.2 — PostHog service provider entry ─────────────────────────

console.log('\nSection 3.2 — PostHog service provider');

test('PostHog, Inc. listed as service provider', () =>
  assertContains('<strong>PostHog, Inc.</strong>'));

test('PostHog US Cloud stated', () =>
  assertContains('PostHog US Cloud'));

test('references analytics events in Section 1.2', () =>
  assertContains('analytics events described in'));

test('session recording not enabled stated', () =>
  assertContains('Session recording'));

test('automatic interaction capture not enabled stated', () =>
  assertContains('automatic interaction capture'));

test('heatmaps not enabled stated', () =>
  assertContains('heatmaps'));

test('GeoIP enrichment not enabled stated in Section 3.2', () => {
  const posthogLiStart = src.indexOf('<strong>PostHog, Inc.</strong>');
  const posthogLiEnd   = src.indexOf('</LI>', posthogLiStart);
  const posthogLiText  = posthogLiStart > -1 && posthogLiEnd > -1
    ? src.slice(posthogLiStart, posthogLiEnd) : '';
  if (!posthogLiText.includes('GeoIP')) {
    throw new Error('PostHog service provider entry must mention GeoIP enrichment');
  }
});

test('advertising tracking not enabled stated', () =>
  assertContains('advertising tracking are not enabled'));

test('Section 3.2 does not claim no browser fingerprinting', () => {
  const posthogLiStart = src.indexOf('<strong>PostHog, Inc.</strong>');
  const posthogLiEnd   = src.indexOf('</LI>', posthogLiStart);
  const posthogLiText  = posthogLiStart > -1 && posthogLiEnd > -1
    ? src.slice(posthogLiStart, posthogLiEnd) : '';
  if (posthogLiText.includes('fingerprint')) {
    throw new Error('PostHog entry must not claim no browser fingerprinting');
  }
});

// ── Section 5 — Cookies update ────────────────────────────────────────────

console.log('\nSection 5 — Cookies & Session Tokens update');

test('conflicting analytics cookies sentence is removed', () =>
  assertAbsent(
    'We do not use advertising cookies, analytics cookies, or third-party tracking pixels.',
    'Old conflicting sentence must be replaced'
  ));

test('advertising cookies still disclaimed (without analytics cookies claim)', () =>
  assertContains('We do not use advertising cookies or third-party tracking pixels'));

test('PostHog configured without persistent analytics cookie stated', () =>
  assertContains('configured without a persistent analytics cookie or localStorage'));

test('anonymous identifier held in browser memory stated', () =>
  assertContains('anonymous session identifier is held in browser memory'));

test('resets on full reload or tab close stated', () =>
  assertContains('resets when the page\n        is fully reloaded or the tab is closed'));

test('logged-in users may be associated across sessions through login stated', () =>
  assertContains('Activity by logged-in users may be associated with\n        the same internal account ID across sessions'));

test('analytics not used for cross-site advertising stated', () =>
  assertContains('Analytics are not used for cross-site advertising'));

// ── Existing contact section preserved ────────────────────────────────────

console.log('\nContact section preserved');

test('privacy contact email expression present', () =>
  assertContains('{SITE.email}'));

test('company legal name expression present', () =>
  assertContains('{SITE.legalName}'));

test('Privacy Request subject line present', () =>
  assertContains('Privacy Request'));

// ── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

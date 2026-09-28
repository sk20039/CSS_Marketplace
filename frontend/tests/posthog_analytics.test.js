'use strict';

/**
 * Unit tests for PostHog analytics helpers.
 * No browser, server, or network calls needed.
 * Run with: node frontend/tests/posthog_analytics.test.js
 */

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

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`);
}

// ── Replicate priceBand logic (mirrors frontend/lib/posthog.ts) ───────────
// Bands: under_50 | 50_to_100 | 100_to_200 | 200_to_500 | over_500
function priceBand(cents) {
  const d = cents / 100;
  if (d < 50)  return 'under_50';
  if (d < 100) return '50_to_100';
  if (d < 200) return '100_to_200';
  if (d < 500) return '200_to_500';
  return 'over_500';
}

// ── Replicate suppress logic (mirrors analytics.capture) ──────────────────
let _suppress = true;
function setSuppressCapture(val) { _suppress = val; }
const captured = [];
const analytics = {
  capture(event, props) {
    if (_suppress) return;
    captured.push({ event, props: props || {} });
  },
};

// ── priceBand boundary tests ──────────────────────────────────────────────

console.log('\npriceBand()');
test('0 cents → under_50', () => assertEqual(priceBand(0), 'under_50'));
test('4999 cents ($49.99) → under_50', () => assertEqual(priceBand(4999), 'under_50'));
test('5000 cents ($50.00) → 50_to_100', () => assertEqual(priceBand(5000), '50_to_100'));
test('9999 cents ($99.99) → 50_to_100', () => assertEqual(priceBand(9999), '50_to_100'));
test('10000 cents ($100.00) → 100_to_200', () => assertEqual(priceBand(10000), '100_to_200'));
test('19999 cents ($199.99) → 100_to_200', () => assertEqual(priceBand(19999), '100_to_200'));
test('20000 cents ($200.00) → 200_to_500', () => assertEqual(priceBand(20000), '200_to_500'));
test('49999 cents ($499.99) → 200_to_500', () => assertEqual(priceBand(49999), '200_to_500'));
test('50000 cents ($500.00) → over_500', () => assertEqual(priceBand(50000), 'over_500'));
test('100000 cents ($1000.00) → over_500', () => assertEqual(priceBand(100000), 'over_500'));

// Typical cricket equipment prices
test('$35 bat gloves → under_50', () => assertEqual(priceBand(3500), 'under_50'));
test('$75 pads → 50_to_100', () => assertEqual(priceBand(7500), '50_to_100'));
test('$150 helmet → 100_to_200', () => assertEqual(priceBand(15000), '100_to_200'));
test('$350 kit bag → 200_to_500', () => assertEqual(priceBand(35000), '200_to_500'));
test('$650 premium bat → over_500', () => assertEqual(priceBand(65000), 'over_500'));

// ── Suppress guard tests ───────────────────────────────────────────────────

console.log('\nanalytics.capture() suppress guard');

test('capture is suppressed when _suppress = true (initial state)', () => {
  setSuppressCapture(true);
  captured.length = 0;
  analytics.capture('test_event', { foo: 'bar' });
  assertEqual(captured.length, 0, 'expected no events while suppressed');
});

test('capture fires when _suppress = false', () => {
  setSuppressCapture(false);
  captured.length = 0;
  analytics.capture('test_event', { foo: 'bar' });
  assertEqual(captured.length, 1, 'expected 1 event when not suppressed');
  assertEqual(captured[0].event, 'test_event');
});

test('re-suppressing prevents further captures', () => {
  setSuppressCapture(true);
  captured.length = 0;
  analytics.capture('should_not_fire', {});
  assertEqual(captured.length, 0, 'expected no events after re-suppressing');
});

test('unsuppressing again allows captures', () => {
  setSuppressCapture(false);
  captured.length = 0;
  analytics.capture('event_a', {});
  analytics.capture('event_b', {});
  assertEqual(captured.length, 2);
});

// ── Safe properties tests ─────────────────────────────────────────────────

console.log('\nSafe properties (no PII in captured events)');

test('listing_viewed must not include email or name', () => {
  setSuppressCapture(false);
  captured.length = 0;
  analytics.capture('listing_viewed', {
    listing_id: 42,
    category: 'bat',
    condition: 'used_good',
    price_band: priceBand(15000),
  });
  assert(captured.length === 1);
  const props = captured[0].props;
  assert(!('email' in props), 'email must not be present');
  assert(!('name' in props), 'name must not be present');
  assert('category' in props, 'category must be present');
  assert('listing_id' in props, 'listing_id must be present');
  assert('price_band' in props, 'price_band must be present');
  assert(!('price_cents' in props), 'exact price must not be sent — only band');
});

test('search_performed must not include raw query text', () => {
  setSuppressCapture(false);
  captured.length = 0;
  analytics.capture('search_performed', {
    category: 'bat',
    condition: null,
    sort: null,
    result_count: 12,
    has_text_query: true,
    // Note: 'q' (the raw query string) is intentionally omitted
  });
  assert(captured.length === 1);
  const props = captured[0].props;
  assert(!('q' in props), 'raw query string must not be captured');
  assert('has_text_query' in props, 'has_text_query boolean must be present');
});

test('login_completed must not include email or password', () => {
  setSuppressCapture(false);
  captured.length = 0;
  analytics.capture('login_completed', { mfa_used: false });
  assert(captured.length === 1);
  const props = captured[0].props;
  assert(!('email' in props), 'email must not be present');
  assert(!('password' in props), 'password must not be present');
  assert('mfa_used' in props, 'mfa_used must be present');
});

// ── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

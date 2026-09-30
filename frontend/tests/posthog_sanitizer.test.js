'use strict';

/**
 * Tests for PostHog privacy sanitizer.
 * Mirrors the logic in frontend/lib/posthogSanitizer.ts.
 * Run with: node frontend/tests/posthog_sanitizer.test.js
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

// ── Replicate sanitizeUrl from frontend/lib/posthogSanitizer.ts ──────────

const URL_PROPS = [
  '$current_url',
  '$referrer',
  '$initial_current_url',
  '$initial_referrer',
  '$session_entry_url',
  '$session_entry_referrer',
];

function sanitizeUrl(raw) {
  if (!raw || raw.startsWith('$')) return raw;
  try {
    const u = new URL(raw);
    return u.origin + u.pathname;
  } catch {
    return raw;
  }
}

function sanitizeBeforeSend(event) {
  if (!event) return null;
  const props = { ...event.properties };
  for (const key of URL_PROPS) {
    if (typeof props[key] === 'string') {
      props[key] = sanitizeUrl(props[key]);
    }
  }
  props.$geoip_disable = true;
  return { ...event, properties: props };
}

// ── sanitizeUrl ───────────────────────────────────────────────────────────

console.log('\nsanitizeUrl()');

test('undefined → undefined', () => assertEqual(sanitizeUrl(undefined), undefined));
test('empty string → empty string', () => assertEqual(sanitizeUrl(''), ''));
test('$direct sentinel → $direct unchanged', () => assertEqual(sanitizeUrl('$direct'), '$direct'));

test('query string is removed', () => {
  const result = sanitizeUrl('https://cricketmarketusa.com/listings?category=bat&condition=new');
  assertEqual(result, 'https://cricketmarketusa.com/listings');
});

test('fragment is removed', () => {
  const result = sanitizeUrl('https://cricketmarketusa.com/listings#section');
  assertEqual(result, 'https://cricketmarketusa.com/listings');
});

test('query string and fragment both removed', () => {
  const result = sanitizeUrl('https://cricketmarketusa.com/listings?q=bat#top');
  assertEqual(result, 'https://cricketmarketusa.com/listings');
});

test('reset token value in query string is stripped', () => {
  const result = sanitizeUrl('https://cricketmarketusa.com/reset-password?token=supersecretresettoken123abc');
  assertEqual(result, 'https://cricketmarketusa.com/reset-password');
  assert(!result.includes('token'), 'token must not appear in sanitized URL');
  assert(!result.includes('supersecretresettoken123abc'), 'token value must not appear');
});

test('email verification token stripped', () => {
  const result = sanitizeUrl('https://cricketmarketusa.com/verify-email?code=abc123&email=user%40example.com');
  assertEqual(result, 'https://cricketmarketusa.com/verify-email');
});

test('UTM parameters stripped', () => {
  const result = sanitizeUrl('https://cricketmarketusa.com/?utm_source=google&utm_medium=cpc&utm_campaign=test');
  assertEqual(result, 'https://cricketmarketusa.com/');
});

test('origin and pathname preserved', () => {
  const result = sanitizeUrl('https://cricketmarketusa.com/listings/42?ref=homepage');
  assertEqual(result, 'https://cricketmarketusa.com/listings/42');
});

test('clean URL (no query, no hash) returned unchanged', () => {
  const result = sanitizeUrl('https://cricketmarketusa.com/listings/42');
  assertEqual(result, 'https://cricketmarketusa.com/listings/42');
});

test('referrer with query string stripped', () => {
  const result = sanitizeUrl('https://www.google.com/search?q=cricket+bat&hl=en');
  assertEqual(result, 'https://www.google.com/search');
});

test('malformed URL returned as-is (no throw)', () => {
  const result = sanitizeUrl('not-a-valid-url');
  assertEqual(result, 'not-a-valid-url');
});

// ── sanitizeBeforeSend ────────────────────────────────────────────────────

console.log('\nsanitizeBeforeSend()');

test('null input → null output', () => {
  const result = sanitizeBeforeSend(null);
  assertEqual(result, null);
});

test('$geoip_disable:true is added to every event', () => {
  const event = { uuid: 'test-uuid', event: 'page_viewed', properties: { pathname: '/listings' } };
  const result = sanitizeBeforeSend(event);
  assertEqual(result.properties.$geoip_disable, true, '$geoip_disable must be true');
});

test('$current_url query string stripped', () => {
  const event = {
    uuid: 'u1', event: 'page_viewed',
    properties: { $current_url: 'https://cricketmarketusa.com/listings?category=bat' },
  };
  const result = sanitizeBeforeSend(event);
  assertEqual(result.properties.$current_url, 'https://cricketmarketusa.com/listings');
});

test('$current_url fragment stripped', () => {
  const event = {
    uuid: 'u2', event: 'page_viewed',
    properties: { $current_url: 'https://cricketmarketusa.com/listings#bats' },
  };
  const result = sanitizeBeforeSend(event);
  assertEqual(result.properties.$current_url, 'https://cricketmarketusa.com/listings');
});

test('$referrer query string stripped', () => {
  const event = {
    uuid: 'u3', event: 'page_viewed',
    properties: { $referrer: 'https://www.google.com/search?q=cricket+bats' },
  };
  const result = sanitizeBeforeSend(event);
  assertEqual(result.properties.$referrer, 'https://www.google.com/search');
});

test('$referrer=$direct sentinel preserved', () => {
  const event = {
    uuid: 'u4', event: 'page_viewed',
    properties: { $referrer: '$direct' },
  };
  const result = sanitizeBeforeSend(event);
  assertEqual(result.properties.$referrer, '$direct');
});

test('$initial_current_url query string stripped', () => {
  const event = {
    uuid: 'u5', event: 'listing_viewed',
    properties: { $initial_current_url: 'https://cricketmarketusa.com/?ref=email&promo=launch' },
  };
  const result = sanitizeBeforeSend(event);
  assertEqual(result.properties.$initial_current_url, 'https://cricketmarketusa.com/');
});

test('$initial_referrer query string stripped', () => {
  const event = {
    uuid: 'u6', event: 'listing_viewed',
    properties: { $initial_referrer: 'https://bing.com/search?q=bat&form=QBLH' },
  };
  const result = sanitizeBeforeSend(event);
  assertEqual(result.properties.$initial_referrer, 'https://bing.com/search');
});

test('reset token in $current_url cannot reach PostHog', () => {
  const event = {
    uuid: 'u7', event: 'page_viewed',
    properties: {
      $current_url: 'https://cricketmarketusa.com/reset-password?token=supersecretvalue',
    },
  };
  const result = sanitizeBeforeSend(event);
  assert(!JSON.stringify(result.properties).includes('supersecretvalue'),
    'reset token must not appear in any event property');
  assertEqual(result.properties.$current_url, 'https://cricketmarketusa.com/reset-password');
});

test('approved custom properties (pathname, category, price_band) are preserved', () => {
  const event = {
    uuid: 'u8', event: 'listing_viewed',
    properties: {
      pathname: '/listings/42',
      category: 'bat',
      condition: 'used_good',
      price_band: '100_to_200',
      listing_id: 42,
    },
  };
  const result = sanitizeBeforeSend(event);
  assertEqual(result.properties.pathname, '/listings/42');
  assertEqual(result.properties.category, 'bat');
  assertEqual(result.properties.condition, 'used_good');
  assertEqual(result.properties.price_band, '100_to_200');
  assertEqual(result.properties.listing_id, 42);
});

test('$identify event passes through (login identify still works)', () => {
  const event = {
    uuid: 'u9', event: '$identify',
    properties: {
      $anon_distinct_id: 'anon-abc-123',
      distinct_id: '42',
      $current_url: 'https://cricketmarketusa.com/login?next=/dashboard',
    },
  };
  const result = sanitizeBeforeSend(event);
  assert(result !== null, '$identify must not be dropped');
  assertEqual(result.event, '$identify');
  assertEqual(result.properties.$anon_distinct_id, 'anon-abc-123', '$anon_distinct_id must be preserved');
  assertEqual(result.properties.distinct_id, '42', 'distinct_id must be preserved');
  assertEqual(result.properties.$current_url, 'https://cricketmarketusa.com/login', 'query stripped from $current_url');
  assertEqual(result.properties.$geoip_disable, true, '$geoip_disable must be set');
});

test('event object is not mutated (returns a new object)', () => {
  const original = {
    uuid: 'u10', event: 'page_viewed',
    properties: { $current_url: 'https://cricketmarketusa.com/?q=test', pathname: '/' },
  };
  const originalUrl = original.properties.$current_url;
  sanitizeBeforeSend(original);
  assertEqual(original.properties.$current_url, originalUrl, 'original event must not be mutated');
  assert(!('$geoip_disable' in original.properties), 'original must not have $geoip_disable added');
});

// ── $session_entry_url ────────────────────────────────────────────────────

console.log('\n$session_entry_url and $session_entry_referrer');

test('$session_entry_url query string stripped', () => {
  const event = {
    uuid: 'se1', event: 'page_viewed',
    properties: {
      $session_entry_url: 'https://www.cricketmarketusa.com/listings/19?utm_source=facebook&utm_medium=social&utm_campaign=launch_test',
    },
  };
  const result = sanitizeBeforeSend(event);
  assertEqual(result.properties.$session_entry_url, 'https://www.cricketmarketusa.com/listings/19');
});

test('$session_entry_url fragment stripped', () => {
  const event = {
    uuid: 'se2', event: 'page_viewed',
    properties: { $session_entry_url: 'https://www.cricketmarketusa.com/listings#bats' },
  };
  const result = sanitizeBeforeSend(event);
  assertEqual(result.properties.$session_entry_url, 'https://www.cricketmarketusa.com/listings');
});

test('$session_entry_url query string and fragment both stripped', () => {
  const event = {
    uuid: 'se3', event: 'page_viewed',
    properties: { $session_entry_url: 'https://www.cricketmarketusa.com/?ref=email#top' },
  };
  const result = sanitizeBeforeSend(event);
  assertEqual(result.properties.$session_entry_url, 'https://www.cricketmarketusa.com/');
});

test('$session_entry_url malformed URL returned as-is (no throw)', () => {
  const event = {
    uuid: 'se4', event: 'page_viewed',
    properties: { $session_entry_url: 'not-a-valid-url' },
  };
  const result = sanitizeBeforeSend(event);
  assertEqual(result.properties.$session_entry_url, 'not-a-valid-url');
});

test('$session_entry_url empty string returned unchanged', () => {
  const event = {
    uuid: 'se5', event: 'page_viewed',
    properties: { $session_entry_url: '' },
  };
  const result = sanitizeBeforeSend(event);
  assertEqual(result.properties.$session_entry_url, '');
});

test('$session_entry_url absent — no property added', () => {
  const event = {
    uuid: 'se6', event: 'page_viewed',
    properties: { pathname: '/listings' },
  };
  const result = sanitizeBeforeSend(event);
  assert(!('$session_entry_url' in result.properties), '$session_entry_url must not be added when absent');
});

test('$session_entry_referrer query string stripped', () => {
  const event = {
    uuid: 'se7', event: 'page_viewed',
    properties: { $session_entry_referrer: 'https://www.google.com/search?q=cricket+bat&hl=en' },
  };
  const result = sanitizeBeforeSend(event);
  assertEqual(result.properties.$session_entry_referrer, 'https://www.google.com/search');
});

test('$session_entry_referrer $direct sentinel preserved', () => {
  const event = {
    uuid: 'se8', event: 'page_viewed',
    properties: { $session_entry_referrer: '$direct' },
  };
  const result = sanitizeBeforeSend(event);
  assertEqual(result.properties.$session_entry_referrer, '$direct');
});

test('$session_entry_referrer fragment stripped', () => {
  const event = {
    uuid: 'se9', event: 'page_viewed',
    properties: { $session_entry_referrer: 'https://twitter.com/home#referral' },
  };
  const result = sanitizeBeforeSend(event);
  assertEqual(result.properties.$session_entry_referrer, 'https://twitter.com/home');
});

test('UTM properties preserved alongside $session_entry_url', () => {
  // The SDK extracts utm_* into separate properties before before_send runs.
  // Those separate utm_* properties must not be touched; only the URL string is stripped.
  const event = {
    uuid: 'se10', event: 'page_viewed',
    properties: {
      $session_entry_url: 'https://www.cricketmarketusa.com/listings/19?utm_source=facebook&utm_medium=social&utm_campaign=launch_test',
      utm_source:   'facebook',
      utm_medium:   'social',
      utm_campaign: 'launch_test',
    },
  };
  const result = sanitizeBeforeSend(event);
  assertEqual(result.properties.$session_entry_url, 'https://www.cricketmarketusa.com/listings/19',
    '$session_entry_url must have query stripped');
  assertEqual(result.properties.utm_source,   'facebook',     'utm_source must be preserved');
  assertEqual(result.properties.utm_medium,   'social',       'utm_medium must be preserved');
  assertEqual(result.properties.utm_campaign, 'launch_test',  'utm_campaign must be preserved');
});

test('$session_entry_pathname not touched', () => {
  // pathname is origin+path only — no query string — and requirement says do not change it
  const event = {
    uuid: 'se11', event: 'page_viewed',
    properties: { $session_entry_pathname: '/listings/19' },
  };
  const result = sanitizeBeforeSend(event);
  assertEqual(result.properties.$session_entry_pathname, '/listings/19',
    '$session_entry_pathname must pass through unchanged');
});

// ── person_profiles config check ──────────────────────────────────────────

console.log('\nperson_profiles config');

test('PostHogProvider uses identified_only (not always)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'PostHogProvider.tsx'),
    'utf8'
  );
  assert(src.includes("person_profiles:                'identified_only'"),
    "PostHogProvider must use person_profiles:'identified_only'");
  assert(!src.includes("person_profiles:                'always'"),
    "PostHogProvider must NOT use person_profiles:'always'");
});

test('PostHogProvider registers sanitizeBeforeSend as before_send', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'PostHogProvider.tsx'),
    'utf8'
  );
  assert(src.includes('before_send:'), 'before_send must be configured');
  assert(src.includes('sanitizeBeforeSend'), 'sanitizeBeforeSend must be registered');
});

test('PostHogProvider has disable_capture_url_hashes:true', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'PostHogProvider.tsx'),
    'utf8'
  );
  assert(src.includes('disable_capture_url_hashes:     true'),
    'disable_capture_url_hashes must be set to true');
});

// ── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

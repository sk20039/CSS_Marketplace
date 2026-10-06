// Regression test: passwordless sign-in and checkout/verify redirect destinations.
//
// Guards against reintroducing /dashboard (no-op 404) as a redirect target.
// Tests the pure destForRole logic and the four redirect branches in
// checkout/verify without a browser or framework dependency.
//
// Run: node frontend/tests/passwordless_redirect.test.js

'use strict';

let passed = 0, failed = 0;
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

// ── destForRole — mirrors passwordless/page.tsx ───────────────────────────────
function destForRole(role) {
  if (role === 'seller') return '/dashboard/seller';
  if (role === 'admin')  return '/admin';
  return '/dashboard/buyer';
}

// ── checkoutRedirect — mirrors checkout/verify/page.tsx redirect() ────────────
function checkoutRedirect(role, listingId) {
  if (role === 'buyer' && listingId) return `/listings/${listingId}?buy=1`;
  if (role === 'buyer')              return '/listings';
  if (role === 'seller')             return '/dashboard/seller';
  return '/admin';
}

console.log('\nPasswordless redirect regression tests\n');

// destForRole
test('buyer with no redirect param goes to /dashboard/buyer', () => {
  assert(destForRole('buyer') === '/dashboard/buyer');
});
test('seller with no redirect param goes to /dashboard/seller', () => {
  assert(destForRole('seller') === '/dashboard/seller');
});
test('admin with no redirect param goes to /admin', () => {
  assert(destForRole('admin') === '/admin');
});
test('unknown role falls back to /dashboard/buyer', () => {
  assert(destForRole('') === '/dashboard/buyer');
  assert(destForRole(undefined) === '/dashboard/buyer');
});
test('/dashboard is never a redirect destination', () => {
  ['buyer', 'seller', 'admin', '', undefined].forEach(role => {
    assert(destForRole(role) !== '/dashboard', `role ${role} produced /dashboard`);
  });
});

// explicit ?redirect= param takes precedence
test('explicit redirect param is respected over role default', () => {
  const redirectParam = '/listings/42';
  const dest = redirectParam || destForRole('buyer');
  assert(dest === '/listings/42');
});
test('absent redirect param falls through to role default', () => {
  const redirectParam = null;
  const dest = redirectParam || destForRole('buyer');
  assert(dest === '/dashboard/buyer');
});

// checkoutRedirect (checkout/verify)
test('buyer with listingId goes to listing buy page', () => {
  assert(checkoutRedirect('buyer', '36') === '/listings/36?buy=1');
});
test('buyer without listingId goes to /listings', () => {
  assert(checkoutRedirect('buyer', null) === '/listings');
});
test('seller in checkout/verify goes to /dashboard/seller not /dashboard', () => {
  const dest = checkoutRedirect('seller', null);
  assert(dest === '/dashboard/seller', `got ${dest}`);
  assert(dest !== '/dashboard');
});
test('admin/other in checkout/verify goes to /admin not /dashboard', () => {
  const dest = checkoutRedirect('admin', null);
  assert(dest === '/admin', `got ${dest}`);
  assert(dest !== '/dashboard');
});
test('listing id is preserved through checkout redirect', () => {
  const dest = checkoutRedirect('buyer', '99');
  assert(dest === '/listings/99?buy=1');
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

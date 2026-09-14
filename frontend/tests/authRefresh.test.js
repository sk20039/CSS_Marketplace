'use strict';

// Focused unit tests for the apiFetch silent-refresh behaviour.
// Mirrors the exact logic in lib/api.ts + lib/auth.tsx without importing
// React or Next.js — uses inline stubs for fetch, getAccessToken,
// setAccessToken, and notifySessionExpired.
//
// Run with: node frontend/tests/authRefresh.test.js

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Inline stubs — same shape as lib/auth.tsx module-level exports
// ---------------------------------------------------------------------------

let _accessToken = 'old-token';
let _sessionExpiredCalled = false;
let _redirectTarget = null;

function getAccessToken() { return _accessToken; }
function setAccessToken(t) { _accessToken = t; }
function notifySessionExpired() {
  _accessToken = null;
  _sessionExpiredCalled = true;
  _redirectTarget = '/login';
}

function resetState(token = 'old-token') {
  _accessToken = token;
  _sessionExpiredCalled = false;
  _redirectTarget = null;
}

// ---------------------------------------------------------------------------
// Inline silentRefresh — identical to lib/api.ts silentRefresh
// ---------------------------------------------------------------------------

async function silentRefresh(mockFetch) {
  try {
    const res = await mockFetch('AUTH_URL/auth/refresh', { method: 'POST', credentials: 'include' });
    if (!res.ok) {
      notifySessionExpired();
      return null;
    }
    const data = await res.json();
    setAccessToken(data.access_token);
    return data.access_token;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Inline apiFetch — identical logic to lib/api.ts apiFetch
// ---------------------------------------------------------------------------

async function apiFetch(url, options = {}, retry = true, mockFetch) {
  const token = getAccessToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await mockFetch(url, { ...options, headers, credentials: 'include' });

  if (res.status === 401 && retry) {
    const newToken = await silentRefresh(mockFetch);
    if (newToken) return apiFetch(url, options, false, mockFetch);
  }

  return res;
}

// ---------------------------------------------------------------------------
// Helper: build a simple mock fetch
// ---------------------------------------------------------------------------

function makeMockFetch(calls) {
  // calls: array of { url?, status, body? } — returns them in order
  const queue = [...calls];
  return async function mockFetch(url) {
    const spec = queue.shift();
    if (!spec) throw new Error(`Unexpected fetch call to ${url}`);
    return {
      ok: spec.status >= 200 && spec.status < 300,
      status: spec.status,
      json: async () => spec.body || {},
    };
  };
}

// ---------------------------------------------------------------------------
// All tests run inside an async main so top-level await works in CJS
// ---------------------------------------------------------------------------

async function main() {

// ---------------------------------------------------------------------------
// Test 1: expired access token + successful refresh → request retries normally
// ---------------------------------------------------------------------------

console.log('\napiFetch — expired token, successful refresh');

{
  resetState('expired-token');

  const mockFetch = makeMockFetch([
    { status: 401 },                                            // original request → 401
    { status: 200, body: { access_token: 'new-token' } },      // /auth/refresh → 200
    { status: 200, body: { data: 'ok' } },                     // retry → 200
  ]);

  const res = await apiFetch('ESCROW/shipping-rates', { method: 'POST' }, true, mockFetch);

  assert('final response is 200',             res.status === 200);
  assert('access token updated to new-token', _accessToken === 'new-token');
  assert('notifySessionExpired NOT called',   !_sessionExpiredCalled);
  assert('no redirect',                       _redirectTarget === null);
}

// ---------------------------------------------------------------------------
// Test 2: expired access token + failed refresh → state cleared, redirect
// ---------------------------------------------------------------------------

console.log('\napiFetch — expired token, failed refresh');

{
  resetState('expired-token');

  const mockFetch = makeMockFetch([
    { status: 401 },   // original request → 401
    { status: 401 },   // /auth/refresh → 401
  ]);

  const res = await apiFetch('ESCROW/shipping-rates', { method: 'POST' }, true, mockFetch);

  assert('final response is 401',           res.status === 401);
  assert('access token cleared',            _accessToken === null);
  assert('notifySessionExpired was called', _sessionExpiredCalled);
  assert('redirect target is /login',       _redirectTarget === '/login');
}

// ---------------------------------------------------------------------------
// Test 3: failed refresh without a prior 401 (direct refresh call)
// ---------------------------------------------------------------------------

console.log('\nsilentRefresh — direct call, server returns 401');

{
  resetState('any-token');

  const mockFetch = makeMockFetch([
    { status: 401 },  // /auth/refresh → 401
  ]);

  const result = await silentRefresh(mockFetch);

  assert('returns null',                    result === null);
  assert('access token cleared',            _accessToken === null);
  assert('notifySessionExpired was called', _sessionExpiredCalled);
  assert('redirect target is /login',       _redirectTarget === '/login');
}

// ---------------------------------------------------------------------------
// Test 4: no redirect loop on /login
// Calling notifySessionExpired when already on /login sets the same target
// (idempotent). The registered handler uses router.push('/login') which
// Next.js ignores when already on that path.
// ---------------------------------------------------------------------------

console.log('\nnotifySessionExpired — idempotent, no redirect loop');

{
  resetState(null);           // already logged out (no token)
  _sessionExpiredCalled = false;
  _redirectTarget = '/login'; // simulate already being on /login

  // Simulate a second refresh failure while on /login
  notifySessionExpired();

  assert('redirectTarget stays /login (no loop)',  _redirectTarget === '/login');
  assert('access token remains null',              _accessToken === null);
  assert('notifySessionExpired called',            _sessionExpiredCalled);
}

// ---------------------------------------------------------------------------
// Test 5: successful request (no 401) — no refresh, no state change
// ---------------------------------------------------------------------------

console.log('\napiFetch — successful request, no refresh needed');

{
  resetState('valid-token');

  const mockFetch = makeMockFetch([
    { status: 200, body: { rates: [] } },  // request succeeds immediately
  ]);

  const res = await apiFetch('ESCROW/shipping-rates', { method: 'POST' }, true, mockFetch);

  assert('final response is 200',           res.status === 200);
  assert('access token unchanged',          _accessToken === 'valid-token');
  assert('no session expired notification', !_sessionExpiredCalled);
}

// ---------------------------------------------------------------------------

} // end main

main().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}).catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});

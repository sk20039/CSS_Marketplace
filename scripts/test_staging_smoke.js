'use strict';
// Staging end-to-end smoke test — covers all 3 backend services + frontend.
// Run: node scripts/test_staging_smoke.js
//
// Auth endpoints require Turnstile tokens to login; we bypass by generating
// JWTs directly with the known staging JWT_SECRET.  Turnstile enforcement is
// verified independently (missing-token → 400, bad-token → 403).
//
// Accounts in staging:
//   buyer  id=7  smoke_buyer_1787771797@test.invalid
//   seller id=8  smoke_seller_1787771797@test.invalid
//   admin  id=5  admin@staging.test

const https  = require('https');
const crypto = require('crypto');

// ── URLs ──────────────────────────────────────────────────────────────────────
const AUTH_URL    = 'https://auth-service-production-1f4c7.up.railway.app';
const LISTING_URL = 'https://listing-service-production-3b3f.up.railway.app';
const ESCROW_URL  = 'https://escrow-service-production-1e20.up.railway.app';
const FRONTEND    = 'https://css-marketplace-frontend-git-master-sk20039s-projects.vercel.app';

// ── Staging secrets ───────────────────────────────────────────────────────────
const JWT_SECRET = 'HwfT2dLL8Nsp_Nc36hDZC4cCuf5nON1eCPPQAYAIxYlYrZNQrvNAO3vEITGIWcJQ';

// ── JWT generation ────────────────────────────────────────────────────────────
function makeJWT(payload) {
  const hdr = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const bod = Buffer.from(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${hdr}.${bod}`).digest('base64url');
  return `${hdr}.${bod}.${sig}`;
}

const BUYER_TOKEN  = makeJWT({ sub: '7', email: 'smoke_buyer_1787771797@test.invalid', role: 'buyer' });
const SELLER_TOKEN = makeJWT({ sub: '8', email: 'smoke_seller_1787771797@test.invalid', role: 'seller' });
const ADMIN_TOKEN  = makeJWT({ sub: '5', email: 'admin@staging.test', role: 'admin' });

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function req(method, baseUrl, path, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const u = new URL(baseUrl + path);
    const opts = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const r = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const get  = (base, path, token)       => req('GET',  base, path, token, null);
const post = (base, path, token, body) => req('POST', base, path, token, body);

// ── Test runner ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0;
const results = [];

function pass(name, detail) {
  console.log(`  ✓  ${name}${detail ? ' — ' + detail : ''}`);
  results.push({ name, status: 'PASS', detail });
  passed++;
}
function fail(name, detail) {
  console.error(`  ✗  ${name}${detail ? ' — ' + detail : ''}`);
  results.push({ name, status: 'FAIL', detail });
  failed++;
}
function skip(name, detail) {
  console.log(`  ○  ${name}${detail ? ' — ' + detail : ''}`);
  results.push({ name, status: 'SKIP', detail });
  skipped++;
}

async function check(name, fn) {
  try { await fn(); }
  catch (e) { fail(name, e.message); }
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n════════════════════════════════════════════════════');
  console.log('  STAGING END-TO-END SMOKE TEST');
  console.log('════════════════════════════════════════════════════\n');

  // ── GROUP 1: Health ──────────────────────────────────────────────────────
  console.log('── 1. Health checks ──');

  await check('auth  /health/live', async () => {
    const r = await get(AUTH_URL, '/health/live');
    if (r.status !== 200 || !r.body.ok) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
    pass('auth  /health/live', `service=${r.body.service}`);
  });

  await check('auth  /health/ready', async () => {
    const r = await get(AUTH_URL, '/health/ready');
    if (r.status !== 200) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
    pass('auth  /health/ready', `db=${r.body.db ?? r.body.database ?? 'ok'}`);
  });

  await check('listing /health/live', async () => {
    const r = await get(LISTING_URL, '/health/live');
    if (r.status !== 200 || !r.body.ok) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
    pass('listing /health/live', `service=${r.body.service}`);
  });

  await check('listing /health/ready', async () => {
    const r = await get(LISTING_URL, '/health/ready');
    if (r.status !== 200) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
    pass('listing /health/ready', 'ok');
  });

  await check('escrow  /health/live', async () => {
    const r = await get(ESCROW_URL, '/health/live');
    if (r.status !== 200 || !r.body.ok) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
    pass('escrow  /health/live', `service=${r.body.service}`);
  });

  await check('escrow  /health/ready', async () => {
    const r = await get(ESCROW_URL, '/health/ready');
    if (r.status !== 200) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
    pass('escrow  /health/ready', 'ok');
  });

  // ── GROUP 2: Frontend ────────────────────────────────────────────────────
  console.log('\n── 2. Frontend staging alias ──');

  // Use vercel CLI to bypass deployment protection
  await check('frontend GET / returns 200', async () => {
    const { execSync } = require('child_process');
    let raw;
    try {
      raw = execSync(`vercel curl "${FRONTEND}/" -s -D -`, { encoding: 'utf8', timeout: 30000 });
    } catch (e) {
      throw new Error(`vercel curl failed: ${e.message}`);
    }
    const statusLine = raw.split('\n')[0];
    if (!statusLine.includes('200')) throw new Error(`Non-200: ${statusLine.trim()}`);
    pass('frontend GET / returns 200', statusLine.trim());
  });

  await check('frontend CSP allows Cloudflare Turnstile', async () => {
    const { execSync } = require('child_process');
    let raw;
    try {
      raw = execSync(`vercel curl "${FRONTEND}/" -s -D -`, { encoding: 'utf8', timeout: 30000 });
    } catch (e) {
      throw new Error(`vercel curl failed: ${e.message}`);
    }
    const cspMatch = raw.match(/content-security-policy:([^\r\n]+)/i);
    if (!cspMatch) throw new Error('No CSP header found');
    const csp = cspMatch[1];
    if (!csp.includes('challenges.cloudflare.com')) throw new Error('challenges.cloudflare.com missing from CSP');
    const scriptOk = csp.includes('script-src') && csp.split('script-src')[1].split(';')[0].includes('challenges.cloudflare.com');
    const frameOk  = csp.includes('frame-src')  && csp.split('frame-src')[1].split(';')[0].includes('challenges.cloudflare.com');
    if (!scriptOk) throw new Error('challenges.cloudflare.com not in script-src');
    if (!frameOk)  throw new Error('challenges.cloudflare.com not in frame-src');
    pass('frontend CSP allows Cloudflare Turnstile', 'script-src ✓  frame-src ✓');
  });

  await check('frontend connect-src uses staging backends', async () => {
    const { execSync } = require('child_process');
    let raw;
    try {
      raw = execSync(`vercel curl "${FRONTEND}/" -s -D -`, { encoding: 'utf8', timeout: 30000 });
    } catch (e) {
      throw new Error(`vercel curl failed: ${e.message}`);
    }
    const cspMatch = raw.match(/content-security-policy:([^\r\n]+)/i);
    if (!cspMatch) throw new Error('No CSP header found');
    const csp = cspMatch[1];
    const authOk    = csp.includes('auth-service-production-1f4c7');
    const listingOk = csp.includes('listing-service-production-3b3f');
    const escrowOk  = csp.includes('escrow-service-production-1e20');
    if (!authOk)    throw new Error('auth staging backend 1f4c7 missing from connect-src');
    if (!listingOk) throw new Error('listing staging backend 3b3f missing from connect-src');
    if (!escrowOk)  throw new Error('escrow staging backend 1e20 missing from connect-src');
    pass('frontend connect-src uses staging backends', '1f4c7 ✓  3b3f ✓  1e20 ✓');
  });

  // ── GROUP 3: Turnstile enforcement ───────────────────────────────────────
  console.log('\n── 3. Turnstile enforcement ──');

  const protectedEndpoints = [
    ['/auth/login',               { email: 'a@b.c', password: 'x' }],
    ['/auth/register',            { email: 'a@b.c', password: 'x', role: 'buyer' }],
    ['/auth/forgot-password',     { email: 'a@b.c' }],
    ['/auth/resend-verification', { email: 'a@b.c' }],
  ];

  for (const [path, body] of protectedEndpoints) {
    await check(`${path} missing token → 400`, async () => {
      const r = await post(AUTH_URL, path, null, body);
      if (r.status !== 400) throw new Error(`expected 400 got ${r.status}: ${JSON.stringify(r.body)}`);
      if (!r.body.error?.includes('CAPTCHA')) throw new Error(`unexpected error: ${r.body.error}`);
      pass(`${path} missing token → 400`, `"${r.body.error}"`);
    });
  }

  await check('/auth/login bad turnstile token → 403', async () => {
    const r = await post(AUTH_URL, '/auth/login', null, {
      email: 'smoke_buyer_1787771797@test.invalid',
      password: 'CookieTest1234',
      turnstile_token: 'INVALID-TOKEN-FOR-SMOKE-TEST',
    });
    if (r.status !== 403) throw new Error(`expected 403 got ${r.status}: ${JSON.stringify(r.body)}`);
    pass('/auth/login bad turnstile token → 403', `"${r.body.error}"`);
  });

  // ── GROUP 4: Auth service — JWT-authenticated routes ─────────────────────
  console.log('\n── 4. Auth service — JWT routes ──');

  await check('GET /auth/me buyer JWT → 200', async () => {
    const r = await get(AUTH_URL, '/auth/me', BUYER_TOKEN);
    if (r.status !== 200) throw new Error(`${r.status}: ${JSON.stringify(r.body)}`);
    if (String(r.body.id) !== '7') throw new Error(`unexpected id: ${r.body.id}`);
    if (r.body.role !== 'buyer') throw new Error(`unexpected role: ${r.body.role}`);
    pass('GET /auth/me buyer JWT → 200', `id=${r.body.id} role=${r.body.role} email=${r.body.email}`);
  });

  await check('GET /auth/me seller JWT → 200', async () => {
    const r = await get(AUTH_URL, '/auth/me', SELLER_TOKEN);
    if (r.status !== 200) throw new Error(`${r.status}: ${JSON.stringify(r.body)}`);
    if (String(r.body.id) !== '8') throw new Error(`unexpected id: ${r.body.id}`);
    pass('GET /auth/me seller JWT → 200', `id=${r.body.id} role=${r.body.role} stripe_account_id=${r.body.stripe_account_id ?? 'n/a'}`);
  });

  await check('GET /auth/me no auth → 401', async () => {
    const r = await get(AUTH_URL, '/auth/me', null);
    if (r.status !== 401) throw new Error(`expected 401 got ${r.status}`);
    pass('GET /auth/me no auth → 401');
  });

  await check('GET /auth/me bad token → 401', async () => {
    const r = await get(AUTH_URL, '/auth/me', 'not-a-jwt');
    if (r.status !== 401) throw new Error(`expected 401 got ${r.status}`);
    pass('GET /auth/me bad token → 401');
  });

  // ── GROUP 5: Listing service ──────────────────────────────────────────────
  console.log('\n── 5. Listing service ──');

  let firstListingId = null;

  await check('GET /listings public → 200', async () => {
    const r = await get(LISTING_URL, '/listings', null);
    if (r.status !== 200) throw new Error(`${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
    const listings = Array.isArray(r.body) ? r.body : (r.body.listings ?? r.body.data ?? []);
    if (listings.length > 0) firstListingId = listings[0].id;
    pass('GET /listings public → 200', `${listings.length} listing(s) returned`);
  });

  if (firstListingId) {
    await check(`GET /listings/${firstListingId} → 200`, async () => {
      const r = await get(LISTING_URL, `/listings/${firstListingId}`, null);
      if (r.status !== 200) throw new Error(`${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
      pass(`GET /listings/${firstListingId} → 200`, `title="${r.body.title ?? r.body.listing?.title ?? '?'}"`);
    });
  } else {
    skip('GET /listings/:id → 200', 'no listings in staging');
  }

  await check('POST /listings no auth → 401', async () => {
    const r = await post(LISTING_URL, '/listings', null, {
      title: 'smoke-test unauthenticated', price_cents: 5000, category: 'bats',
    });
    if (r.status !== 401) throw new Error(`expected 401 got ${r.status}: ${JSON.stringify(r.body)}`);
    pass('POST /listings no auth → 401', 'unauthenticated create correctly blocked');
  });

  // ── GROUP 6: Escrow service ───────────────────────────────────────────────
  console.log('\n── 6. Escrow service ──');

  let allOrders = [];

  await check('GET /orders admin → 200', async () => {
    const r = await get(ESCROW_URL, '/orders', ADMIN_TOKEN);
    if (r.status !== 200) throw new Error(`${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
    allOrders = Array.isArray(r.body) ? r.body : (r.body.orders ?? []);
    const byStatus = {};
    allOrders.forEach((o) => { byStatus[o.status] = (byStatus[o.status] || 0) + 1; });
    pass('GET /orders admin → 200', `${allOrders.length} orders: ${JSON.stringify(byStatus)}`);
  });

  await check('GET /orders buyer → 200', async () => {
    const r = await get(ESCROW_URL, '/orders', BUYER_TOKEN);
    if (r.status !== 200) throw new Error(`${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
    const orders = Array.isArray(r.body) ? r.body : (r.body.orders ?? []);
    pass('GET /orders buyer → 200', `${orders.length} order(s) visible to buyer`);
  });

  await check('GET /orders no auth → 401', async () => {
    const r = await get(ESCROW_URL, '/orders', null);
    if (r.status !== 401) throw new Error(`expected 401 got ${r.status}`);
    pass('GET /orders no auth → 401');
  });

  // Find a buyer-owned order to inspect
  const buyerOrder = allOrders.find((o) => o.buyer_id === 7);
  if (buyerOrder) {
    await check(`GET /orders/${buyerOrder.id} buyer JWT → 200`, async () => {
      const r = await get(ESCROW_URL, `/orders/${buyerOrder.id}`, BUYER_TOKEN);
      if (r.status !== 200) throw new Error(`${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
      const hasLabelUrl = 'label_url' in r.body;
      if (hasLabelUrl) throw new Error('label_url exposed to buyer (privacy violation)');
      pass(`GET /orders/${buyerOrder.id} buyer JWT → 200`,
        `status=${r.body.status} label_url_hidden=true`);
    });
  } else {
    skip('GET /orders/:id buyer JWT → 200', 'no orders owned by buyer id=7');
  }

  // Verify RELEASED orders exist (from previous E2E runs)
  const releasedOrders = allOrders.filter((o) => o.status === 'RELEASED');
  if (releasedOrders.length > 0) {
    const o = releasedOrders[releasedOrders.length - 1]; // most recent
    pass(`staging has ${releasedOrders.length} RELEASED order(s)`, `most recent: #${o.id}`);
  } else {
    skip('RELEASED orders present', 'no RELEASED orders on staging DB');
  }

  // ── SUMMARY ──────────────────────────────────────────────────────────────
  const totalChecks = passed + failed + skipped;
  console.log('\n════════════════════════════════════════════════════');
  console.log('  STAGING SMOKE TEST SUMMARY');
  console.log('════════════════════════════════════════════════════');
  results.forEach(({ name, status, detail }) => {
    const icon = status === 'PASS' ? '✓' : status === 'SKIP' ? '○' : '✗';
    console.log(`  ${icon}  [${status}] ${name}`);
    if (detail) console.log(`        ${detail}`);
  });
  console.log('────────────────────────────────────────────────────');
  console.log(`  ${totalChecks} checks: ${passed} PASS  ${failed} FAIL  ${skipped} SKIP`);
  console.log('════════════════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
})().catch((err) => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});

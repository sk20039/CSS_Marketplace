'use strict';
/**
 * Production QA Agent — cricketmarketusa.com
 *
 * Run manually:
 *   QA_BEARER_TOKEN=<token> node scripts/qa_production.js
 *
 * Scheduled via GitHub Actions (.github/workflows/qa-production.yml) every 2 hours.
 *
 * Design constraints
 * ──────────────────
 * - JWT_SECRET and ADMIN_JWT_SECRET NEVER leave Railway. No JWT is generated here.
 * - All authenticated tests use a pre-issued, time-bounded access token for a
 *   dedicated read-only QA buyer account (qa-monitor@cricketmarketusa.com).
 *   That token is stored in GitHub Actions secrets as QA_BEARER_TOKEN.
 * - If QA_BEARER_TOKEN is absent, authenticated tests are SKIP (not FAIL).
 * - No production mutations: no orders, payments, listings, disputes, or any
 *   write operation is performed.
 *
 * GitHub Actions secrets required
 * ────────────────────────────────
 *   QA_BEARER_TOKEN   — pre-issued 30-day buyer JWT for qa-monitor@cricketmarketusa.com
 *   RESEND_API_KEY    — Resend API key (same key as auth-service) for failure emails
 *   QA_ALERT_EMAIL    — alert recipient address
 *
 * Optional:
 *   EMAIL_FROM        — sender address (default: alerts@cricketmarketusa.com)
 *
 * Token rotation
 * ──────────────
 * QA_BEARER_TOKEN expires 30 days after issuance. Rotate before expiry:
 *   railway run --service auth-service -- node -e "
 *     const j=require('jsonwebtoken'),c=require('crypto');
 *     console.log(j.sign(
 *       {sub:'<QA_USER_ID>',email:'qa-monitor@cricketmarketusa.com',
 *        role:'buyer',jti:c.randomBytes(8).toString('hex')},
 *       process.env.JWT_SECRET,{expiresIn:'30d'}));
 *   "
 * Then update the QA_BEARER_TOKEN secret in GitHub Actions.
 * JWT_SECRET is injected by Railway and never leaves the Railway environment.
 *
 * Revocation before expiry
 * ─────────────────────────
 * This is a stateless JWT. There is no jti blocklist. The token cannot be
 * cryptographically revoked before its 30-day expiry without changing JWT_SECRET.
 *
 * If the token is compromised, options in ascending order of impact:
 *   1. Let it expire naturally (30 days). Blast radius is minimal: a zero-data
 *      buyer account with no orders, no payments, no PII beyond the email.
 *   2. DELETE the qa-monitor user from the auth DB. This limits what the token
 *      can ACCESS (endpoints that do a DB user-lookup return 404 or empty), but
 *      it does NOT cryptographically revoke the already-issued JWT. The token
 *      remains valid until expiry; endpoints that rely only on requireAuth
 *      middleware (no DB lookup) will still accept it.
 *   3. Change JWT_SECRET in Railway. This is the only true cryptographic
 *      revocation. It invalidates all active sessions for all users — nuclear.
 *      Use only in a genuine breach scenario.
 */

const https = require('https');

// ── Production URLs ───────────────────────────────────────────────────────────
const AUTH_URL    = 'https://auth-service-production-7d82.up.railway.app';
const LISTING_URL = 'https://listing-service-production-ccb1.up.railway.app';
const ESCROW_URL  = 'https://escrow-service-production-7727.up.railway.app';
const FRONTEND    = 'https://www.cricketmarketusa.com';

// ── Credentials ───────────────────────────────────────────────────────────────
// Pre-issued 30-day buyer JWT for qa-monitor@cricketmarketusa.com.
// Never generated here — issued once from Railway shell and stored in GitHub Secrets.
const QA_BEARER_TOKEN = process.env.QA_BEARER_TOKEN || '';

const RESEND_KEY  = process.env.RESEND_API_KEY || '';
const ALERT_EMAIL = process.env.QA_ALERT_EMAIL || 'admin@cricketmarketusa.com';
const FROM_EMAIL  = process.env.EMAIL_FROM || 'alerts@cricketmarketusa.com';

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function req(method, baseUrl, path, token, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const u = new URL(baseUrl + path);
    const opts = {
      hostname: u.hostname,
      port:     443,
      path:     u.pathname + u.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token   ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(extraHeaders || {}),
      },
    };
    const timer = setTimeout(() => reject(new Error('Request timed out after 10s')), 10000);
    const r = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        clearTimeout(timer);
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers, raw: data });
      });
    });
    r.on('error', (e) => { clearTimeout(timer); reject(e); });
    if (payload) r.write(payload);
    r.end();
  });
}

const get  = (base, path, token, extra)        => req('GET',     base, path, token, null, extra);
const post = (base, path, token, body, extra)  => req('POST',    base, path, token, body, extra);
const opts = (base, path, extra)               => req('OPTIONS', base, path, null,  null, extra);

async function timed(fn) {
  const t0 = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - t0 };
}

// ── Test runner ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0;
const results   = [];
const startedAt = new Date().toISOString();

function pass(name, detail) {
  console.log(`  \u2713  ${name}${detail ? ' \u2014 ' + detail : ''}`);
  results.push({ name, status: 'PASS', detail });
  passed++;
}
function fail(name, detail) {
  console.error(`  \u2717  ${name}${detail ? ' \u2014 ' + detail : ''}`);
  results.push({ name, status: 'FAIL', detail });
  failed++;
}
function skip(name, detail) {
  console.log(`  \u25cb  ${name}${detail ? ' \u2014 ' + detail : ''}`);
  results.push({ name, status: 'SKIP', detail });
  skipped++;
}

async function check(name, fn) {
  try { await fn(); }
  catch (e) { fail(name, e.message); }
}

// ── Resend alert email ────────────────────────────────────────────────────────
async function sendAlertEmail() {
  if (!RESEND_KEY) {
    console.warn('[QA] RESEND_API_KEY not set \u2014 skipping alert email');
    return;
  }

  const failedTests = results.filter((r) => r.status === 'FAIL');
  const subject = `[QA ALERT] cricketmarketusa.com \u2014 ${failed} test(s) FAILED`;

  const htmlRows = results.map(({ name, status, detail }) => {
    const color = status === 'PASS' ? '#16a34a' : status === 'SKIP' ? '#6b7280' : '#dc2626';
    const icon  = status === 'PASS' ? '\u2713'  : status === 'SKIP' ? '\u25cb'  : '\u2717';
    return `<tr>
      <td style="padding:4px 8px;color:${color};font-weight:bold;font-family:monospace">${icon}</td>
      <td style="padding:4px 8px;color:${color};font-weight:bold;font-family:monospace">${status}</td>
      <td style="padding:4px 8px;font-family:monospace">${name}</td>
      <td style="padding:4px 8px;color:#6b7280;font-size:12px;font-family:monospace">${detail || ''}</td>
    </tr>`;
  }).join('');

  const html = `<html><body style="font-family:sans-serif;background:#f9fafb;padding:24px;max-width:800px">
<h2 style="color:#dc2626;margin-bottom:4px">Production QA Alert</h2>
<p style="color:#6b7280;margin-top:0">cricketmarketusa.com &mdash; ${startedAt}</p>
<p style="font-size:20px;margin:16px 0">
  <span style="color:#16a34a">\u2713 ${passed} PASS</span>&nbsp;&nbsp;
  <span style="color:#dc2626">\u2717 ${failed} FAIL</span>&nbsp;&nbsp;
  <span style="color:#6b7280">\u25cb ${skipped} SKIP</span>
</p>
<h3 style="color:#dc2626">Failures</h3>
<ul style="font-family:monospace">${failedTests.map((t) =>
  `<li><strong>${t.name}</strong>${t.detail ? ': ' + t.detail : ''}</li>`
).join('')}</ul>
<h3>Full Results</h3>
<table style="border-collapse:collapse;background:white;border:1px solid #e5e7eb;width:100%">
  <thead><tr style="background:#f3f4f6;text-align:left">
    <th style="padding:6px 8px"></th><th style="padding:6px 8px">Status</th>
    <th style="padding:6px 8px">Test</th><th style="padding:6px 8px">Detail</th>
  </tr></thead>
  <tbody>${htmlRows}</tbody>
</table>
<p style="color:#9ca3af;font-size:11px;margin-top:24px">
  Production QA agent \u2014 runs every 2h via GitHub Actions<br>
  Token expiry reminder: rotate QA_BEARER_TOKEN before 30 days post-issuance.
</p>
</body></html>`;

  const textLines = results.map(({ name, status, detail }) => {
    const icon = status === 'PASS' ? '\u2713' : status === 'SKIP' ? '\u25cb' : '\u2717';
    return `${icon} [${status}] ${name}${detail ? '\n        ' + detail : ''}`;
  }).join('\n');

  const bodyJson = JSON.stringify({
    from:    FROM_EMAIL,
    to:      ALERT_EMAIL,
    subject,
    text: `Production QA Alert \u2014 cricketmarketusa.com\nRun: ${startedAt}\n\n${passed} PASS  ${failed} FAIL  ${skipped} SKIP\n\nFailed:\n${failedTests.map((t) => `  \u2717 ${t.name}: ${t.detail || ''}`).join('\n')}\n\nAll results:\n${textLines}`,
    html,
  });

  await new Promise((resolve) => {
    const r = https.request({
      hostname: 'api.resend.com',
      port:     443,
      path:     '/emails',
      method:   'POST',
      headers: {
        Authorization:    `Bearer ${RESEND_KEY}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(bodyJson),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[QA] Alert email sent \u2192 ${ALERT_EMAIL}`);
        } else {
          console.error(`[QA] Resend error ${res.statusCode}: ${data}`);
        }
        resolve();
      });
    });
    r.on('error', (e) => { console.error('[QA] Alert email failed:', e.message); resolve(); });
    r.write(bodyJson);
    r.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const SEP = '\u2550'.repeat(52);
  const DIV = '\u2500'.repeat(52);
  console.log(`\n${SEP}`);
  console.log('  PRODUCTION QA AGENT \u2014 cricketmarketusa.com');
  console.log(`  ${startedAt}`);
  console.log(`${SEP}\n`);

  if (!QA_BEARER_TOKEN) {
    console.warn('[QA] QA_BEARER_TOKEN not set \u2014 authenticated tests will be skipped\n');
  }

  // ── 1. Health checks ──────────────────────────────────────────────────────
  console.log('\u2500\u2500 1. Health checks \u2500\u2500');

  for (const [label, baseUrl] of [
    ['auth   ', AUTH_URL],
    ['listing', LISTING_URL],
    ['escrow ', ESCROW_URL],
  ]) {
    await check(`${label} /health/live \u2192 200`, async () => {
      const { result: r, ms } = await timed(() => get(baseUrl, '/health/live', null));
      if (r.status !== 200 || !r.body.ok) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
      if (ms > 5000) throw new Error(`Slow response: ${ms}ms (limit 5000ms)`);
      pass(`${label} /health/live \u2192 200`, `${ms}ms  service=${r.body.service}`);
    });

    await check(`${label} /health/ready \u2192 200`, async () => {
      const { result: r, ms } = await timed(() => get(baseUrl, '/health/ready', null));
      if (r.status !== 200) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
      if (ms > 5000) throw new Error(`Slow response: ${ms}ms (limit 5000ms)`);
      pass(`${label} /health/ready \u2192 200`, `${ms}ms`);
    });
  }

  // ── 2. Frontend ───────────────────────────────────────────────────────────
  console.log('\n\u2500\u2500 2. Frontend \u2500\u2500');

  let frontendHtml    = '';
  let frontendHeaders = {};

  await check('GET www.cricketmarketusa.com \u2192 200', async () => {
    const { result: r, ms } = await timed(() => get(FRONTEND, '/', null));
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    if (ms > 8000) throw new Error(`Slow response: ${ms}ms (limit 8000ms)`);
    frontendHtml    = r.raw || '';
    frontendHeaders = r.headers || {};
    pass('GET www.cricketmarketusa.com \u2192 200', `${ms}ms  ${frontendHtml.length} bytes`);
  });

  await check('Frontend HTML contains "Cricket"', async () => {
    if (!frontendHtml) throw new Error('No HTML (prior request failed)');
    if (!frontendHtml.toLowerCase().includes('cricket')) {
      throw new Error('HTML does not contain "cricket" \u2014 wrong page or broken deploy');
    }
    const m = frontendHtml.match(/<title[^>]*>([^<]*)<\/title>/i);
    pass('Frontend HTML contains "Cricket"', m ? `title="${m[1].trim()}"` : 'found in body');
  });

  await check('Frontend does not expose stack traces', async () => {
    if (!frontendHtml) throw new Error('No HTML (prior request failed)');
    if (/at Object\.|at Function\.|node_modules/.test(frontendHtml)) {
      throw new Error('Stack trace found in HTML \u2014 error page may be leaking');
    }
    pass('Frontend does not expose stack traces');
  });

  // ── 3. Security headers ───────────────────────────────────────────────────
  console.log('\n\u2500\u2500 3. Security headers \u2500\u2500');

  let cspValue = '';

  await check('Content-Security-Policy header present', async () => {
    cspValue = frontendHeaders['content-security-policy'] || '';
    if (!cspValue) throw new Error('content-security-policy header missing');
    pass('Content-Security-Policy header present', `${cspValue.length} chars`);
  });

  if (cspValue) {
    await check('CSP: Turnstile in script-src and frame-src', async () => {
      const scriptSeg = cspValue.includes('script-src') ? cspValue.split('script-src')[1].split(';')[0] : '';
      const frameSeg  = cspValue.includes('frame-src')  ? cspValue.split('frame-src')[1].split(';')[0]  : '';
      if (!scriptSeg.includes('challenges.cloudflare.com')) throw new Error('challenges.cloudflare.com not in script-src');
      if (!frameSeg.includes('challenges.cloudflare.com'))  throw new Error('challenges.cloudflare.com not in frame-src');
      pass('CSP: Turnstile in script-src and frame-src');
    });

    await check('CSP: production backends in connect-src (7d82 / ccb1 / 7727)', async () => {
      if (!cspValue.includes('auth-service-production-7d82'))    throw new Error('auth-service-production-7d82 missing');
      if (!cspValue.includes('listing-service-production-ccb1')) throw new Error('listing-service-production-ccb1 missing');
      if (!cspValue.includes('escrow-service-production-7727'))  throw new Error('escrow-service-production-7727 missing');
      pass('CSP: production backends in connect-src (7d82 / ccb1 / 7727)');
    });

    await check('CSP: no staging backends (would indicate wrong build deployed)', async () => {
      const stagingIds = ['1f4c7', '3b3f', '1e20'];
      const found = stagingIds.filter((id) => cspValue.includes(id));
      if (found.length > 0) throw new Error(`Staging ID(s) in production CSP: ${found.join(', ')}`);
      pass('CSP: no staging backends', 'production build confirmed');
    });
  }

  await check('Frontend JS: no pk_test Stripe key (live key only)', async () => {
    if (!frontendHtml) throw new Error('No HTML (prior request failed)');
    if (frontendHtml.includes('pk_test')) throw new Error('pk_test found \u2014 test-mode Stripe key in production build');
    pass('Frontend JS: no pk_test Stripe key (live key only)');
  });

  // ── 4. Turnstile enforcement ──────────────────────────────────────────────
  console.log('\n\u2500\u2500 4. Turnstile enforcement \u2500\u2500');

  const turnstileEndpoints = [
    ['/auth/login',               { email: 'qa-probe@test.invalid', password: 'x' }],
    ['/auth/register',            { email: 'qa-probe@test.invalid', password: 'x', role: 'buyer' }],
    ['/auth/forgot-password',     { email: 'qa-probe@test.invalid' }],
    ['/auth/resend-verification', { email: 'qa-probe@test.invalid' }],
  ];

  for (const [path, body] of turnstileEndpoints) {
    await check(`${path} without token \u2192 400`, async () => {
      const r = await post(AUTH_URL, path, null, body);
      if (r.status !== 400) throw new Error(`expected 400 got ${r.status}: ${JSON.stringify(r.body)}`);
      if (!r.body.error?.includes('CAPTCHA')) throw new Error(`unexpected error: "${r.body.error}"`);
      pass(`${path} without token \u2192 400`, `"${r.body.error}"`);
    });
  }

  await check('/auth/login bad Turnstile token \u2192 403', async () => {
    const r = await post(AUTH_URL, '/auth/login', null, {
      email:           'qa-probe@test.invalid',
      password:        'TestPass1!',
      turnstile_token: 'INVALID-QA-PROBE-TOKEN',
    });
    if (r.status !== 403) throw new Error(`expected 403 got ${r.status}: ${JSON.stringify(r.body)}`);
    pass('/auth/login bad Turnstile token \u2192 403', 'Turnstile rejection confirmed');
  });

  // ── 5. Auth service — JWT verification ───────────────────────────────────
  console.log('\n\u2500\u2500 5. Auth service \u2500\u2500');

  await check('GET /auth/me no token \u2192 401', async () => {
    const r = await get(AUTH_URL, '/auth/me', null);
    if (r.status !== 401) throw new Error(`expected 401 got ${r.status}`);
    pass('GET /auth/me no token \u2192 401');
  });

  await check('GET /auth/me bad token \u2192 401', async () => {
    const r = await get(AUTH_URL, '/auth/me', 'not.a.valid.jwt');
    if (r.status !== 401) throw new Error(`expected 401 got ${r.status}`);
    pass('GET /auth/me bad token \u2192 401');
  });

  if (QA_BEARER_TOKEN) {
    await check('GET /auth/me QA buyer token \u2192 200', async () => {
      const r = await get(AUTH_URL, '/auth/me', QA_BEARER_TOKEN);
      if (r.status === 401) throw new Error('401 \u2014 QA_BEARER_TOKEN may be expired; rotate via Railway shell');
      if (r.status !== 200) throw new Error(`${r.status}: ${JSON.stringify(r.body)}`);
      if (r.body.role !== 'buyer') throw new Error(`unexpected role: "${r.body.role}" (expected "buyer")`);
      if (r.body.email !== 'qa-monitor@cricketmarketusa.com') {
        throw new Error(`unexpected email: "${r.body.email}" \u2014 QA_BEARER_TOKEN is for wrong account`);
      }
      if (r.body.stripe_account_id) throw new Error('QA account has a Stripe account \u2014 setup drift detected');
      pass('GET /auth/me QA buyer token \u2192 200', `id=${r.body.id} role=${r.body.role}`);
    });
  } else {
    skip('GET /auth/me QA buyer token \u2192 200', 'QA_BEARER_TOKEN not set');
  }

  // ── 6. Listing service ────────────────────────────────────────────────────
  console.log('\n\u2500\u2500 6. Listing service \u2500\u2500');

  let firstListingId = null;
  let listingCount   = 0;

  await check('GET /listings public \u2192 200', async () => {
    const { result: r, ms } = await timed(() => get(LISTING_URL, '/listings', null));
    if (r.status !== 200) throw new Error(`${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
    const listings = Array.isArray(r.body) ? r.body : (r.body.listings ?? r.body.data ?? []);
    listingCount = listings.length;
    if (listings.length > 0) firstListingId = listings[0].id;
    pass('GET /listings public \u2192 200', `${ms}ms  ${listings.length} listing(s)`);
  });

  if (listingCount === 0) {
    skip('GET /listings/:id \u2192 200', 'no listings in production DB');
  } else {
    await check(`GET /listings/${firstListingId} \u2192 200`, async () => {
      const { result: r, ms } = await timed(() => get(LISTING_URL, `/listings/${firstListingId}`, null));
      if (r.status !== 200) throw new Error(`${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
      const l = r.body.listing ?? r.body;
      pass(`GET /listings/${firstListingId} \u2192 200`, `${ms}ms  title="${l.title ?? '?'}"`);
    });
  }

  await check('POST /listings no auth \u2192 401', async () => {
    const r = await post(LISTING_URL, '/listings', null, { title: 'qa-probe', price_cents: 5000, category: 'bats' });
    if (r.status !== 401) throw new Error(`expected 401 got ${r.status}: ${JSON.stringify(r.body)}`);
    pass('POST /listings no auth \u2192 401', 'unauthenticated create blocked');
  });

  // ── 7. Escrow service ─────────────────────────────────────────────────────
  console.log('\n\u2500\u2500 7. Escrow service \u2500\u2500');

  await check('GET /orders no auth \u2192 401', async () => {
    const r = await get(ESCROW_URL, '/orders', null);
    if (r.status !== 401) throw new Error(`expected 401 got ${r.status}`);
    pass('GET /orders no auth \u2192 401');
  });

  if (QA_BEARER_TOKEN) {
    await check('GET /orders QA buyer \u2192 200 (DB reachable)', async () => {
      const { result: r, ms } = await timed(() => get(ESCROW_URL, '/orders', QA_BEARER_TOKEN));
      if (r.status === 401) throw new Error('401 \u2014 QA_BEARER_TOKEN may be expired; rotate via Railway shell');
      if (r.status !== 200) throw new Error(`${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
      const orders = Array.isArray(r.body) ? r.body : (r.body.orders ?? []);
      if (orders.length > 0) throw new Error(`QA account has ${orders.length} order(s) \u2014 unexpected; account should be clean`);
      pass('GET /orders QA buyer \u2192 200 (DB reachable)', `${ms}ms  0 orders (expected)`);
    });
  } else {
    skip('GET /orders QA buyer \u2192 200 (DB reachable)', 'QA_BEARER_TOKEN not set');
  }

  // ── 8. CORS ───────────────────────────────────────────────────────────────
  console.log('\n\u2500\u2500 8. CORS \u2500\u2500');

  for (const [label, baseUrl, path, method] of [
    ['auth   ', AUTH_URL,   '/auth/login', 'POST'],
    ['escrow ', ESCROW_URL, '/orders',     'GET'],
  ]) {
    await check(`${label} CORS preflight allows www.cricketmarketusa.com`, async () => {
      const r = await opts(baseUrl, path, {
        Origin:                         'https://www.cricketmarketusa.com',
        'Access-Control-Request-Method':  method,
        'Access-Control-Request-Headers': 'content-type,authorization',
      });
      if (r.status !== 204 && r.status !== 200) {
        throw new Error(`OPTIONS ${r.status} (expected 204 or 200)`);
      }
      const acao = (r.headers['access-control-allow-origin'] || '').toLowerCase();
      if (!acao.includes('cricketmarketusa.com') && acao !== '*') {
        throw new Error(`Access-Control-Allow-Origin: "${acao}" \u2014 production origin not allowed`);
      }
      pass(`${label} CORS preflight allows www.cricketmarketusa.com`, `ACAO: ${acao}`);
    });
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const durationMs = Date.now() - new Date(startedAt).getTime();
  const total = passed + failed + skipped;

  console.log(`\n${SEP}`);
  console.log('  PRODUCTION QA SUMMARY');
  console.log(SEP);
  results.forEach(({ name, status, detail }) => {
    const icon = status === 'PASS' ? '\u2713' : status === 'SKIP' ? '\u25cb' : '\u2717';
    console.log(`  ${icon}  [${status}] ${name}`);
    if (detail) console.log(`        ${detail}`);
  });
  console.log(DIV);
  console.log(`  ${total} checks: ${passed} PASS  ${failed} FAIL  ${skipped} SKIP  (${(durationMs / 1000).toFixed(1)}s)`);
  console.log(`${SEP}\n`);

  if (failed > 0) {
    console.log(`[QA] ${failed} failure(s) detected \u2014 sending alert email and exiting 1`);
    await sendAlertEmail();
    process.exit(1);
  } else {
    console.log('[QA] All checks passed.');
  }
})().catch((err) => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});

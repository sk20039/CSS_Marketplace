// tests/cors.test.js
// CORS origin allowlist tests for escrow-service.
// Run: node tests/cors.test.js
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST ||
  'postgres://escrow_user:escrow_pass@127.0.0.1:5432/escrow_db_test';
delete process.env.STRIPE_SECRET_KEY;
process.env.LISTING_SERVICE_URL = 'http://127.0.0.1:19876';
process.env.FRONTEND_ORIGIN = 'https://css-marketplace-frontend.vercel.app';

const request = require('supertest');
const { buildApp } = require('../src/app');

const app = buildApp();

// ---- Minimal test harness ----

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`);
}

// ---- Tests ----

(async () => {
  console.log('\n=== escrow-service CORS tests ===');

  await test('configured FRONTEND_ORIGIN is allowed', async () => {
    const origin = 'https://css-marketplace-frontend.vercel.app';
    const res = await request(app).get('/health/live').set('Origin', origin);
    assertEqual(
      res.headers['access-control-allow-origin'], origin,
      `expected ACAO=${origin}, got: ${res.headers['access-control-allow-origin']}`
    );
  });

  await test('Cricket Market Vercel Preview URL (commit hash) is allowed', async () => {
    const origin = 'https://css-marketplace-frontend-q19atcrh9-sk20039s-projects.vercel.app';
    const res = await request(app).get('/health/live').set('Origin', origin);
    assertEqual(
      res.headers['access-control-allow-origin'], origin,
      `expected ACAO=${origin}, got: ${res.headers['access-control-allow-origin']}`
    );
  });

  await test('Cricket Market Vercel Preview URL (branch slug) is allowed', async () => {
    const origin = 'https://css-marketplace-frontend-git-production-sk20039s-projects.vercel.app';
    const res = await request(app).get('/health/live').set('Origin', origin);
    assertEqual(
      res.headers['access-control-allow-origin'], origin,
      `expected ACAO=${origin}, got: ${res.headers['access-control-allow-origin']}`
    );
  });

  await test('permanent production domain allowed independently of FRONTEND_ORIGIN (via regex)', async () => {
    // Build a fresh app instance with FRONTEND_ORIGIN pointing elsewhere, so the
    // production domain is only allowed if VERCEL_PROD_RE covers it.
    const saved = process.env.FRONTEND_ORIGIN;
    process.env.FRONTEND_ORIGIN = 'http://localhost:3003';
    const app2 = buildApp();
    process.env.FRONTEND_ORIGIN = saved;
    const origin = 'https://css-marketplace-frontend.vercel.app';
    const res = await request(app2).get('/health/live').set('Origin', origin);
    assertEqual(
      res.headers['access-control-allow-origin'], origin,
      `expected ACAO=${origin}, got: ${res.headers['access-control-allow-origin']}`
    );
  });

  await test('Vercel team alias (css-marketplace-frontend-sk20039s-projects.vercel.app) is allowed', async () => {
    const origin = 'https://css-marketplace-frontend-sk20039s-projects.vercel.app';
    const res = await request(app).get('/health/live').set('Origin', origin);
    assertEqual(
      res.headers['access-control-allow-origin'], origin,
      `expected ACAO=${origin}, got: ${res.headers['access-control-allow-origin']}`
    );
  });

  await test('unrelated Vercel project with same team is rejected', async () => {
    const origin = 'https://evil-project-abc123-sk20039s-projects.vercel.app';
    const res = await request(app).get('/health/live').set('Origin', origin);
    assert(
      !res.headers['access-control-allow-origin'],
      `expected no ACAO header, got: ${res.headers['access-control-allow-origin']}`
    );
  });

  await test('unrelated external origin is rejected', async () => {
    const origin = 'https://evil.example.com';
    const res = await request(app).get('/health/live').set('Origin', origin);
    assert(
      !res.headers['access-control-allow-origin'],
      `expected no ACAO header, got: ${res.headers['access-control-allow-origin']}`
    );
  });

  await test('requests without Origin header continue to work', async () => {
    const res = await request(app).get('/health/live');
    assertEqual(res.status, 200, `expected 200, got ${res.status}`);
    assert(res.body.ok === true, 'ok must be true');
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();

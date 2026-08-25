// tests/smoke.test.js — escrow-service deployment smoke check.
// Uses only Node builtins; safe to run after `npm ci --omit=dev`.
// Verifies the app boots and /health/live returns 200 without a live DB.
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST || 'postgres://escrow_user:x@127.0.0.1:5432/smoke';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke-check-placeholder-32chars!!';
process.env.LISTING_SERVICE_URL = process.env.LISTING_SERVICE_URL || 'http://127.0.0.1:19876';
// Stub Stripe — no key means no network calls.
delete process.env.STRIPE_SECRET_KEY;

const http = require('http');
const { buildApp } = require('../src/app');

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}: ${err.message}`);
    failed++;
  }
}

async function get(port, path) {
  return new Promise((resolve, reject) => {
    let body = '';
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body: {} }); }
      });
    }).on('error', reject);
  });
}

(async () => {
  console.log('\n=== escrow-service deployment smoke check ===');

  const app = buildApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  await check('app module loads without errors', async () => {
    if (!app || typeof app !== 'function') throw new Error('buildApp() did not return an Express app');
  });

  await check('GET /health/live returns 200 ok (no DB required)', async () => {
    const { status, body } = await get(port, '/health/live');
    if (status !== 200) throw new Error(`expected 200, got ${status}`);
    if (!body.ok) throw new Error('expected ok:true');
    if (body.service !== 'escrow-service') throw new Error(`unexpected service name: ${body.service}`);
  });

  await check('GET /health/live does not expose secrets or stack traces', async () => {
    const { body } = await get(port, '/health/live');
    const s = JSON.stringify(body);
    if (s.includes('password')) throw new Error('response exposes password');
    if (s.includes('postgres://')) throw new Error('response exposes DATABASE_URL');
    if (s.includes('secret')) throw new Error('response exposes secret');
    if (s.includes('stack')) throw new Error('response exposes stack trace');
  });

  await check('GET /health/live does not require Authorization header', async () => {
    const { status } = await get(port, '/health/live');
    if (status === 401) throw new Error('/health/live must not require auth');
  });

  server.close();
  console.log(`\n${passed + failed} check(s): ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();

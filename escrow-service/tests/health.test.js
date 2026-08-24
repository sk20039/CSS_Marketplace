// tests/health.test.js
// Health endpoint tests for escrow-service.
// Run: node tests/health.test.js
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST ||
  'postgres://escrow_user:escrow_pass@127.0.0.1:5432/escrow_db_test';
// Stub Stripe and use a dead listing-service URL so no external calls are made.
delete process.env.STRIPE_SECRET_KEY;
process.env.LISTING_SERVICE_URL = 'http://127.0.0.1:19876';

const request = require('supertest');
const express = require('express');
const { buildApp } = require('../src/app');
const { buildHealthRouter } = require('../src/healthRoutes');

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
  console.log('\n=== escrow-service health endpoint tests ===');

  await test('GET /health/live returns 200 without touching the database', async () => {
    const res = await request(app).get('/health/live');
    assertEqual(res.status, 200, `expected 200, got ${res.status}`);
    assert(res.body.ok === true, 'ok must be true');
    assertEqual(res.body.service, 'escrow-service', 'service name must be escrow-service');
    assert(!('database' in res.body), '/health/live must not report database status');
  });

  await test('GET /health/ready returns 200 with connected database', async () => {
    const res = await request(app).get('/health/ready');
    assertEqual(res.status, 200, `expected 200, got ${res.status}`);
    assert(res.body.ok === true, 'ok must be true');
    assertEqual(res.body.service, 'escrow-service', 'service name must be escrow-service');
    assertEqual(res.body.database, 'connected', 'database must be "connected"');
  });

  await test('GET /health returns 200 (Railway alias for readiness)', async () => {
    const res = await request(app).get('/health');
    assertEqual(res.status, 200, `expected 200, got ${res.status}`);
    assert(res.body.ok === true, 'ok must be true');
    assertEqual(res.body.database, 'connected', 'database must be "connected"');
  });

  await test('health responses do not expose credentials, secrets, or stack traces', async () => {
    const res = await request(app).get('/health/ready');
    const body = JSON.stringify(res.body);
    assert(!body.includes('password'), 'must not expose password');
    assert(!body.includes('postgres://'), 'must not expose DATABASE_URL');
    assert(!body.includes('secret'), 'must not expose secrets');
    assert(!body.includes('stack'), 'must not expose stack traces');
  });

  await test('health endpoints do not require Authorization header', async () => {
    const [r1, r2, r3] = await Promise.all([
      request(app).get('/health/live'),
      request(app).get('/health/ready'),
      request(app).get('/health'),
    ]);
    assert(r1.status !== 401, '/health/live must not require auth');
    assert(r2.status !== 401, '/health/ready must not require auth');
    assert(r3.status !== 401, '/health must not require auth');
  });

  await test('GET /health/ready returns 503 when database is unavailable', async () => {
    const brokenPool = { query: () => Promise.reject(new Error('Connection refused')) };
    const failApp = express();
    failApp.use('/health', buildHealthRouter(brokenPool, 'escrow-service'));
    const res = await request(failApp).get('/health/ready');
    assertEqual(res.status, 503, `expected 503, got ${res.status}`);
    assert(res.body.ok === false, 'ok must be false');
    assertEqual(res.body.database, 'unavailable', 'database must be "unavailable"');
    assert(!JSON.stringify(res.body).includes('Connection refused'), 'must not expose internal error message');
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();

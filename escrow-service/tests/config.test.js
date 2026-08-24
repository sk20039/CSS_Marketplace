// tests/config.test.js
// Unit tests for escrow-service production environment validation.
// Pure — no database, no HTTP server, no file system access.
// Run: node tests/config.test.js
'use strict';

const { validateProductionEnv } = require('../src/config');

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

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertError(errors, fragment, label) {
  const found = errors.some((e) => e.toLowerCase().includes(fragment.toLowerCase()));
  if (!found) throw new Error(`Expected error containing "${fragment}" for: ${label}\nActual: ${JSON.stringify(errors)}`);
}

function assertNoError(errors, fragment, label) {
  const found = errors.some((e) => e.toLowerCase().includes(fragment.toLowerCase()));
  if (found) throw new Error(`Did NOT expect error containing "${fragment}" for: ${label}\nActual: ${JSON.stringify(errors)}`);
}

// Minimal valid production environment for escrow-service.
const VALID = {
  DATABASE_URL:             'postgres://escrow_user:s3cr3t@db.railway.internal:5432/escrow_db',
  JWT_SECRET:               'a-very-long-jwt-secret-that-is-at-least-32-chars!!',
  ADMIN_JWT_SECRET:         'another-long-admin-secret-at-least-32-characters!!',
  STRIPE_SECRET_KEY:        'sk_test_FAKE_KEY_FOR_CONFIG_TESTS_ONLY',
  LISTING_SERVICE_URL:      'http://listing.railway.internal:3002',
  APP_BASE_URL:             'https://api.example.com',
  FRONTEND_ORIGIN:          'https://example.com',
  INTERNAL_SERVICE_SECRET:  'yet-another-long-internal-secret-at-least-32-chars',
};

(async () => {
  console.log('\n=== escrow-service production config validation tests ===');

  // ---- Happy path ----
  test('valid production config passes with no errors', () => {
    const errors = validateProductionEnv(VALID);
    assert(errors.length === 0, `Expected 0 errors, got: ${JSON.stringify(errors)}`);
  });

  // ---- Missing variables ----
  test('missing DATABASE_URL is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, DATABASE_URL: undefined }), 'DATABASE_URL', 'missing');
  });

  test('missing JWT_SECRET is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, JWT_SECRET: undefined }), 'JWT_SECRET', 'missing');
  });

  test('missing ADMIN_JWT_SECRET is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, ADMIN_JWT_SECRET: undefined }), 'ADMIN_JWT_SECRET', 'missing');
  });

  test('missing STRIPE_SECRET_KEY is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, STRIPE_SECRET_KEY: undefined }), 'STRIPE_SECRET_KEY', 'missing');
  });

  test('missing LISTING_SERVICE_URL is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, LISTING_SERVICE_URL: undefined }), 'LISTING_SERVICE_URL', 'missing');
  });

  test('missing APP_BASE_URL is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, APP_BASE_URL: undefined }), 'APP_BASE_URL', 'missing');
  });

  test('missing FRONTEND_ORIGIN is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, FRONTEND_ORIGIN: undefined }), 'FRONTEND_ORIGIN', 'missing');
  });

  test('missing INTERNAL_SERVICE_SECRET is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, INTERNAL_SERVICE_SECRET: undefined }), 'INTERNAL_SERVICE_SECRET', 'missing');
  });

  // ---- Placeholder values ----
  test('"change-me" JWT_SECRET is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, JWT_SECRET: 'change-me' }), 'JWT_SECRET', 'placeholder');
  });

  test('"change_me" INTERNAL_SERVICE_SECRET is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, INTERNAL_SERVICE_SECRET: 'change_me' }), 'INTERNAL_SERVICE_SECRET', 'placeholder');
  });

  test('"your-secret-here" ADMIN_JWT_SECRET is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, ADMIN_JWT_SECRET: 'your-secret-here' }), 'ADMIN_JWT_SECRET', 'placeholder');
  });

  // ---- Secret length ----
  test('JWT_SECRET shorter than 32 characters is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, JWT_SECRET: 'short' }), 'JWT_SECRET', 'short');
  });

  test('JWT_SECRET exactly 32 characters passes', () => {
    const errors = validateProductionEnv({ ...VALID, JWT_SECRET: 'c'.repeat(32) });
    assertNoError(errors, 'JWT_SECRET', '32-char secret');
  });

  test('ADMIN_JWT_SECRET shorter than 32 characters is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, ADMIN_JWT_SECRET: 'short-admin-key' }), 'ADMIN_JWT_SECRET', 'short');
  });

  test('INTERNAL_SERVICE_SECRET shorter than 32 characters is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, INTERNAL_SERVICE_SECRET: 'tinykey' }), 'INTERNAL_SERVICE_SECRET', 'short');
  });

  test('INTERNAL_SERVICE_SECRET exactly 32 characters passes', () => {
    const errors = validateProductionEnv({ ...VALID, INTERNAL_SERVICE_SECRET: 'd'.repeat(32) });
    assertNoError(errors, 'INTERNAL_SERVICE_SECRET', '32-char internal secret');
  });

  // ---- Localhost URLs ----
  test('localhost LISTING_SERVICE_URL is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, LISTING_SERVICE_URL: 'http://localhost:3002' }), 'LISTING_SERVICE_URL', 'localhost');
  });

  test('HTTP LISTING_SERVICE_URL on private hostname is allowed', () => {
    // Internal VPC / Railway internal URLs may use HTTP — only localhost is blocked.
    const errors = validateProductionEnv({ ...VALID, LISTING_SERVICE_URL: 'http://listing.railway.internal:3002' });
    assertNoError(errors, 'LISTING_SERVICE_URL', 'private HTTP URL');
  });

  test('localhost APP_BASE_URL is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, APP_BASE_URL: 'http://localhost:3003' }), 'APP_BASE_URL', 'localhost');
  });

  test('localhost FRONTEND_ORIGIN is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, FRONTEND_ORIGIN: 'http://localhost:3003' }), 'FRONTEND_ORIGIN', 'localhost');
  });

  // ---- HTTP vs HTTPS ----
  test('HTTP APP_BASE_URL is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, APP_BASE_URL: 'http://api.example.com' }), 'APP_BASE_URL', 'HTTPS');
  });

  test('HTTP FRONTEND_ORIGIN is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, FRONTEND_ORIGIN: 'http://example.com' }), 'FRONTEND_ORIGIN', 'HTTPS');
  });

  // ---- Multiple errors ----
  test('multiple bad values produce multiple errors', () => {
    const errors = validateProductionEnv({
      ...VALID,
      JWT_SECRET: 'change-me',
      STRIPE_SECRET_KEY: undefined,
      APP_BASE_URL: 'http://localhost:3003',
      INTERNAL_SERVICE_SECRET: 'short',
    });
    assert(errors.length >= 4, `Expected >=4 errors, got ${errors.length}: ${JSON.stringify(errors)}`);
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();

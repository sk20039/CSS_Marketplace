// tests/config.test.js
// Unit tests for listing-service production environment validation.
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

// Minimal valid production environment for listing-service.
const VALID = {
  DATABASE_URL:    'postgres://listing_user:s3cr3t@db.railway.internal:5432/listing_db',
  JWT_SECRET:      'a-very-long-jwt-secret-that-is-at-least-32-chars!!',
  FRONTEND_ORIGIN: 'https://example.com',
  PUBLIC_BASE_URL: 'https://listing.example.com',
};

(async () => {
  console.log('\n=== listing-service production config validation tests ===');

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

  test('missing FRONTEND_ORIGIN is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, FRONTEND_ORIGIN: undefined }), 'FRONTEND_ORIGIN', 'missing');
  });

  test('missing PUBLIC_BASE_URL is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, PUBLIC_BASE_URL: undefined }), 'PUBLIC_BASE_URL', 'missing');
  });

  // ---- Placeholder values ----
  test('"change-me" JWT_SECRET is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, JWT_SECRET: 'change-me' }), 'JWT_SECRET', 'placeholder');
  });

  test('"change_me" JWT_SECRET is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, JWT_SECRET: 'change_me' }), 'JWT_SECRET', 'placeholder');
  });

  test('"placeholder" DATABASE_URL is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, DATABASE_URL: 'placeholder' }), 'DATABASE_URL', 'placeholder');
  });

  // ---- Secret length ----
  test('JWT_SECRET shorter than 32 characters is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, JWT_SECRET: 'too-short' }), 'JWT_SECRET', 'short');
  });

  test('JWT_SECRET exactly 32 characters passes', () => {
    const errors = validateProductionEnv({ ...VALID, JWT_SECRET: 'b'.repeat(32) });
    assertNoError(errors, 'JWT_SECRET', '32-char secret');
  });

  test('JWT_SECRET 31 characters is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, JWT_SECRET: 'a'.repeat(31) }), 'JWT_SECRET', '31-char');
  });

  // ---- Localhost URLs ----
  test('FRONTEND_ORIGIN with localhost is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, FRONTEND_ORIGIN: 'http://localhost:3003' }), 'FRONTEND_ORIGIN', 'localhost');
  });

  test('PUBLIC_BASE_URL with localhost is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, PUBLIC_BASE_URL: 'http://localhost:3002' }), 'PUBLIC_BASE_URL', 'localhost');
  });

  test('PUBLIC_BASE_URL with 127.0.0.1 is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, PUBLIC_BASE_URL: 'http://127.0.0.1:3002' }), 'PUBLIC_BASE_URL', 'PUBLIC_BASE_URL');
  });

  // ---- HTTP vs HTTPS ----
  test('HTTP FRONTEND_ORIGIN is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, FRONTEND_ORIGIN: 'http://example.com' }), 'FRONTEND_ORIGIN', 'HTTPS');
  });

  test('HTTP PUBLIC_BASE_URL is rejected', () => {
    assertError(validateProductionEnv({ ...VALID, PUBLIC_BASE_URL: 'http://listing.example.com' }), 'PUBLIC_BASE_URL', 'HTTPS');
  });

  test('HTTPS PUBLIC_BASE_URL passes', () => {
    const errors = validateProductionEnv(VALID);
    assertNoError(errors, 'PUBLIC_BASE_URL', 'https PUBLIC_BASE_URL');
  });

  // ---- Multiple errors ----
  test('multiple bad values produce multiple errors', () => {
    const errors = validateProductionEnv({
      ...VALID,
      JWT_SECRET: 'change-me',
      FRONTEND_ORIGIN: undefined,
      PUBLIC_BASE_URL: 'http://localhost:3002',
    });
    assert(errors.length >= 3, `Expected >=3 errors, got ${errors.length}: ${JSON.stringify(errors)}`);
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();

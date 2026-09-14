'use strict';

// Focused unit tests for the toWeightOz conversion used in the Create Listing
// form.  Mirrors the exact logic in app/listings/new/page.tsx.
// Run with: node frontend/tests/weightConversion.test.js

function toWeightOz(value, unit) {
  const n = parseFloat(value);
  if (isNaN(n)) return NaN;
  if (unit === 'lb') return n * 16;
  if (unit === 'kg') return n * 35.27396195;
  return n; // already oz
}

let passed = 0;
let failed = 0;

function expect(label, actual, expected, tolerance = 0) {
  const ok = tolerance
    ? Math.abs(actual - expected) <= tolerance
    : actual === expected;
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}: expected ${expected}, got ${actual}`);
    failed++;
  }
}

function expectNaN(label, actual) {
  if (isNaN(actual)) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}: expected NaN, got ${actual}`);
    failed++;
  }
}

console.log('toWeightOz — unit conversion');

// oz passthrough
expect('1 oz → 1 oz',         toWeightOz('1', 'oz'),   1);
expect('64 oz → 64 oz',       toWeightOz('64', 'oz'),  64);
expect('0.5 oz → 0.5 oz',     toWeightOz('0.5', 'oz'), 0.5);

// lb → oz  (1 lb = 16 oz)
expect('1 lb → 16 oz',        toWeightOz('1', 'lb'),   16);
expect('2.5 lb → 40 oz',      toWeightOz('2.5', 'lb'), 40);
expect('0.5 lb → 8 oz',       toWeightOz('0.5', 'lb'), 8);
expect('4 lb → 64 oz',        toWeightOz('4', 'lb'),   64);
expect('0.25 lb → 4 oz',      toWeightOz('0.25', 'lb'), 4);

// kg → oz  (1 kg = 35.27396195 oz)
expect('1 kg → 35.27396195 oz',   toWeightOz('1', 'kg'),   35.27396195, 0.000001);
expect('0.5 kg → ~17.637 oz',     toWeightOz('0.5', 'kg'), 17.636980975, 0.000001);
expect('1.25 kg → ~44.092 oz',    toWeightOz('1.25', 'kg'), 44.09245244, 0.000001);

// edge cases
expectNaN('empty string → NaN',   toWeightOz('', 'lb'));
expectNaN('non-numeric → NaN',    toWeightOz('abc', 'lb'));
expect('zero oz → 0',             toWeightOz('0', 'oz'), 0);

// backward compatibility — existing oz values stored in DB are unchanged
expect('existing 32 oz listing — oz unit round-trips',
  toWeightOz('32', 'oz'), 32);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

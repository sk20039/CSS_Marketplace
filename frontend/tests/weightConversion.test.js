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

// ---------------------------------------------------------------------------
// preloadWeightDisplay — mirrors the draft-preload logic in page.tsx
// If weight_oz >= 16 → display in lb; else display in oz
// ---------------------------------------------------------------------------
function preloadWeightDisplay(weight_oz) {
  if (weight_oz >= 16) {
    return { value: String(weight_oz / 16), unit: 'lb' };
  }
  return { value: String(weight_oz), unit: 'oz' };
}

console.log('\npreloadWeightDisplay — draft reopen display');

// 32 oz loads as 2 lb
(function () {
  const { value, unit } = preloadWeightDisplay(32);
  expect('32 oz → value "2"', value, '2');
  expect('32 oz → unit "lb"', unit, 'lb');
})();

// 24 oz loads as 1.5 lb
(function () {
  const { value, unit } = preloadWeightDisplay(24);
  expect('24 oz → value "1.5"', value, '1.5');
  expect('24 oz → unit "lb"', unit, 'lb');
})();

// 15 oz loads as 15 oz (< 16 threshold)
(function () {
  const { value, unit } = preloadWeightDisplay(15);
  expect('15 oz → value "15"', value, '15');
  expect('15 oz → unit "oz"', unit, 'oz');
})();

console.log('\npreloadWeightDisplay — load-then-save preserves original oz value');

// Load and save round-trips
expect('32 oz: preload→save round-trip',
  toWeightOz(...Object.values(preloadWeightDisplay(32))), 32);
expect('24 oz: preload→save round-trip',
  toWeightOz(...Object.values(preloadWeightDisplay(24))), 24);
expect('15 oz: preload→save round-trip',
  toWeightOz(...Object.values(preloadWeightDisplay(15))), 15);

// Repeated editing: load → save → reload → save must not drift
(function () {
  const cases = [32, 24, 15, 16, 8];
  console.log('\npreloadWeightDisplay — repeated editing does not drift');
  cases.forEach((originalOz) => {
    const { value: v1, unit: u1 } = preloadWeightDisplay(originalOz);
    const savedOz1 = toWeightOz(v1, u1);
    const { value: v2, unit: u2 } = preloadWeightDisplay(savedOz1);
    const savedOz2 = toWeightOz(v2, u2);
    expect(`${originalOz} oz: two save cycles still ${originalOz} oz`, savedOz2, originalOz);
  });
})();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

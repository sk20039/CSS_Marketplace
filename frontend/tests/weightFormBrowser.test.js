'use strict';

/**
 * Browser-level test for draft weight unit display.
 * Exercises the real form code via Playwright with mocked API responses.
 * Run with: node frontend/tests/weightFormBrowser.test.js
 */

const { chromium } = require('@playwright/test');

const BASE = 'http://localhost:3098';
const AUTH_URL = 'http://localhost:3001';
const LISTING_URL = 'http://localhost:3002';

const MOCK_USER = { id: 1, name: 'Test Seller', email: 'test@test.com', role: 'seller' };
const MOCK_TOKEN = 'fake_test_token_for_weight_test';

let passed = 0;
let failed = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  \u2713 ${label}`);
    passed++;
  } else {
    console.error(`  \u2717 ${label}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

/**
 * Set up route mocks for auth and listing API, then navigate to
 * /listings/new?edit=42 where the listing has weight_oz = oz.
 * Returns { weightValue, weightUnit } read from the form inputs.
 */
async function loadDraftAndReadWeightField(page, oz) {
  const listing = {
    id: 42,
    title: 'Test Bat',
    description: 'Test',
    price_cents: 5000,
    category: 'bat',
    condition: 'used_good',
    weight_oz: oz,
    pkg_length_in: 10,
    pkg_width_in: 5,
    pkg_height_in: 2,
    photos: [],
    status: 'draft',
  };

  await page.route(`${AUTH_URL}/auth/refresh`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ access_token: MOCK_TOKEN }) }));

  await page.route(`${AUTH_URL}/auth/me`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(MOCK_USER) }));

  await page.route(`${LISTING_URL}/listings/mine`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ listings: [listing] }) }));

  await page.goto(`${BASE}/listings/new?edit=42`, { waitUntil: 'networkidle' });

  // Wait for the weight input to be populated by the useEffect
  await page.waitForFunction(() => {
    const inp = document.querySelector('input[type="number"][min="0.01"]');
    return inp && inp.value !== '';
  }, { timeout: 5000 }).catch(() => {});

  const weightValue = await page.$eval('input[type="number"][min="0.01"]', (el) => el.value);
  const weightUnit  = await page.$eval('select', (el) => el.value);

  await page.unrouteAll();

  return { weightValue, weightUnit };
}

/** Mirrors the exact toWeightOz from page.tsx */
function toWeightOz(value, unit) {
  const n = parseFloat(value);
  if (isNaN(n)) return NaN;
  if (unit === 'lb') return n * 16;
  if (unit === 'kg') return n * 35.27396195;
  return n;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  try {
    // --- Preload display ---
    const cases = [
      { oz: 32,  expectValue: '2',      expectUnit: 'lb', label: '32 oz loads as 2 lb' },
      { oz: 24,  expectValue: '1.5',    expectUnit: 'lb', label: '24 oz loads as 1.5 lb' },
      { oz: 15,  expectValue: '15',     expectUnit: 'oz', label: '15 oz loads as 15 oz' },
      { oz: 17,  expectValue: '1.0625', expectUnit: 'lb', label: '17 oz loads as 1.0625 lb' },
      { oz: 16,  expectValue: '1',      expectUnit: 'lb', label: '16 oz (boundary) loads as 1 lb' },
    ];

    console.log('Form preload — weight display');
    for (const c of cases) {
      const page = await context.newPage();
      const { weightValue, weightUnit } = await loadDraftAndReadWeightField(page, c.oz);
      assert(c.label, weightValue === c.expectValue && weightUnit === c.expectUnit,
        `got value="${weightValue}" unit="${weightUnit}"`);
      await page.close();
    }

    // --- Save round-trips ---
    console.log('\nForm preload — save round-trips preserve original oz');
    for (const oz of [32, 24, 15, 17, 16, 8]) {
      const page = await context.newPage();
      const { weightValue, weightUnit } = await loadDraftAndReadWeightField(page, oz);
      const savedOz = toWeightOz(weightValue, weightUnit);
      assert(`${oz} oz: preload then save = ${oz} oz`, savedOz === oz, `got ${savedOz}`);
      await page.close();
    }

    // --- Step validation: step="any" must accept 1.0625 ---
    console.log('\nInput step validation');
    {
      const page = await context.newPage();
      await loadDraftAndReadWeightField(page, 17);
      const validity = await page.$eval('input[type="number"][min="0.01"]', (el) => ({
        valid: el.validity.valid,
        stepMismatch: el.validity.stepMismatch,
        value: el.value,
        step: el.step,
      }));
      assert('step attribute is "any"', validity.step === 'any', `got step="${validity.step}"`);
      assert('1.0625 lb passes HTML5 validity', validity.valid === true,
        `valid=${validity.valid} stepMismatch=${validity.stepMismatch}`);
      assert('no stepMismatch for 1.0625', validity.stepMismatch === false,
        `stepMismatch=${validity.stepMismatch}`);
      await page.close();
    }

    // --- Repeated editing ---
    console.log('\nRepeated editing does not drift');
    for (const oz of [32, 24, 15, 17]) {
      const page1 = await context.newPage();
      const r1 = await loadDraftAndReadWeightField(page1, oz);
      const saved1 = toWeightOz(r1.weightValue, r1.weightUnit);
      await page1.close();

      const page2 = await context.newPage();
      const r2 = await loadDraftAndReadWeightField(page2, saved1);
      const saved2 = toWeightOz(r2.weightValue, r2.weightUnit);
      assert(`${oz} oz: two save cycles still ${oz} oz`, saved2 === oz, `after 2 cycles got ${saved2}`);
      await page2.close();
    }

  } finally {
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

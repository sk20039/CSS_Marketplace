'use strict';

// Focused test: verify the CSP img-src directive in next.config.js includes blob:
// so that URL.createObjectURL previews are not blocked by the browser.
// Run with: node frontend/tests/cspBlobPreview.test.js

const path = require('path');

let passed = 0;
let failed = 0;

function expect(label, actual, expected) {
  if (actual === expected) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  }
}

function expectTrue(label, value) {
  expect(label, value, true);
}

console.log('CSP img-src blob: directive');

// Read the next.config.js source to verify blob: is present in img-src
const configPath = path.join(__dirname, '..', 'next.config.js');
const src = require('fs').readFileSync(configPath, 'utf8');

// Extract the img-src line
const imgSrcMatch = src.match(/`img-src[^`]+`/);
expectTrue('img-src directive exists in config', !!imgSrcMatch);

if (imgSrcMatch) {
  const imgSrc = imgSrcMatch[0];
  expectTrue("img-src contains 'self'",         imgSrc.includes("'self'"));
  expectTrue("img-src contains 'data:'",        imgSrc.includes('data:'));
  expectTrue("img-src contains 'blob:'",        imgSrc.includes('blob:'));
  expectTrue("img-src contains stripe wildcard", imgSrc.includes('https://*.stripe.com'));
}

// Verify blob: appears BEFORE the template literal variable (so it's always present)
const blobIdx  = src.indexOf('blob:');
const templateIdx = src.indexOf('${listingImgSrc');
expectTrue('blob: is unconditional (not inside template expression)', blobIdx < templateIdx);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

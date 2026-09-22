'use strict';

// Unit tests for photo removal logic in frontend/app/listings/new/page.tsx.
// Tests the pure state-transition logic; no DOM or React required.
// Run with: node frontend/tests/photoRemove.test.js

let passed = 0;
let failed = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${label}: ${e.message}`);
    failures.push(label + ': ' + e.message);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// ---------------------------------------------------------------------------
// Model: mirror the state update functions from page.tsx
// ---------------------------------------------------------------------------

function removeNewPhotoAt(photos, previews, index) {
  // Mirrors handleRemoveNewPhoto — returns new [photos, previews]
  return [
    photos.filter((_, i) => i !== index),
    previews.filter((_, i) => i !== index),
  ];
}

function remainingSlots(existingCount, newCount) {
  // Mirrors: Math.max(0, 5 - existingPhotos.length - photos.length)
  return Math.max(0, 5 - existingCount - newCount);
}

function handleFilesSlice(allFiles, existingCount) {
  // Mirrors: files.slice(0, Math.max(0, 5 - existingPhotos.length))
  const maxNew = Math.max(0, 5 - existingCount);
  return allFiles.slice(0, maxNew);
}

// ---------------------------------------------------------------------------
// Tests: remaining slot count
// ---------------------------------------------------------------------------

console.log('\nremaining slot count');

check('0 existing + 0 new → 5 slots', () => {
  assert(remainingSlots(0, 0) === 5);
});

check('0 existing + 3 new → 2 slots', () => {
  assert(remainingSlots(0, 3) === 2, `got ${remainingSlots(0, 3)}`);
});

check('0 existing + 5 new → 0 slots', () => {
  assert(remainingSlots(0, 5) === 0);
});

check('3 existing + 0 new → 2 slots', () => {
  assert(remainingSlots(3, 0) === 2);
});

check('3 existing + 2 new → 0 slots', () => {
  assert(remainingSlots(3, 2) === 0);
});

check('5 existing + 0 new → 0 slots (never negative)', () => {
  assert(remainingSlots(5, 0) === 0);
});

check('4 existing + 3 new → 0 slots (never negative)', () => {
  assert(remainingSlots(4, 3) === 0);
});

// ---------------------------------------------------------------------------
// Tests: removing a new photo
// ---------------------------------------------------------------------------

console.log('\nremoving a new photo');

const FILES = ['a.jpg', 'b.jpg', 'c.jpg'];
const URLS  = ['blob:a',  'blob:b',  'blob:c'];

check('remove first photo — others stay', () => {
  const [p, u] = removeNewPhotoAt(FILES, URLS, 0);
  assert(p.length === 2 && p[0] === 'b.jpg' && p[1] === 'c.jpg', JSON.stringify(p));
  assert(u.length === 2 && u[0] === 'blob:b' && u[1] === 'blob:c', JSON.stringify(u));
});

check('remove middle photo — first and last remain', () => {
  const [p, u] = removeNewPhotoAt(FILES, URLS, 1);
  assert(p.length === 2 && p[0] === 'a.jpg' && p[1] === 'c.jpg', JSON.stringify(p));
  assert(u.length === 2 && u[0] === 'blob:a' && u[1] === 'blob:c', JSON.stringify(u));
});

check('remove last photo — first two remain', () => {
  const [p, u] = removeNewPhotoAt(FILES, URLS, 2);
  assert(p.length === 2 && p[0] === 'a.jpg' && p[1] === 'b.jpg', JSON.stringify(p));
  assert(u.length === 2 && u[0] === 'blob:a' && u[1] === 'blob:b', JSON.stringify(u));
});

check('remove only photo — both arrays empty', () => {
  const [p, u] = removeNewPhotoAt(['solo.jpg'], ['blob:s'], 0);
  assert(p.length === 0 && u.length === 0);
});

check('after removing middle photo, slot count increases by 1', () => {
  const beforeSlots = remainingSlots(0, 3);  // 2
  const [newPhotos] = removeNewPhotoAt(FILES, URLS, 1);
  const afterSlots = remainingSlots(0, newPhotos.length);  // 3
  assert(afterSlots === beforeSlots + 1, `before=${beforeSlots} after=${afterSlots}`);
});

check('indices stay correct after removal (photo at i+1 becomes i)', () => {
  const [p] = removeNewPhotoAt(FILES, URLS, 0);
  assert(p[0] === 'b.jpg', 'index 0 should now be b.jpg');
  assert(p[1] === 'c.jpg', 'index 1 should now be c.jpg');
});

// ---------------------------------------------------------------------------
// Tests: handleFiles slot cap
// ---------------------------------------------------------------------------

console.log('\nhandleFiles slot capping');

check('5 files selected, 0 existing → all 5 accepted', () => {
  const all = ['a','b','c','d','e'];
  assert(handleFilesSlice(all, 0).length === 5);
});

check('5 files selected, 3 existing → only 2 accepted', () => {
  const all = ['a','b','c','d','e'];
  assert(handleFilesSlice(all, 3).length === 2, `got ${handleFilesSlice(all, 3).length}`);
});

check('1 file selected, 5 existing → 0 accepted (cap at 0)', () => {
  assert(handleFilesSlice(['a'], 5).length === 0);
});

check('handleFiles replaces all new photos regardless of prior selection', () => {
  // Simulate: had 3 new selected, user opens picker and selects 4 new files
  // existingCount=0 → maxNew=5, so 4 accepted; slot count resets to 5-0-4=1
  const existingCount = 0;
  const newFiles = ['w','x','y','z'];
  const accepted = handleFilesSlice(newFiles, existingCount);
  assert(accepted.length === 4);
  assert(remainingSlots(existingCount, accepted.length) === 1);
});

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\nFailed:');
  failures.forEach((f) => console.log(`  ✗ ${f}`));
  process.exit(1);
}

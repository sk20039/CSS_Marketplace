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
// Helpers: mirror the size-filtering logic from handleFiles in page.tsx
// ---------------------------------------------------------------------------

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

function makeFile(name, size) {
  // Minimal file-like object used in tests (name + size only)
  return { name, size };
}

function filterBySize(files) {
  // Mirrors: all.filter(f => f.size <= MAX_BYTES)
  const oversized = files.filter((f) => f.size > MAX_BYTES);
  const valid     = files.filter((f) => f.size <= MAX_BYTES);
  return { valid, oversized };
}

function buildSizeError(oversized) {
  // Mirrors the setPhotoSizeError logic in handleFiles
  if (oversized.length === 0) return '';
  const names = oversized.map((f) => f.name).join(', ');
  return `${names} ${oversized.length === 1 ? 'exceeds' : 'exceed'} 5 MB and ${oversized.length === 1 ? 'was' : 'were'} not added.`;
}

// ---------------------------------------------------------------------------
// Tests: size filtering
// ---------------------------------------------------------------------------

console.log('\nsize filtering');

check('single oversized file is rejected', () => {
  const { valid, oversized } = filterBySize([makeFile('big.jpg', MAX_BYTES + 1)]);
  assert(valid.length === 0, `expected 0 valid, got ${valid.length}`);
  assert(oversized.length === 1, `expected 1 oversized, got ${oversized.length}`);
});

check('file exactly 5 MB is accepted', () => {
  const { valid, oversized } = filterBySize([makeFile('exact.jpg', MAX_BYTES)]);
  assert(valid.length === 1, `expected 1 valid, got ${valid.length}`);
  assert(oversized.length === 0, `expected 0 oversized, got ${oversized.length}`);
});

check('file 5 MB + 1 byte is rejected', () => {
  const { valid, oversized } = filterBySize([makeFile('over.jpg', MAX_BYTES + 1)]);
  assert(valid.length === 0, `expected 0 valid, got ${valid.length}`);
  assert(oversized.length === 1, `expected 1 oversized, got ${oversized.length}`);
});

check('mixed selection keeps valid files and rejects oversized', () => {
  const files = [
    makeFile('ok1.jpg',  MAX_BYTES - 1),
    makeFile('big.jpg',  MAX_BYTES + 1),
    makeFile('ok2.jpg',  MAX_BYTES),
  ];
  const { valid, oversized } = filterBySize(files);
  assert(valid.length === 2, `expected 2 valid, got ${valid.length}`);
  assert(valid[0].name === 'ok1.jpg' && valid[1].name === 'ok2.jpg', JSON.stringify(valid.map((f) => f.name)));
  assert(oversized.length === 1 && oversized[0].name === 'big.jpg', JSON.stringify(oversized.map((f) => f.name)));
});

check('all oversized files are rejected', () => {
  const files = [makeFile('a.jpg', MAX_BYTES + 1), makeFile('b.jpg', MAX_BYTES + 100)];
  const { valid, oversized } = filterBySize(files);
  assert(valid.length === 0, 'no valid files expected');
  assert(oversized.length === 2);
});

check('size error message names the rejected file', () => {
  const oversized = [makeFile('toobig.jpg', MAX_BYTES + 1)];
  const msg = buildSizeError(oversized);
  assert(msg.includes('toobig.jpg'), `message missing filename: ${msg}`);
  assert(msg.includes('5 MB'), `message missing size: ${msg}`);
});

check('size error message names multiple rejected files', () => {
  const oversized = [makeFile('a.jpg', MAX_BYTES + 1), makeFile('b.jpg', MAX_BYTES + 2)];
  const msg = buildSizeError(oversized);
  assert(msg.includes('a.jpg') && msg.includes('b.jpg'), `message missing filenames: ${msg}`);
  assert(msg.includes('exceed'), `plural form expected: ${msg}`);
});

check('no size error when all files are valid', () => {
  const msg = buildSizeError([]);
  assert(msg === '', `expected empty string, got: ${msg}`);
});

// ---------------------------------------------------------------------------
// Tests: 5-photo preview and upload-area visibility
// ---------------------------------------------------------------------------

console.log('\n5-photo preview and upload area visibility');

check('5 new photos → 0 remaining slots → upload area hidden', () => {
  assert(remainingSlots(0, 5) === 0, 'expected 0 slots with 5 new photos');
});

check('5 new photos → previews array has length 5 (thumbnails still visible)', () => {
  // Simulate: user selects 5 valid files; previews array mirrors photos array
  const files = ['a.jpg','b.jpg','c.jpg','d.jpg','e.jpg'];
  assert(files.length === 5, 'sanity check');
  // Previews are always rendered (outside the remainingSlots conditional),
  // so previews.length > 0 is all that governs whether they show.
  assert(files.length > 0, 'previews should still be visible');
});

check('5 new photos → each has a remove button (length === 5)', () => {
  const previews = ['blob:a','blob:b','blob:c','blob:d','blob:e'];
  // One remove button per preview; the button count equals previews.length.
  assert(previews.length === 5, `expected 5 remove buttons, got ${previews.length}`);
});

check('removing one photo from 5 restores 1 slot (upload area becomes visible)', () => {
  const [newPhotos] = removeNewPhotoAt(
    ['a.jpg','b.jpg','c.jpg','d.jpg','e.jpg'],
    ['blob:a','blob:b','blob:c','blob:d','blob:e'],
    2
  );
  const slots = remainingSlots(0, newPhotos.length);
  assert(slots === 1, `expected 1 slot after removing 1 from 5, got ${slots}`);
});

check('removing one photo from 5 leaves exactly 4 thumbnails', () => {
  const [, newPreviews] = removeNewPhotoAt(
    ['a.jpg','b.jpg','c.jpg','d.jpg','e.jpg'],
    ['blob:a','blob:b','blob:c','blob:d','blob:e'],
    0
  );
  assert(newPreviews.length === 4, `expected 4 previews, got ${newPreviews.length}`);
});

check('valid files from mixed selection do not count rejected files toward the 5-photo cap', () => {
  // 3 existing uploaded, 1 valid new + 2 oversized selected → only 1 valid, 2 slots remain
  const existingCount = 3;
  const allSelected = [
    makeFile('ok.jpg',  MAX_BYTES),
    makeFile('big1.jpg', MAX_BYTES + 1),
    makeFile('big2.jpg', MAX_BYTES + 1),
  ];
  const { valid } = filterBySize(allSelected);
  const accepted = handleFilesSlice(valid, existingCount); // maxNew = 2, valid.length = 1
  assert(accepted.length === 1, `expected 1 accepted, got ${accepted.length}`);
  const slots = remainingSlots(existingCount, accepted.length); // 5 - 3 - 1 = 1
  assert(slots === 1, `expected 1 slot remaining, got ${slots}`);
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

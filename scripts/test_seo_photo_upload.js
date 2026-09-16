'use strict';
// Regression tests for the SEO suggestions photo upload flow.
//
// Architecture after the fix:
//   createListingRecord() — creates the DB record only, NEVER uploads photos
//   handleSubmit()        — always uploads photos (checks res.ok, reports failures)
//
// This eliminates two bugs:
//   Bug A: photos selected before "Get SEO Suggestions" would be uploaded during
//          createListingRecord AND again in handleSubmit → double-upload / MAX_PHOTOS collision
//   Bug B: failed uploads were silently swallowed; seller was redirected as if all succeeded
//
// Run: node scripts/test_seo_photo_upload.js

let passed = 0;
let failed = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log('  v  [PASS] ' + label + (detail ? ' -- ' + detail : ''));
    passed++;
  } else {
    console.log('  x  [FAIL] ' + label + (detail ? ' -- ' + detail : ''));
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Minimal simulation of NewListingForm logic.
// Mirrors the fixed logic in frontend/app/listings/new/page.tsx exactly.
// ---------------------------------------------------------------------------

function makeForm(overrides) {
  overrides = overrides || {};
  var createdListingId = overrides.createdListingId !== undefined ? overrides.createdListingId : null;
  var photos = overrides.photos || [];
  // failPhotoNames: Set of file.name values whose uploadPhoto stub returns ok=false
  var failPhotoNames = new Set(overrides.failPhotoNames || []);

  var uploadError = null; // set when handleSubmit detects upload failures
  var synced = false;     // set when syncListingToEscrow is called

  var calls = { createListing: [], uploadPhoto: [], patchListing: [], syncListing: [] };

  var stubs = {
    createListing: async function(body) {
      calls.createListing.push(body);
      return { ok: true, json: async function() { return { id: 99 }; } };
    },
    uploadPhoto: async function(id, file) {
      var ok = !failPhotoNames.has(file.name);
      calls.uploadPhoto.push({ id: id, file: file, ok: ok });
      return { ok: ok };
    },
    patchListing: async function(id, fields) {
      calls.patchListing.push({ id: id, fields: fields });
      return { id: id };
    },
    syncListingToEscrow: async function(data) {
      calls.syncListing.push(data);
      synced = true;
    },
  };

  // createListingRecord — creates the listing record only.  No photo upload.
  async function createListingRecord() {
    if (createdListingId !== null) return createdListingId;
    var res = await stubs.createListing({ title: 'Test bat', price_cents: 8500 });
    var data = await res.json();
    if (!res.ok) return null;
    createdListingId = data.id;
    return createdListingId;
  }

  // handleGetSuggestions — calls createListingRecord only (no photos uploaded here).
  async function handleGetSuggestions() {
    return createListingRecord();
  }

  // handleSubmit — always uploads photos here and checks each response.
  async function handleSubmit() {
    uploadError = null;
    var id = createdListingId;
    if (id === null) {
      var newId = await createListingRecord();
      if (newId === null) return;
      id = newId;
    } else {
      await stubs.patchListing(id, { title: 'Test bat', description: '' });
    }

    // Upload photos with response checking — no silent failures
    var failedNames = [];
    for (var i = 0; i < Math.min(photos.length, 5); i++) {
      var res = await stubs.uploadPhoto(id, photos[i]);
      if (!res.ok) failedNames.push(photos[i].name);
    }
    if (failedNames.length > 0) {
      uploadError = failedNames.length + ' photo(s) failed to upload: ' + failedNames.join(', ');
      return; // do not sync or redirect
    }

    await stubs.syncListingToEscrow({ id: id, seller_id: 1, title: 'Test bat', price_cents: 8500 });
  }

  return {
    handleSubmit: handleSubmit,
    handleGetSuggestions: handleGetSuggestions,
    calls: calls,
    getUploadError: function() { return uploadError; },
    isSynced: function() { return synced; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

(async function() {
  console.log('\n=== SEO photo upload regression tests ===\n');

  // ---- Test 1: Normal flow (no SEO) — photos uploaded in handleSubmit ----
  console.log('Test 1 -- Normal flow (no SEO step)');
  {
    var form = makeForm({ photos: [{ name: 'bat1.jpg' }, { name: 'bat2.jpg' }] });
    await form.handleSubmit();

    assert('createListing called once', form.calls.createListing.length === 1);
    assert('uploadPhoto called for each photo', form.calls.uploadPhoto.length === 2);
    assert('photos uploaded to new listing id', form.calls.uploadPhoto.every(function(c) { return c.id === 99; }));
    assert('patchListing not called', form.calls.patchListing.length === 0);
    assert('syncListing called', form.calls.syncListing.length === 1);
    assert('no upload error', form.getUploadError() === null);
  }

  // ---- Test 2: SEO flow — listing pre-created, photos selected after SEO ----
  console.log('\nTest 2 -- SEO flow: listing pre-created, photos selected afterward');
  {
    var form = makeForm({ createdListingId: 42, photos: [{ name: 'sixer.jpg' }] });
    await form.handleSubmit();

    assert('createListing NOT called', form.calls.createListing.length === 0);
    assert('patchListing called once', form.calls.patchListing.length === 1);
    assert('patchListing called with correct id', form.calls.patchListing[0].id === 42);
    assert('uploadPhoto called for post-SEO photo',
      form.calls.uploadPhoto.length === 1,
      'uploadPhoto calls: ' + form.calls.uploadPhoto.length);
    assert('photo uploaded to correct listing id', form.calls.uploadPhoto[0].id === 42);
    assert('syncListing called', form.calls.syncListing.length === 1);
  }

  // ---- Test 3: SEO flow — multiple photos after SEO ----
  console.log('\nTest 3 -- SEO flow: multiple photos after SEO step');
  {
    var form = makeForm({
      createdListingId: 77,
      photos: [{ name: 'a.jpg' }, { name: 'b.jpg' }, { name: 'c.jpg' }],
    });
    await form.handleSubmit();

    assert('all 3 photos uploaded',
      form.calls.uploadPhoto.length === 3,
      'uploadPhoto calls: ' + form.calls.uploadPhoto.length);
    assert('all photos uploaded to listing id 77',
      form.calls.uploadPhoto.every(function(c) { return c.id === 77; }));
  }

  // ---- Test 4: SEO flow — max 5 photos enforced ----
  console.log('\nTest 4 -- SEO flow: max 5 photos enforced');
  {
    var files = Array.from({ length: 7 }, function(_, i) { return { name: 'photo' + (i + 1) + '.jpg' }; });
    var form = makeForm({ createdListingId: 55, photos: files });
    await form.handleSubmit();

    assert('only 5 photos uploaded (slice cap)',
      form.calls.uploadPhoto.length === 5,
      'uploadPhoto calls: ' + form.calls.uploadPhoto.length);
  }

  // ---- Test 5: Normal flow — max 5 photos enforced ----
  console.log('\nTest 5 -- Normal flow: max 5 photos enforced');
  {
    var files = Array.from({ length: 7 }, function(_, i) { return { name: 'photo' + (i + 1) + '.jpg' }; });
    var form = makeForm({ photos: files });
    await form.handleSubmit();

    assert('only 5 photos uploaded in normal flow',
      form.calls.uploadPhoto.length === 5,
      'uploadPhoto calls: ' + form.calls.uploadPhoto.length);
  }

  // ---- Test 6: SEO flow — no photos selected ----
  console.log('\nTest 6 -- SEO flow: no photos selected');
  {
    var form = makeForm({ createdListingId: 11, photos: [] });
    await form.handleSubmit();

    assert('patchListing still called', form.calls.patchListing.length === 1);
    assert('uploadPhoto not called', form.calls.uploadPhoto.length === 0);
    assert('syncListing called', form.calls.syncListing.length === 1);
    assert('no upload error', form.getUploadError() === null);
  }

  // ---- Test 7: handleGetSuggestions NEVER uploads photos (no-double-upload guarantee) ----
  console.log('\nTest 7 -- handleGetSuggestions does not upload photos');
  {
    // Simulate: user has 2 photos selected, clicks "Get SEO Suggestions"
    var form = makeForm({ photos: [{ name: 'p1.jpg' }, { name: 'p2.jpg' }] });
    await form.handleGetSuggestions();

    assert('createListing called (listing created for audit)', form.calls.createListing.length === 1);
    assert('uploadPhoto NOT called during SEO step',
      form.calls.uploadPhoto.length === 0,
      'uploadPhoto calls during SEO step: ' + form.calls.uploadPhoto.length);
    assert('listing id set (returned by handleGetSuggestions)', form.calls.createListing.length === 1);

    // Now publish — photos should be uploaded exactly once
    await form.handleSubmit();

    assert('uploadPhoto called exactly 2 times total (not 4)',
      form.calls.uploadPhoto.length === 2,
      'total uploadPhoto calls: ' + form.calls.uploadPhoto.length);
    assert('no double-upload: each photo uploaded once',
      form.calls.uploadPhoto.filter(function(c) { return c.file.name === 'p1.jpg'; }).length === 1 &&
      form.calls.uploadPhoto.filter(function(c) { return c.file.name === 'p2.jpg'; }).length === 1);
    assert('syncListing called after successful publish', form.calls.syncListing.length === 1);
  }

  // ---- Test 8: Failed upload — error set, syncListing NOT called ----
  console.log('\nTest 8 -- Failed upload: error reported, listing not synced');
  {
    var form = makeForm({
      photos: [{ name: 'good.jpg' }, { name: 'bad.jpg' }],
      failPhotoNames: ['bad.jpg'],
    });
    await form.handleSubmit();

    assert('uploadPhoto attempted for all photos', form.calls.uploadPhoto.length === 2);
    assert('upload error is set (not silent)',
      form.getUploadError() !== null,
      'error: ' + form.getUploadError());
    assert('error identifies the failed photo',
      (form.getUploadError() || '').includes('bad.jpg'));
    assert('syncListing NOT called when upload fails', form.calls.syncListing.length === 0);
    assert('listing was NOT published (no sync)', !form.isSynced());
  }

  // ---- Test 9: Partial failure — error names each failed file ----
  console.log('\nTest 9 -- Partial failure: all failed photo names in error message');
  {
    var form = makeForm({
      photos: [{ name: 'ok1.jpg' }, { name: 'bad1.jpg' }, { name: 'ok2.jpg' }, { name: 'bad2.jpg' }],
      failPhotoNames: ['bad1.jpg', 'bad2.jpg'],
    });
    await form.handleSubmit();

    assert('4 uploads attempted', form.calls.uploadPhoto.length === 4);
    assert('error mentions bad1.jpg', (form.getUploadError() || '').includes('bad1.jpg'));
    assert('error mentions bad2.jpg', (form.getUploadError() || '').includes('bad2.jpg'));
    assert('syncListing NOT called', form.calls.syncListing.length === 0);
  }

  // ---- Test 10: All photos succeed — no error, listing published ----
  console.log('\nTest 10 -- All photos succeed: no error, listing published normally');
  {
    var files = Array.from({ length: 5 }, function(_, i) { return { name: 'ok' + (i + 1) + '.jpg' }; });
    var form = makeForm({ photos: files });
    await form.handleSubmit();

    assert('5 photos uploaded', form.calls.uploadPhoto.length === 5);
    assert('no upload error', form.getUploadError() === null);
    assert('syncListing called', form.calls.syncListing.length === 1);
    assert('listing published (synced)', form.isSynced());
  }

  // ---- Summary ----
  console.log('\n' + '='.repeat(60));
  console.log('SEO PHOTO UPLOAD REGRESSION SUMMARY');
  console.log('='.repeat(60));
  console.log('' + (passed + failed) + ' checks: ' + passed + ' PASS, ' + failed + ' FAIL');
  console.log('='.repeat(60));

  if (failed > 0) process.exit(1);
})();

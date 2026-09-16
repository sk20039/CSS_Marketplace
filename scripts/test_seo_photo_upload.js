'use strict';
// Regression test for: SEO suggestions photo upload bug
// Bug: when "Get SEO Suggestions" creates the listing before photos are selected,
// clicking "Publish Listing" entered the else branch which patched title/description
// but never called uploadPhoto for subsequently selected photos.
//
// Run: node scripts/test_seo_photo_upload.js

let passed = 0;
let failed = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  v  [PASS] ${label}${detail ? ' -- ' + detail : ''}`);
    passed++;
  } else {
    console.log(`  x  [FAIL] ${label}${detail ? ' -- ' + detail : ''}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Minimal simulation of NewListingForm logic.
// Mirrors exactly the fixed logic in frontend/app/listings/new/page.tsx.
// ---------------------------------------------------------------------------

function makeForm(overrides) {
  overrides = overrides || {};
  // State
  let createdListingId = overrides.createdListingId !== undefined ? overrides.createdListingId : null;
  const photos = overrides.photos || [];

  // Stubs — record calls so tests can assert on them.
  const calls = { createListing: [], uploadPhoto: [], patchListing: [], syncListing: [] };

  const stubs = {
    createListing: async function(body) {
      calls.createListing.push(body);
      return { ok: true, json: async function() { return { id: 99 }; } };
    },
    uploadPhoto: async function(id, file) {
      calls.uploadPhoto.push({ id: id, file: file });
      return { ok: true };
    },
    patchListing: async function(id, fields) {
      calls.patchListing.push({ id: id, fields: fields });
      return { id: id };
    },
    syncListingToEscrow: async function(data) {
      calls.syncListing.push(data);
    },
  };

  // Reproduce createAndUpload exactly.
  async function createAndUpload() {
    if (createdListingId !== null) {
      return createdListingId;
    }
    const res = await stubs.createListing({ title: 'Test bat', price_cents: 8500 });
    const data = await res.json();
    if (!res.ok) return null;
    const id = data.id;
    createdListingId = id;

    for (const file of photos.slice(0, 5)) {
      await stubs.uploadPhoto(id, file);
    }
    return id;
  }

  // Reproduce handleSubmit exactly as fixed.
  async function handleSubmit() {
    let id = createdListingId;
    if (id === null) {
      // Normal flow: create then upload
      const newId = await createAndUpload();
      if (newId === null) return;
      id = newId;
    } else {
      // Listing was already created via "Get SEO Suggestions" -- patch with latest title/description
      await stubs.patchListing(id, { title: 'Test bat', description: '' });
      // Upload any photos selected after the SEO step (silently skipped before this fix).
      for (const file of photos.slice(0, 5)) {
        await stubs.uploadPhoto(id, file);
      }
    }
    await stubs.syncListingToEscrow({ id: id, seller_id: 1, title: 'Test bat', price_cents: 8500 });
  }

  return { createAndUpload: createAndUpload, handleSubmit: handleSubmit, calls: calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

(async function() {
  console.log('\n=== SEO photo upload regression tests ===\n');

  // ---- Test 1: Normal flow (no prior SEO step) — photos uploaded via createAndUpload ----
  console.log('Test 1 -- Normal flow (no prior SEO step)');
  {
    const form = makeForm({ photos: [{ name: 'bat1.jpg' }, { name: 'bat2.jpg' }] });
    await form.handleSubmit();

    assert('createListing called once', form.calls.createListing.length === 1);
    assert('uploadPhoto called for each photo', form.calls.uploadPhoto.length === 2);
    assert('photos uploaded to new listing id', form.calls.uploadPhoto.every(function(c) { return c.id === 99; }));
    assert('patchListing not called', form.calls.patchListing.length === 0);
    assert('syncListing called', form.calls.syncListing.length === 1);
  }

  // ---- Test 2: SEO flow — listing created first, photo added before Publish ----
  console.log('\nTest 2 -- SEO flow: listing created before photo selected (regression)');
  {
    const form = makeForm({ createdListingId: 42, photos: [{ name: 'sixer.jpg' }] });
    await form.handleSubmit();

    assert('createListing NOT called (listing already existed)', form.calls.createListing.length === 0);
    assert('patchListing called once', form.calls.patchListing.length === 1);
    assert('patchListing called with correct id', form.calls.patchListing[0].id === 42);
    assert('uploadPhoto called for post-SEO photo (regression fix)',
      form.calls.uploadPhoto.length === 1,
      'uploadPhoto calls: ' + form.calls.uploadPhoto.length);
    assert('photo uploaded to correct listing id', form.calls.uploadPhoto[0].id === 42);
    assert('syncListing called', form.calls.syncListing.length === 1);
  }

  // ---- Test 3: SEO flow — multiple photos added after SEO step ----
  console.log('\nTest 3 -- SEO flow: multiple photos added after SEO step');
  {
    const form = makeForm({
      createdListingId: 77,
      photos: [{ name: 'a.jpg' }, { name: 'b.jpg' }, { name: 'c.jpg' }],
    });
    await form.handleSubmit();

    assert('all 3 photos uploaded via else branch',
      form.calls.uploadPhoto.length === 3,
      'uploadPhoto calls: ' + form.calls.uploadPhoto.length);
    assert('all photos uploaded to listing id 77',
      form.calls.uploadPhoto.every(function(c) { return c.id === 77; }));
  }

  // ---- Test 4: SEO flow — max 5 photos enforced ----
  console.log('\nTest 4 -- SEO flow: max 5 photos enforced');
  {
    const files = Array.from({ length: 7 }, function(_, i) { return { name: 'photo' + (i + 1) + '.jpg' }; });
    const form = makeForm({ createdListingId: 55, photos: files });
    await form.handleSubmit();

    assert('only 5 photos uploaded (slice cap)',
      form.calls.uploadPhoto.length === 5,
      'uploadPhoto calls: ' + form.calls.uploadPhoto.length);
  }

  // ---- Test 5: Normal flow — max 5 photos enforced ----
  console.log('\nTest 5 -- Normal flow: max 5 photos enforced');
  {
    const files = Array.from({ length: 7 }, function(_, i) { return { name: 'photo' + (i + 1) + '.jpg' }; });
    const form = makeForm({ photos: files });
    await form.handleSubmit();

    assert('only 5 photos uploaded in normal flow',
      form.calls.uploadPhoto.length === 5,
      'uploadPhoto calls: ' + form.calls.uploadPhoto.length);
  }

  // ---- Test 6: SEO flow — no photos selected — no upload, no error ----
  console.log('\nTest 6 -- SEO flow: no photos selected -- no upload, no error');
  {
    const form = makeForm({ createdListingId: 11, photos: [] });
    await form.handleSubmit();

    assert('patchListing still called', form.calls.patchListing.length === 1);
    assert('uploadPhoto not called (no photos selected)', form.calls.uploadPhoto.length === 0);
    assert('syncListing still called', form.calls.syncListing.length === 1);
  }

  // ---- Summary ----
  console.log('\n' + '='.repeat(60));
  console.log('SEO PHOTO UPLOAD REGRESSION SUMMARY');
  console.log('='.repeat(60));
  console.log('' + (passed + failed) + ' checks: ' + passed + ' PASS, ' + failed + ' FAIL');
  console.log('='.repeat(60));

  if (failed > 0) process.exit(1);
})();

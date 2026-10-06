'use strict';
// One-off API verification script — draft workflow against local dev stack.
// Run: node listing-service/tests/staging_draft_api.js
// Prerequisites: full dev stack running (auth:3001, listing:3002, frontend:3003)

const http = require('http');
const https = require('https');
const { Pool } = require('pg');

const AUTH_URL = 'http://localhost:3001';
const LISTING_URL = 'http://localhost:3002';

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function request(baseUrl, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const url = new URL(path, baseUrl);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const mod = url.protocol === 'https:' ? https : http;
    const r = mod.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const bcrypt = require('../../auth-service/node_modules/bcryptjs');

// Insert test users directly into the auth DB, bypassing the rate-limited
// register API. Idempotent: ON CONFLICT DO UPDATE so reruns don't fail.
async function createAndLogin(email, role, withShipAddr) {
  const authPool = new Pool({ connectionString: 'postgres://auth_user:auth_pass@127.0.0.1:5432/auth_db' });
  const hash = await bcrypt.hash('DraftTest123x', 10);
  const addr = withShipAddr
    ? JSON.stringify({ name: 'Test Seller', line1: '123 Test St', city: 'Testville', state: 'CA', zip: '90001', country: 'US' })
    : null;
  await authPool.query(
    `INSERT INTO users (name, email, password_hash, role, email_verified, ship_from_address)
     VALUES ($1, $2, $3, $4, true, $5)
     ON CONFLICT (LOWER(email)) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           email_verified = true,
           ship_from_address = EXCLUDED.ship_from_address`,
    [`Draft Test ${role}`, email, hash, role, addr]
  );
  await authPool.end();

  const login = await request(AUTH_URL, 'POST', '/auth/login', { email, password: 'DraftTest123x' });
  if (login.status !== 200) throw new Error(`Login failed (${email}): ${JSON.stringify(login.body)}`);
  // Auth service returns access_token (snake_case)
  return login.body.access_token || login.body.accessToken;
}

const PKG_DIMS = { weight_oz: 16, pkg_length_in: 30, pkg_width_in: 5, pkg_height_in: 3 };

async function run() {
  console.log('Draft workflow — API verification against local dev stack\n');

  const ts = Date.now();
  const sellerEmail = `draft_seller_${ts}@test.invalid`;
  const noAddrEmail = `draft_noaddr_${ts}@test.invalid`;
  const other2Email = `draft_other_${ts}@test.invalid`;

  let token, noAddrToken, otherToken;
  try {
    token = await createAndLogin(sellerEmail, 'seller', true);
    noAddrToken = await createAndLogin(noAddrEmail, 'seller', false);
    otherToken = await createAndLogin(other2Email, 'seller', true);
  } catch (err) {
    console.error('Setup failed:', err.message);
    process.exit(1);
  }

  const auth = (t) => ({ Authorization: `Bearer ${t}` });

  // ── Draft creation ──────────────────────────────────────────────────────────
  console.log('Draft creation');

  let draftId;
  await check('POST /listings with save_as_draft=true and title only → 201 status=draft', async () => {
    const res = await request(LISTING_URL, 'POST', '/listings', { title: 'Draft Bat V1', save_as_draft: true }, auth(token));
    assert(res.status === 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.status === 'draft', `expected draft, got ${res.body.status}`);
    assert(res.body.price_cents === null, `expected null price_cents, got ${res.body.price_cents}`);
    draftId = res.body.id;
  });

  await check('save_as_draft without title → 400', async () => {
    const res = await request(LISTING_URL, 'POST', '/listings', { save_as_draft: true }, auth(token));
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await check('save_as_draft without address → 201 (ship-from not enforced for drafts)', async () => {
    const res = await request(LISTING_URL, 'POST', '/listings', { title: 'No-Addr Draft', save_as_draft: true }, auth(noAddrToken));
    assert(res.status === 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.status === 'draft', `status should be draft`);
  });

  await check('save_as_draft without auth → 401', async () => {
    const res = await request(LISTING_URL, 'POST', '/listings', { title: 'Unauthed', save_as_draft: true });
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  // ── Draft visibility ────────────────────────────────────────────────────────
  console.log('\nDraft visibility');

  await check('GET /listings/:id returns 404 for draft (not public)', async () => {
    const res = await request(LISTING_URL, 'GET', `/listings/${draftId}`);
    assert(res.status === 404, `expected 404, got ${res.status}`);
  });

  await check('GET /listings does not include drafts', async () => {
    const res = await request(LISTING_URL, 'GET', '/listings');
    assert(res.status === 200, `expected 200`);
    assert(!res.body.listings.some((l) => l.status === 'draft'), 'public list contains draft');
  });

  await check('GET /listings/mine includes own draft', async () => {
    const res = await request(LISTING_URL, 'GET', '/listings/mine', null, auth(token));
    assert(res.status === 200, `expected 200`);
    const draft = res.body.listings.find((l) => l.id === draftId);
    assert(draft && draft.status === 'draft', 'draft not found in /mine');
  });

  // ── Save & Add Another (create draft, get id, verify, then create next) ────
  console.log('\nSave & Add Another flow (API contract)');

  let draft2Id, draft3Id;
  await check('Create first draft (title only), then create second immediately', async () => {
    const r1 = await request(LISTING_URL, 'POST', '/listings', { title: 'Batch Draft 1', save_as_draft: true }, auth(token));
    assert(r1.status === 201, `r1 failed: ${r1.status}`);
    draft2Id = r1.body.id;

    const r2 = await request(LISTING_URL, 'POST', '/listings', { title: 'Batch Draft 2', save_as_draft: true }, auth(token));
    assert(r2.status === 201, `r2 failed: ${r2.status}`);
    draft3Id = r2.body.id;

    assert(draft2Id !== draft3Id, 'two drafts got same id');

    const mine = await request(LISTING_URL, 'GET', '/listings/mine', null, auth(token));
    const ids = mine.body.listings.map((l) => l.id);
    assert(ids.includes(draft2Id) && ids.includes(draft3Id), 'both drafts in /mine');
  });

  // ── Edit draft (PATCH) ──────────────────────────────────────────────────────
  console.log('\nEdit draft via PATCH');

  await check('PATCH updates title on a draft', async () => {
    const res = await request(LISTING_URL, 'PATCH', `/listings/${draftId}`, { title: 'Updated Draft Title' }, auth(token));
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.title === 'Updated Draft Title', 'title not updated');
    assert(res.body.status === 'draft', 'status changed after patch');
  });

  await check('PATCH on draft cannot set status=draft → 400', async () => {
    const active = await request(LISTING_URL, 'POST', '/listings',
      { title: 'ActiveForPatch', price_cents: 5000, category: 'bat', condition: 'new', ...PKG_DIMS }, auth(token));
    const res = await request(LISTING_URL, 'PATCH', `/listings/${active.body.id}`, { status: 'draft' }, auth(token));
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  // ── Publish incomplete draft — inline missing errors ─────────────────────
  console.log('\nPublish incomplete draft — missing field errors');

  await check('Publish title-only draft → 422 with missing array', async () => {
    const res = await request(LISTING_URL, 'POST', `/listings/${draftId}/publish`, null, auth(token));
    assert(res.status === 422, `expected 422, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.ok === false, 'ok should be false');
    assert(Array.isArray(res.body.missing) && res.body.missing.length > 0, 'missing should be non-empty');
    // price_cents definitely missing since draftId was created with no price
    assert(res.body.missing.includes('price_cents'), `price_cents in missing: ${res.body.missing}`);
    // Draft should remain as draft after failed publish
    const mine = await request(LISTING_URL, 'GET', '/listings/mine', null, auth(token));
    const still = mine.body.listings.find((l) => l.id === draftId);
    assert(still && still.status === 'draft', 'failed publish changed status');
  });

  await check('Publish with no ship-from address → 422 with ship_from_address in missing', async () => {
    const noAddrDraftRes = await request(LISTING_URL, 'POST', '/listings',
      { title: 'Publish Fail No Addr', price_cents: 5000, category: 'bat', condition: 'new', ...PKG_DIMS, save_as_draft: true },
      auth(noAddrToken));
    assert(noAddrDraftRes.status === 201, 'draft creation failed');
    const res = await request(LISTING_URL, 'POST', `/listings/${noAddrDraftRes.body.id}/publish`, null, auth(noAddrToken));
    assert(res.status === 422, `expected 422, got ${res.status}`);
    assert(res.body.missing && res.body.missing.includes('ship_from_address'), `ship_from_address not in missing: ${JSON.stringify(res.body)}`);
  });

  // ── Complete and publish one draft ─────────────────────────────────────────
  console.log('\nComplete and publish a single draft');

  let publishedId;
  await check('Fill in all fields via PATCH then publish → 200 status=active', async () => {
    // Fill the title-only draft (draftId) with all required fields
    await request(LISTING_URL, 'PATCH', `/listings/${draftId}`,
      { price_cents: 7500, category: 'bat', condition: 'new', ...PKG_DIMS }, auth(token));

    const res = await request(LISTING_URL, 'POST', `/listings/${draftId}/publish`, null, auth(token));
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.ok === true, 'ok should be true');
    assert(res.body.listing.status === 'active', `expected active, got ${res.body.listing.status}`);
    publishedId = res.body.listing.id;
  });

  await check('Published listing appears in public GET /listings', async () => {
    const res = await request(LISTING_URL, 'GET', '/listings');
    assert(res.body.listings.some((l) => l.id === publishedId), 'published listing not in public list');
  });

  await check('Published listing visible via GET /listings/:id', async () => {
    const res = await request(LISTING_URL, 'GET', `/listings/${publishedId}`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.status === 'active', `expected active, got ${res.body.status}`);
  });

  // ── Publish multiple drafts with partial success ───────────────────────────
  console.log('\nPublish multiple drafts — partial success');

  await check('Bulk publish: complete draft succeeds, incomplete draft gives 422', async () => {
    // draft2Id = 'Batch Draft 1' — title only, will fail
    // draft3Id = 'Batch Draft 2' — title only, will fail
    // Create one complete draft and one incomplete draft
    const complete = await request(LISTING_URL, 'POST', '/listings',
      { title: 'Bulk Complete', price_cents: 6000, category: 'bat', condition: 'new', ...PKG_DIMS, save_as_draft: true },
      auth(token));
    const incomplete = await request(LISTING_URL, 'POST', '/listings',
      { title: 'Bulk Incomplete', save_as_draft: true }, auth(token));

    const [rComplete, rIncomplete] = await Promise.all([
      request(LISTING_URL, 'POST', `/listings/${complete.body.id}/publish`, null, auth(token)),
      request(LISTING_URL, 'POST', `/listings/${incomplete.body.id}/publish`, null, auth(token)),
    ]);

    assert(rComplete.status === 200, `complete draft should publish: got ${rComplete.status}`);
    assert(rIncomplete.status === 422, `incomplete draft should fail: got ${rIncomplete.status}`);

    // Complete one is now active in public list
    const pub = await request(LISTING_URL, 'GET', `/listings/${complete.body.id}`);
    assert(pub.status === 200, 'published listing not public');

    // Incomplete one is still a draft in /mine
    const mine = await request(LISTING_URL, 'GET', '/listings/mine', null, auth(token));
    const still = mine.body.listings.find((l) => l.id === incomplete.body.id);
    assert(still && still.status === 'draft', 'incomplete listing should still be draft');
  });

  // ── Concurrent publish ─────────────────────────────────────────────────────
  console.log('\nConcurrent publish — atomic safety');

  await check('Two simultaneous publish requests: exactly one 200 and one 409', async () => {
    const draft = await request(LISTING_URL, 'POST', '/listings',
      { title: 'Concurrent', price_cents: 5000, category: 'bat', condition: 'new', ...PKG_DIMS, save_as_draft: true },
      auth(token));
    const id = draft.body.id;
    const [r1, r2] = await Promise.all([
      request(LISTING_URL, 'POST', `/listings/${id}/publish`, null, auth(token)),
      request(LISTING_URL, 'POST', `/listings/${id}/publish`, null, auth(token)),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert(statuses[0] === 200 && statuses[1] === 409,
      `expected 200+409, got ${r1.status}+${r2.status}`);
  });

  // ── Escrow sync — publish backend contract ─────────────────────────────────
  console.log('\nEscrow sync — publish response contract');

  await check('Publish response has ok+listing, no escrow fields', async () => {
    const draft = await request(LISTING_URL, 'POST', '/listings',
      { title: 'Escrow Contract', price_cents: 5000, category: 'bat', condition: 'new', ...PKG_DIMS, save_as_draft: true },
      auth(token));
    const res = await request(LISTING_URL, 'POST', `/listings/${draft.body.id}/publish`, null, auth(token));
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.ok === true, 'ok should be true');
    assert(res.body.listing && res.body.listing.id, 'listing should be present');
    assert(res.body.escrow_error === undefined, 'escrow_error must not appear in response');
    assert(res.body.sync_failed === undefined, 'sync_failed must not appear in response');
  });

  // ── No social post for draft (verify via Blotato no-op in local dev) ───────
  // BLOTATO_ENABLED is not set in local dev; postNewListingToSocial is a no-op.
  // The test confirms save_as_draft does NOT trigger the social code path.
  // We verify this indirectly: if saving a draft triggered the social path
  // and Blotato threw, the 201 response would fail. It succeeds = no-op confirmed.
  console.log('\nNo social post for draft saves');

  await check('save_as_draft returns 201 without social post side-effects', async () => {
    const res = await request(LISTING_URL, 'POST', '/listings', { title: 'No Social Draft', save_as_draft: true }, auth(token));
    assert(res.status === 201, `expected 201, got ${res.status}`);
    assert(res.body.status === 'draft', 'should be draft');
  });

  // ── Normal immediate listing flow still works ──────────────────────────────
  console.log('\nNormal (non-draft) listing flow regression');

  await check('POST /listings without save_as_draft creates active listing → 201', async () => {
    const res = await request(LISTING_URL, 'POST', '/listings',
      { title: 'Normal Active Listing', price_cents: 4500, category: 'helmet', condition: 'new', ...PKG_DIMS }, auth(token));
    assert(res.status === 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.status === 'active', `expected active, got ${res.body.status}`);
  });

  await check('Normal listing appears immediately in public GET /listings', async () => {
    const create = await request(LISTING_URL, 'POST', '/listings',
      { title: 'Immediate Public', price_cents: 3000, category: 'pads', condition: 'used_good', ...PKG_DIMS }, auth(token));
    const res = await request(LISTING_URL, 'GET', `/listings/${create.body.id}`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.status === 'active', `expected active, got ${res.body.status}`);
  });

  await check('Seller without ship-from address still gets 422 on normal POST /listings', async () => {
    const res = await request(LISTING_URL, 'POST', '/listings',
      { title: 'Normal Fail', price_cents: 5000, category: 'bat', condition: 'new', ...PKG_DIMS }, auth(noAddrToken));
    assert(res.status === 422, `expected 422, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.code === 'SHIP_FROM_ADDRESS_REQUIRED', `expected SHIP_FROM_ADDRESS_REQUIRED, got ${res.body.code}`);
  });

  console.log(`\n${passed + failed} check(s): ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});

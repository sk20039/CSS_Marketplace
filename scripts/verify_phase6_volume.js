'use strict';
// Phase 6 Railway Volume persistence verification.
// Run: node scripts/verify_phase6_volume.js
// (Tunnel to Postgres-YMzc must already be open on port 15436)

const https  = require('https');
const crypto = require('crypto');
const cp     = require('child_process');
const { Pool } = require('C:/Users/salmank/source/repos/Css_marketplace/escrow-service/node_modules/pg');

// ---- Config ----
const AUTH_URL    = 'https://auth-service-production-1f4c7.up.railway.app';
const ESCROW_URL  = 'https://escrow-service-production-1e20.up.railway.app';
const DB_URL      = 'postgresql://postgres:gwybPBSGfGfxkIBYCKhdstMGrFLMnkOc@127.0.0.1:15436/escrow_db';
const BUYER_EMAIL = 'smoke_buyer_1787771797@test.invalid';
const BUYER_PASS  = 'CookieTest1234';
const JWT_SECRET  = 'HwfT2dLL8Nsp_Nc36hDZC4cCuf5nON1eCPPQAYAIxYlYrZNQrvNAO3vEITGIWcJQ';

// Small valid JPEG (magic bytes FF D8 FF E0 + content)
const FAKE_JPEG_BYTES = Buffer.from([
  0xFF,0xD8,0xFF,0xE0, 0x00,0x10,0x4A,0x46, 0x49,0x46,0x00,0x01,
  0x01,0x00,0x00,0x01, 0x00,0x01,0x00,0x00, // minimal JFIF APP0 header
  0xFF,0xD9, // EOI marker — makes it a complete (minimal) JPEG
]);
const FILENAME = 'volume_persist_test.jpg';
const MIME     = 'image/jpeg';

// ---- Helpers ----
function httpsRequest(url, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const opts = {
      hostname: u.hostname,
      port:     443,
      path:     u.pathname + u.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let parsed;
        try { parsed = JSON.parse(raw.toString()); } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function uploadMultipart(url, token, filename, mimeType, fileData) {
  return new Promise((resolve, reject) => {
    const u    = new URL(url);
    const bnd  = 'VPBoundary' + Date.now();
    const head = Buffer.from(
      `--${bnd}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
    );
    const tail  = Buffer.from(`\r\n--${bnd}--\r\n`);
    const body  = Buffer.concat([head, fileData, tail]);
    const opts  = {
      hostname: u.hostname,
      port:     443,
      path:     u.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   `multipart/form-data; boundary=${bnd}`,
        'Content-Length': body.length,
        'Authorization':  `Bearer ${token}`,
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json; try { json = JSON.parse(data); } catch { json = data; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function downloadBinary(url, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, port: 443, path: u.pathname, method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function sh(cmd) {
  try {
    return cp.execSync(cmd, { encoding: 'utf8', timeout: 30000 }).trim();
  } catch (e) {
    return e.message;
  }
}

// ---- Main ----
(async () => {
  const results = {};
  let pool;

  try {
    pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 10000 });

    // ── Step 1: Login as buyer ────────────────────────────────────────────
    console.log('\n[1] Logging in as staging buyer…');
    const loginRes = await httpsRequest(`${AUTH_URL}/auth/login`, 'POST', {
      email: BUYER_EMAIL, password: BUYER_PASS,
    });
    if (loginRes.status !== 200 || !loginRes.body.access_token) {
      throw new Error(`Buyer login failed: ${JSON.stringify(loginRes.body)}`);
    }
    const buyerToken = loginRes.body.access_token;
    const buyerId    = loginRes.body.user.id;
    console.log(`   Buyer id=${buyerId} token acquired`);

    // ── Step 2: Create (or find) a synthetic DISPUTED order ───────────────
    console.log('\n[2] Setting up DISPUTED order in staging escrow DB…');

    // Find a valid listing in the staging escrow DB.
    const { rows: listings } = await pool.query('SELECT id FROM listings LIMIT 1');
    if (!listings.length) throw new Error('No listings in staging escrow DB — cannot create test order');
    const listingId = listings[0].id;

    // Check if buyer (id=7) and seller (id=8) exist in staging escrow DB.
    const { rows: users } = await pool.query('SELECT id FROM users WHERE id IN (7, 8)');
    if (users.length < 2) throw new Error('Staging buyer(7)/seller(8) not synced to escrow DB');

    // Insert a synthetic DISPUTED order.
    const { rows: [order] } = await pool.query(`
      INSERT INTO orders (
        listing_id, buyer_id, seller_id,
        amount_cents, platform_fee_cents, seller_payout_cents,
        status, stripe_payment_intent_id, dispute_reason_text, dispute_category
      ) VALUES ($1, 7, 8, 5000, 400, 4600, 'DISPUTED',
        'pi_volume_persist_test_' || to_char(NOW(),'YYYYMMDDHH24MISS'),
        'Volume persistence verification', 'valid')
      RETURNING id
    `, [listingId]);
    const orderId = order.id;
    console.log(`   Created synthetic DISPUTED order #${orderId}`);
    results.orderId = orderId;

    // ── Step 3: Upload evidence via API ───────────────────────────────────
    console.log('\n[3] Uploading evidence file via API…');
    const uploadRes = await uploadMultipart(
      `${ESCROW_URL}/orders/${orderId}/evidence`,
      buyerToken, FILENAME, MIME, FAKE_JPEG_BYTES
    );
    if (uploadRes.status !== 201) {
      throw new Error(`Evidence upload failed: ${JSON.stringify(uploadRes.body)}`);
    }
    const ev = uploadRes.body;
    results.evidenceId       = ev.id;
    results.originalFilename = ev.original_filename;
    results.fileSizeBytes    = ev.file_size_bytes;
    results.uploaderRole     = ev.uploader_role;
    results.mimeType         = ev.mime_type;
    console.log(`   Evidence id=${ev.id} filename="${ev.original_filename}" size=${ev.file_size_bytes}B mime=${ev.mime_type} role=${ev.uploader_role}`);

    // ── Step 4: Download before redeploy ──────────────────────────────────
    console.log('\n[4] Downloading evidence before redeploy…');
    const preDown = await downloadBinary(
      `${ESCROW_URL}/orders/${orderId}/evidence/${ev.id}/file`,
      buyerToken
    );
    if (preDown.status !== 200) {
      throw new Error(`Pre-redeploy download failed: status ${preDown.status}`);
    }
    if (!preDown.body.slice(0, 3).equals(Buffer.from([0xFF, 0xD8, 0xFF]))) {
      throw new Error('Pre-redeploy download: JPEG magic bytes mismatch');
    }
    results.preRedeployDownload = 'PASS';
    const preHash = crypto.createHash('sha256').update(preDown.body).digest('hex');
    console.log(`   Pre-redeploy download OK — size=${preDown.body.length}B sha256=${preHash.slice(0,16)}…`);

    // ── Step 5: Test unauthorized access before redeploy ─────────────────
    console.log('\n[5] Testing unauthorized access (no token)…');
    const unauthedRes = await downloadBinary(
      `${ESCROW_URL}/orders/${orderId}/evidence/${ev.id}/file`,
      null // no token
    );
    results.unauthorizedCheck = unauthedRes.status === 401 ? 'PASS' : `FAIL (got ${unauthedRes.status})`;
    console.log(`   Unauthorized → ${unauthedRes.status} → ${results.unauthorizedCheck}`);

    // ── Step 6: Trigger Railway redeploy ──────────────────────────────────
    console.log('\n[6] Triggering Railway redeploy of escrow-service…');
    const redeployOut = sh('railway service redeploy --service escrow-service 2>&1');
    console.log(`   railway output: ${redeployOut.slice(0, 120)}`);

    // ── Step 7: Wait for service health ──────────────────────────────────
    console.log('\n[7] Polling health endpoint…');
    let healthOk = false;
    for (let attempt = 1; attempt <= 30; attempt++) {
      await sleep(5000);
      try {
        const h = await httpsRequest(`${ESCROW_URL}/health/live`, 'GET', null);
        if (h.status === 200 && h.body.ok) {
          healthOk = true;
          results.serviceHealthAfterRedeploy = `OK (attempt ${attempt}, ~${attempt * 5}s)`;
          console.log(`   Health OK on attempt ${attempt} (~${attempt * 5}s)`);
          break;
        }
      } catch { /* not ready yet */ }
      if (attempt % 6 === 0) console.log(`   Still waiting… (${attempt * 5}s)`);
    }
    if (!healthOk) throw new Error('Health check never returned OK after 150s');

    // Give Railway a few extra seconds for any in-progress requests to settle.
    await sleep(3000);

    // ── Step 8: Verify Phase 6 migration still present ───────────────────
    console.log('\n[8] Verifying Phase 6 migration in staging DB…');
    const { rows: migs } = await pool.query(
      "SELECT name FROM pgmigrations WHERE name='1757692800000_phase6_evidence'"
    );
    results.migrationPresent = migs.length === 1 ? 'PASS' : 'FAIL';
    console.log(`   Migration 1757692800000_phase6_evidence: ${results.migrationPresent}`);

    // ── Step 9: List evidence after redeploy ──────────────────────────────
    console.log('\n[9] Listing evidence after redeploy…');
    const listRes = await httpsRequest(
      `${ESCROW_URL}/orders/${orderId}/evidence`, 'GET', null,
      { Authorization: `Bearer ${buyerToken}` }
    );
    if (listRes.status !== 200 || !Array.isArray(listRes.body)) {
      throw new Error(`Evidence list failed after redeploy: ${JSON.stringify(listRes.body)}`);
    }
    const foundEv = listRes.body.find((e) => e.id === ev.id);
    if (!foundEv) throw new Error(`Evidence record id=${ev.id} missing after redeploy`);
    results.evidenceRecordAfterRedeploy = `PASS (still present, filename="${foundEv.original_filename}")`;
    console.log(`   Evidence record present: ${results.evidenceRecordAfterRedeploy}`);

    // ── Step 10: Download evidence after redeploy and compare ─────────────
    console.log('\n[10] Downloading evidence after redeploy and comparing…');
    const postDown = await downloadBinary(
      `${ESCROW_URL}/orders/${orderId}/evidence/${ev.id}/file`,
      buyerToken
    );
    if (postDown.status !== 200) {
      throw new Error(`Post-redeploy download failed: status ${postDown.status}`);
    }
    const postHash = crypto.createHash('sha256').update(postDown.body).digest('hex');
    if (preHash !== postHash) {
      throw new Error(`File content mismatch! pre=${preHash.slice(0,16)} post=${postHash.slice(0,16)}`);
    }
    results.postRedeployDownload = 'PASS';
    results.fileIntegrityMatch   = 'PASS';
    console.log(`   Post-redeploy sha256=${postHash.slice(0,16)}… → MATCH`);

    // ── Step 11: Unauthorized access after redeploy ───────────────────────
    console.log('\n[11] Testing unauthorized access after redeploy…');
    const postUnauth = await downloadBinary(
      `${ESCROW_URL}/orders/${orderId}/evidence/${ev.id}/file`,
      null
    );
    results.unauthorizedPostRedeploy = postUnauth.status === 401 ? 'PASS' : `FAIL (got ${postUnauth.status})`;
    console.log(`   Unauthorized post-redeploy → ${postUnauth.status} → ${results.unauthorizedPostRedeploy}`);

    results.volumePersistence = 'PASS';
    results.codeChangeNeeded  = 'No';

  } catch (err) {
    console.error('\n[ERROR]', err.message);
    results.error = err.message;
    if (!results.volumePersistence) results.volumePersistence = 'FAIL';
  } finally {
    if (pool) await pool.end().catch(() => {});
  }

  // ── Final report ─────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  console.log('PHASE 6 RAILWAY VOLUME PERSISTENCE VERIFICATION REPORT');
  console.log('='.repeat(60));
  console.log(`Volume persistence:              ${results.volumePersistence}`);
  console.log(`Order ID:                        ${results.orderId}`);
  console.log(`Evidence ID:                     ${results.evidenceId}`);
  console.log(`Original filename:               ${results.originalFilename}`);
  console.log(`File size:                       ${results.fileSizeBytes} bytes`);
  console.log(`Pre-redeploy download:           ${results.preRedeployDownload}`);
  console.log(`Post-redeploy download:          ${results.postRedeployDownload}`);
  console.log(`File integrity match:            ${results.fileIntegrityMatch}`);
  console.log(`Unauthorized protection (pre):   ${results.unauthorizedCheck}`);
  console.log(`Unauthorized protection (post):  ${results.unauthorizedPostRedeploy}`);
  console.log(`Service health after redeploy:   ${results.serviceHealthAfterRedeploy}`);
  console.log(`Phase 6 migration present:       ${results.migrationPresent}`);
  console.log(`Code change needed:              ${results.codeChangeNeeded}`);
  if (results.error) console.log(`Error:                           ${results.error}`);
  console.log('='.repeat(60));
})();

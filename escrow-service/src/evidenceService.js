'use strict';

const fs   = require('fs');
const path = require('path');
const pool = require('./db');
const { OrderError } = require('./orderService');

const EVIDENCE_DIR = process.env.EVIDENCE_DIR
  ? path.resolve(process.env.EVIDENCE_DIR)
  : path.join(__dirname, '..', 'data', 'evidence');

// Ensure the directory exists when the module loads.
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

const MAX_FILES_PER_ROLE = 5;
const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

// Detect MIME type from the first 12 bytes of the file.
// Returns the detected MIME string or null if unrecognised.
function detectMimeFromBytes(buf) {
  if (buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  // PDF: 25 50 44 46 (%PDF)
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
  // WEBP: RIFF????WEBP (bytes 0-3 = RIFF, bytes 8-11 = WEBP)
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return 'image/webp';
  }
  return null;
}

async function getOrderParties(orderId) {
  const { rows } = await pool.query(
    'SELECT id, status, buyer_id, seller_id FROM orders WHERE id = $1',
    [orderId]
  );
  if (!rows[0]) throw new OrderError(`Order ${orderId} not found`, 404);
  return rows[0];
}

/**
 * Called after multer has saved the uploaded file to disk.
 * Validates order status, caller authorization, per-role file count limit,
 * and magic-byte MIME type. Inserts a dispute_evidence record and returns it.
 *
 * @param {string|number} orderId
 * @param {object} file         - multer file object (path, filename, originalname, size)
 * @param {string|number} uploaderId
 * @param {'buyer'|'seller'} uploaderRole
 */
async function registerUploadedFile(orderId, file, uploaderId, uploaderRole) {
  const order = await getOrderParties(orderId);

  if (order.status !== 'DISPUTED') {
    fs.unlink(file.path, () => {});
    throw new OrderError(`Order ${orderId} is not in DISPUTED status`, 409);
  }
  if (uploaderRole === 'buyer' && String(order.buyer_id) !== String(uploaderId)) {
    fs.unlink(file.path, () => {});
    throw new OrderError('Forbidden: only the buyer can upload buyer evidence', 403);
  }
  if (uploaderRole === 'seller' && String(order.seller_id) !== String(uploaderId)) {
    fs.unlink(file.path, () => {});
    throw new OrderError('Forbidden: only the seller can upload seller evidence', 403);
  }

  // Check per-role file count limit.
  const { rows: countRows } = await pool.query(
    'SELECT COUNT(*) AS cnt FROM dispute_evidence WHERE order_id = $1 AND uploader_role = $2',
    [orderId, uploaderRole]
  );
  if (parseInt(countRows[0].cnt, 10) >= MAX_FILES_PER_ROLE) {
    fs.unlink(file.path, () => {});
    throw new OrderError(`Maximum ${MAX_FILES_PER_ROLE} files per role already uploaded`, 409);
  }

  // Magic-byte validation — read first 12 bytes of the saved file.
  let header;
  try {
    const fd = fs.openSync(file.path, 'r');
    header = Buffer.alloc(12);
    fs.readSync(fd, header, 0, 12, 0);
    fs.closeSync(fd);
  } catch {
    fs.unlink(file.path, () => {});
    throw new OrderError('Failed to read uploaded file', 500);
  }

  const detected = detectMimeFromBytes(header);
  if (!detected || !ALLOWED_MIMES.has(detected)) {
    fs.unlink(file.path, () => {});
    throw new OrderError('File type not allowed. Upload JPG, PNG, WEBP, or PDF only.', 422);
  }

  // Use the magic-byte-detected MIME (not client-declared) in the DB record.
  const storageKey = file.filename; // UUID-based name set by multer diskStorage
  const { rows } = await pool.query(
    `INSERT INTO dispute_evidence
       (order_id, uploader_user_id, uploader_role, storage_key, original_filename, mime_type, file_size_bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [orderId, uploaderId, uploaderRole, storageKey, file.originalname, detected, file.size]
  );
  const ev = rows[0];
  return {
    ...ev,
    created_at: ev.created_at instanceof Date ? ev.created_at.toISOString() : ev.created_at,
  };
}

/**
 * List all evidence for a dispute order.
 * Both buyer, seller, and admin can see all evidence (P2 MODIFIED).
 */
async function listEvidence(orderId, requesterId, requesterRole) {
  const order = await getOrderParties(orderId);
  if (requesterRole !== 'admin' &&
      String(order.buyer_id) !== String(requesterId) &&
      String(order.seller_id) !== String(requesterId)) {
    throw new OrderError('Forbidden', 403);
  }
  const { rows } = await pool.query(
    `SELECT de.id, de.order_id, de.uploader_user_id, de.uploader_role,
            de.original_filename, de.mime_type, de.file_size_bytes, de.created_at,
            u.name AS uploader_name
     FROM dispute_evidence de
     JOIN users u ON u.id = de.uploader_user_id
     WHERE de.order_id = $1
     ORDER BY de.created_at ASC`,
    [orderId]
  );
  return rows.map((r) => ({
    ...r,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  }));
}

/**
 * Resolve an evidence record to its absolute file path after authorization check.
 * Returns { filePath, mimeType, originalFilename }.
 */
async function getEvidenceFilePath(orderId, evidenceId, requesterId, requesterRole) {
  const order = await getOrderParties(orderId);
  if (requesterRole !== 'admin' &&
      String(order.buyer_id) !== String(requesterId) &&
      String(order.seller_id) !== String(requesterId)) {
    throw new OrderError('Forbidden', 403);
  }
  const { rows } = await pool.query(
    'SELECT id, order_id, storage_key, original_filename, mime_type FROM dispute_evidence WHERE id = $1 AND order_id = $2',
    [evidenceId, orderId]
  );
  if (!rows[0]) throw new OrderError('Evidence not found', 404);
  const ev = rows[0];
  const filePath = path.join(EVIDENCE_DIR, ev.storage_key);
  if (!fs.existsSync(filePath)) throw new OrderError('File not found on disk', 404);
  return { filePath, mimeType: ev.mime_type, originalFilename: ev.original_filename };
}

/**
 * Submit seller's formal response to a dispute (one per dispute, immutable).
 */
async function submitSellerResponse(orderId, body, sellerId) {
  const order = await getOrderParties(orderId);
  if (order.status !== 'DISPUTED') {
    throw new OrderError(`Order ${orderId} is not in DISPUTED status`, 409);
  }
  if (String(order.seller_id) !== String(sellerId)) {
    throw new OrderError('Forbidden: only the seller can submit a response', 403);
  }
  const trimmed = body != null ? String(body).trim() : '';
  if (!trimmed) throw new OrderError('Response body is required', 400);
  if (trimmed.length > 5000) throw new OrderError('Response must not exceed 5,000 characters', 400);

  try {
    const { rows } = await pool.query(
      `INSERT INTO dispute_responses (order_id, seller_id, body) VALUES ($1, $2, $3) RETURNING *`,
      [orderId, sellerId, trimmed]
    );
    const r = rows[0];
    return { ...r, created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at };
  } catch (err) {
    if (err.code === '23505') {
      throw new OrderError('A response has already been submitted for this dispute', 409);
    }
    throw err;
  }
}

/**
 * Get the seller's formal response for a dispute, or null if none submitted yet.
 */
async function getSellerResponse(orderId, requesterId, requesterRole) {
  const order = await getOrderParties(orderId);
  if (requesterRole !== 'admin' &&
      String(order.buyer_id) !== String(requesterId) &&
      String(order.seller_id) !== String(requesterId)) {
    throw new OrderError('Forbidden', 403);
  }
  const { rows } = await pool.query(
    'SELECT * FROM dispute_responses WHERE order_id = $1',
    [orderId]
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return { ...r, created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at };
}

module.exports = {
  EVIDENCE_DIR,
  MAX_FILES_PER_ROLE,
  registerUploadedFile,
  listEvidence,
  getEvidenceFilePath,
  submitSellerResponse,
  getSellerResponse,
};

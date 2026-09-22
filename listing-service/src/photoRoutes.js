const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pool = require('./db');
const requireAuth = require('./middleware/requireAuth');

const router = express.Router();

const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(__dirname, '..', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_PHOTOS = 5;
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

// Detect image MIME type from the first 12 bytes of the file.
// Returns the detected MIME string or null if unrecognised.
// Pattern mirrors Phase 6 evidenceService magic-byte detection.
function detectImageMime(buf) {
  if (buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  // WebP: RIFF????WEBP (bytes 0-3 = RIFF, bytes 8-11 = WEBP)
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return 'image/webp';
  }
  return null;
}

function validatePhotoSignature(filePath) {
  let header;
  try {
    const fd = fs.openSync(filePath, 'r');
    header = Buffer.alloc(12);
    fs.readSync(fd, header, 0, 12, 0);
    fs.closeSync(fd);
  } catch {
    return null;
  }
  return detectImageMime(header);
}

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename(req, file, cb) {
    const listingId = req.params.id;
    const ts = Date.now();
    const sanitized = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    cb(null, `${listingId}_${ts}_${sanitized}`);
  },
});

const upload = multer({
  storage,
  // busboy fires LIMIT_FILE_SIZE when bytes >= limit, so set limit to MAX_FILE_SIZE + 1
  // to ensure a file of exactly MAX_FILE_SIZE bytes is accepted.
  limits: { fileSize: MAX_FILE_SIZE + 1 },
  fileFilter(req, file, cb) {
    if (ALLOWED_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(Object.assign(new Error('Only JPEG, PNG, and WebP images are allowed'), { statusCode: 400 }));
    }
  },
});

// POST /listings/:id/photos
router.post('/listings/:id/photos', requireAuth, async (req, res, next) => {
  try {
    const { rows: listingRows } = await pool.query(
      'SELECT * FROM listings WHERE id = $1',
      [req.params.id]
    );
    const listing = listingRows[0];
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    if (String(listing.seller_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Forbidden: not your listing' });
    }

    const { rows: countRows } = await pool.query(
      'SELECT COUNT(*) AS c FROM listing_photos WHERE listing_id = $1',
      [listing.id]
    );
    const currentCount = parseInt(countRows[0].c, 10);
    if (currentCount >= MAX_PHOTOS) {
      return res.status(400).json({ error: `Maximum ${MAX_PHOTOS} photos per listing` });
    }

    await new Promise((resolve, reject) => {
      upload.single('photo')(req, res, (err) => {
        if (err) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            err.statusCode = 413;
            err.message = 'Each photo must be 5 MB or smaller.';
          }
          reject(err);
        } else resolve();
      });
    });

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Magic-byte validation — do not trust browser-supplied mimetype alone.
    const detectedMime = validatePhotoSignature(req.file.path);
    if (!detectedMime || !ALLOWED_MIME.has(detectedMime)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'File content does not match an allowed image type (JPEG, PNG, or WebP)' });
    }

    const displayOrder = currentCount;
    const { rows: photoRows } = await pool.query(
      'INSERT INTO listing_photos (listing_id, filename, display_order) VALUES ($1, $2, $3) RETURNING id',
      [listing.id, req.file.filename, displayOrder]
    );

    res.status(201).json({
      id: photoRows[0].id,
      listing_id: listing.id,
      filename: req.file.filename,
      display_order: displayOrder,
      url: `/photos/${req.file.filename}`,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /listings/:id/photos/:photoId — remove a single photo from a listing.
//
// Deletion order is DB-first to preserve consistency:
//   1. Delete the DB record — if this fails, the file is untouched (safe).
//   2. Delete the file from disk — if this fails (e.g. already gone), the DB
//      record is already removed so there is nothing left to point to a
//      missing file. ENOENT is silently ignored.
router.delete('/listings/:id/photos/:photoId', requireAuth, async (req, res, next) => {
  try {
    const { rows: listingRows } = await pool.query(
      'SELECT * FROM listings WHERE id = $1',
      [req.params.id]
    );
    const listing = listingRows[0];
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    if (String(listing.seller_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Forbidden: not your listing' });
    }

    const { rows: photoRows } = await pool.query(
      'SELECT * FROM listing_photos WHERE id = $1 AND listing_id = $2',
      [req.params.photoId, listing.id]
    );
    const photo = photoRows[0];
    if (!photo) return res.status(404).json({ error: 'Photo not found' });

    // Step 1: Remove DB record first (if this throws, file is untouched).
    await pool.query('DELETE FROM listing_photos WHERE id = $1', [photo.id]);

    // Step 2: Remove file from disk. ENOENT means the file was already gone —
    // that is safe since the DB record is already deleted.
    const filePath = path.join(UPLOADS_DIR, path.basename(photo.filename));
    fs.unlink(filePath, (err) => {
      if (err && err.code !== 'ENOENT') {
        console.error(`[photoRoutes] Failed to delete file ${filePath}:`, err.message);
      }
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /photos/:filename
router.get('/photos/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // prevent path traversal
  const filePath = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Photo not found' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(filePath);
});

module.exports = { photoRouter: router, uploadsDir: UPLOADS_DIR };

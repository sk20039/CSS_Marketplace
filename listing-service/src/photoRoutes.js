const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('./db');
const requireAuth = require('./middleware/requireAuth');

const router = express.Router();

const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(__dirname, '..', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_PHOTOS = 5;
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

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
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter(req, file, cb) {
    if (ALLOWED_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(Object.assign(new Error('Only JPEG, PNG, and WebP images are allowed'), { statusCode: 400 }));
    }
  },
});

// POST /listings/:id/photos
router.post('/:id/photos', requireAuth, (req, res, next) => {
  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Listing not found' });
  if (String(listing.seller_id) !== String(req.user.id)) {
    return res.status(403).json({ error: 'Forbidden: not your listing' });
  }

  const currentCount = db.prepare('SELECT COUNT(*) AS c FROM listing_photos WHERE listing_id = ?').get(listing.id).c;
  if (currentCount >= MAX_PHOTOS) {
    return res.status(400).json({ error: `Maximum ${MAX_PHOTOS} photos per listing` });
  }

  upload.single('photo')(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const displayOrder = currentCount;
    const result = db.prepare(
      "INSERT INTO listing_photos (listing_id, filename, display_order, created_at) VALUES (?, ?, ?, datetime('now'))"
    ).run(listing.id, req.file.filename, displayOrder);

    res.status(201).json({
      id: result.lastInsertRowid,
      listing_id: listing.id,
      filename: req.file.filename,
      display_order: displayOrder,
      url: `/photos/${req.file.filename}`,
    });
  });
});

// GET /photos/:filename
router.get('/photos/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // prevent path traversal
  const filePath = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Photo not found' });
  res.sendFile(filePath);
});

module.exports = { photoRouter: router, uploadsDir: UPLOADS_DIR };

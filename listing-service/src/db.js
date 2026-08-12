const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'listing.sqlite3');

const DATA_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('bat','helmet','pads','gloves','kit-bag','other')) DEFAULT 'other',
  condition TEXT NOT NULL CHECK(condition IN ('new','used_good','used_fair')) DEFAULT 'used_good',
  status TEXT NOT NULL CHECK(status IN ('active','sold','inactive')) DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_seller ON listings(seller_id);

CREATE TABLE IF NOT EXISTS listing_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Migrations — add SEO/quality columns introduced after initial schema.
// SQLite does not support "ADD COLUMN IF NOT EXISTS", so each ALTER is wrapped
// in a try/catch and the SQLITE_ERROR for duplicate column is silently ignored.
const seoMigrations = [
  "ALTER TABLE listings ADD COLUMN meta_title TEXT",
  "ALTER TABLE listings ADD COLUMN meta_description TEXT",
  "ALTER TABLE listings ADD COLUMN tags TEXT",
  "ALTER TABLE listings ADD COLUMN quality_score INTEGER",
];
for (const sql of seoMigrations) {
  try { db.exec(sql); } catch { /* column already exists — safe to ignore */ }
}

module.exports = db;

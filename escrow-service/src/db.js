// SQLite persistence layer (better-sqlite3 - synchronous, zero external DB server).
// Architect's note (build plan, Assumptions): SQLite chosen for this pass instead of
// Postgres for zero-setup local/sandbox testability. Schema uses portable SQL types
// so a future migration to Postgres is straightforward.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'escrow.sqlite3');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK(role IN ('buyer','seller','admin')),
  stripe_account_id TEXT
);

CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  price_cents INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  seller_id INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  platform_fee_cents INTEGER NOT NULL,
  seller_payout_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'CREATED','CAPTURING','HELD','SHIPPED','DELIVERED','DISPUTED',
    'RELEASING','REFUNDING','RELEASED','REFUNDED'
  )),
  stripe_payment_intent_id TEXT,
  stripe_transfer_id TEXT,
  stripe_refund_id TEXT,
  shipped_at TEXT,
  delivered_at TEXT,
  window_expires_at TEXT,
  dispute_reason_text TEXT,
  dispute_category TEXT CHECK(dispute_category IN ('valid','invalid','uncategorized') OR dispute_category IS NULL),
  dispute_resolution TEXT CHECK(dispute_resolution IN ('release','refund') OR dispute_resolution IS NULL),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  event_type TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  reviewer_id INTEGER NOT NULL REFERENCES users(id),
  reviewee_id INTEGER NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  body TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(order_id, reviewer_id)
);
`);

// Migration: add CANCELLING and CANCELLED to orders.status CHECK constraint.
// SQLite doesn't allow ALTER COLUMN, so we use the standard 12-step rename+recreate.
{
  const info = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'").get();
  if (info && !info.sql.includes('CANCELLING')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE orders_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        listing_id INTEGER NOT NULL REFERENCES listings(id),
        buyer_id INTEGER NOT NULL REFERENCES users(id),
        seller_id INTEGER NOT NULL REFERENCES users(id),
        amount_cents INTEGER NOT NULL,
        platform_fee_cents INTEGER NOT NULL,
        seller_payout_cents INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'CREATED','CAPTURING','HELD','SHIPPED','DELIVERED','DISPUTED',
          'RELEASING','REFUNDING','RELEASED','REFUNDED','CANCELLING','CANCELLED'
        )),
        stripe_payment_intent_id TEXT,
        stripe_transfer_id TEXT,
        stripe_refund_id TEXT,
        shipped_at TEXT,
        delivered_at TEXT,
        window_expires_at TEXT,
        dispute_reason_text TEXT,
        dispute_category TEXT CHECK(dispute_category IN ('valid','invalid','uncategorized') OR dispute_category IS NULL),
        dispute_resolution TEXT CHECK(dispute_resolution IN ('release','refund') OR dispute_resolution IS NULL),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO orders_v2 SELECT * FROM orders;
      DROP TABLE orders;
      ALTER TABLE orders_v2 RENAME TO orders;
    `);
    db.pragma('foreign_keys = ON');
    console.log('[db] Migrated orders table: added CANCELLING/CANCELLED statuses');
  }
}

// Migration: add stripe_client_secret column (simple ALTER TABLE — safe to add columns in SQLite)
{
  const info = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'").get();
  if (info && !info.sql.includes('stripe_client_secret')) {
    db.exec('ALTER TABLE orders ADD COLUMN stripe_client_secret TEXT');
    console.log('[db] Migrated orders table: added stripe_client_secret column');
  }
}

// Migration: add cancellation_reason column. SQLite does not support
// ALTER TABLE ... ADD COLUMN IF NOT EXISTS, so we check pragma table_info first.
{
  const columns = db.prepare("PRAGMA table_info(orders)").all();
  const hasCancellationReason = columns.some(col => col.name === 'cancellation_reason');
  if (!hasCancellationReason) {
    db.exec('ALTER TABLE orders ADD COLUMN cancellation_reason TEXT');
    console.log('[db] Migrated orders table: added cancellation_reason column');
  }
}

// Migration: add stripe_charge_id column.
// Nullable so pre-existing orders (captured before this migration) remain valid.
// After this migration, captureOrder writes the ch_... charge ID here so
// performRelease can use it as source_transaction on the seller transfer.
{
  const columns = db.prepare("PRAGMA table_info(orders)").all();
  if (!columns.some(col => col.name === 'stripe_charge_id')) {
    db.exec('ALTER TABLE orders ADD COLUMN stripe_charge_id TEXT');
    console.log('[db] Migrated orders table: added stripe_charge_id column');
  }
}

function seed() {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount > 0) return; // already seeded

  const insertUser = db.prepare(
    'INSERT INTO users (name, email, role, stripe_account_id) VALUES (?, ?, ?, ?)'
  );
  const buyer = insertUser.run('Amir Buyer', 'buyer@demo.test', 'buyer', null);
  const seller = insertUser.run(
    'Sara Seller',
    'seller@demo.test',
    'seller',
    'acct_stub_seller_1' // stand-in Stripe Connect account id for demo/stub mode
  );
  insertUser.run('Admin User', 'admin@demo.test', 'admin', null);

  const insertListing = db.prepare(
    'INSERT INTO listings (seller_id, title, price_cents) VALUES (?, ?, ?)'
  );
  insertListing.run(
    seller.lastInsertRowid,
    'Gray-Nicolls Kaboom Cricket Bat - Grade 2 English Willow (Lightly Used)',
    24999
  );
  insertListing.run(
    seller.lastInsertRowid,
    'Masuri Vision Series Cricket Helmet - Size M (Used, Great Condition)',
    8500
  );

  console.log(
    `[db] Seeded demo data: buyer_id=${buyer.lastInsertRowid}, seller_id=${seller.lastInsertRowid}, 2 listings.`
  );
}

seed();

module.exports = db;

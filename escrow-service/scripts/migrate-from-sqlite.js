'use strict';
// migrate-from-sqlite.js
//
// One-shot import of the legacy SQLite escrow database into PostgreSQL.
// Run AFTER `npm run migrate` has applied the PG schema.
//
// Usage:
//   DATABASE_URL=postgres://escrow_user:escrow_pass@127.0.0.1:5432/escrow_db \
//     node scripts/migrate-from-sqlite.js [path/to/escrow.sqlite3]
//
// The script is safe to re-run: it TRUNCATEs all tables first, then re-imports.
// Exits non-zero on any validation error.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const Database  = require('better-sqlite3');
const { Pool, types } = require('pg');

types.setTypeParser(20, Number); // BIGINT → Number

const SQLITE_PATH = process.argv[2]
  || path.join(__dirname, '..', 'data', 'escrow.sqlite3');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

// Expected validation data for Orders 5-13
const EXPECTED_ORDERS = {
  5:  { status: 'RELEASED'  },
  6:  { status: 'REFUNDED'  },
  7:  { status: 'RELEASED'  },
  8:  { status: 'RELEASED'  },
  9:  { status: 'CANCELLED' },
  10: { status: 'CANCELLED' },
  11: { status: 'HELD'      },
  12: { status: 'RELEASED'  },
  13: { status: 'REFUNDED'  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nullify(v) {
  // SQLite stores empty strings as '' sometimes; convert to null.
  if (v === undefined || v === null || v === '') return null;
  return v;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nImporting SQLite → PostgreSQL`);
  console.log(`  Source : ${SQLITE_PATH}`);
  console.log(`  Target : ${DATABASE_URL.replace(/:.*@/, ':***@')}\n`);

  // Open SQLite in read-only mode.
  let sqlite;
  try {
    sqlite = new Database(SQLITE_PATH, { readonly: true });
  } catch (err) {
    console.error(`Cannot open SQLite file: ${err.message}`);
    process.exit(1);
  }

  const pool = new Pool({ connectionString: DATABASE_URL });

  try {
    // ---- Truncate all tables in reverse FK order ----
    console.log('Truncating existing data…');
    await pool.query(`
      TRUNCATE reviews, messages, order_events, orders, listings, users
      RESTART IDENTITY CASCADE
    `);

    // ---- Import users ----
    const users = sqlite.prepare('SELECT * FROM users ORDER BY id').all();
    console.log(`Importing ${users.length} users…`);
    for (const u of users) {
      await pool.query(
        `INSERT INTO users (id, name, email, role, stripe_account_id)
         OVERRIDING SYSTEM VALUE
         VALUES ($1, $2, $3, $4, $5)`,
        [u.id, u.name, u.email, u.role, nullify(u.stripe_account_id)]
      );
    }

    // ---- Import listings ----
    const listings = sqlite.prepare('SELECT * FROM listings ORDER BY id').all();
    console.log(`Importing ${listings.length} listings…`);
    for (const l of listings) {
      await pool.query(
        `INSERT INTO listings (id, seller_id, title, price_cents)
         OVERRIDING SYSTEM VALUE
         VALUES ($1, $2, $3, $4)`,
        [l.id, l.seller_id, l.title, l.price_cents]
      );
    }

    // ---- Import orders ----
    const orders = sqlite.prepare('SELECT * FROM orders ORDER BY id').all();
    console.log(`Importing ${orders.length} orders…`);
    for (const o of orders) {
      await pool.query(
        `INSERT INTO orders (
           id, listing_id, buyer_id, seller_id,
           amount_cents, platform_fee_cents, seller_payout_cents,
           status,
           stripe_payment_intent_id, stripe_charge_id, stripe_client_secret,
           stripe_transfer_id, stripe_refund_id,
           shipped_at, delivered_at, window_expires_at,
           dispute_reason_text, dispute_category, dispute_resolution,
           cancellation_reason,
           prior_status, transition_started_at,
           recovery_claimed_at, recovery_attempts, last_recovery_error,
           created_at, updated_at
         ) OVERRIDING SYSTEM VALUE
         VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
           $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27
         )`,
        [
          o.id, o.listing_id, o.buyer_id, o.seller_id,
          o.amount_cents, o.platform_fee_cents, o.seller_payout_cents,
          o.status,
          nullify(o.stripe_payment_intent_id), nullify(o.stripe_charge_id), nullify(o.stripe_client_secret),
          nullify(o.stripe_transfer_id), nullify(o.stripe_refund_id),
          nullify(o.shipped_at), nullify(o.delivered_at), nullify(o.window_expires_at),
          nullify(o.dispute_reason_text), nullify(o.dispute_category), nullify(o.dispute_resolution),
          nullify(o.cancellation_reason),
          nullify(o.prior_status), nullify(o.transition_started_at),
          nullify(o.recovery_claimed_at), o.recovery_attempts || 0, nullify(o.last_recovery_error),
          o.created_at, o.updated_at,
        ]
      );
    }

    // ---- Import order_events ----
    const events = sqlite.prepare('SELECT * FROM order_events ORDER BY id').all();
    console.log(`Importing ${events.length} order_events…`);
    for (const e of events) {
      await pool.query(
        `INSERT INTO order_events (id, order_id, event_type, payload_json, created_at)
         OVERRIDING SYSTEM VALUE
         VALUES ($1, $2, $3, $4, $5)`,
        [e.id, e.order_id, e.event_type, nullify(e.payload_json), e.created_at]
      );
    }

    // ---- Import messages (table may not exist in older SQLite DBs) ----
    const hasMsgTable = sqlite.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'`
    ).get();
    const messages = hasMsgTable
      ? sqlite.prepare('SELECT * FROM messages ORDER BY id').all()
      : [];
    console.log(`Importing ${messages.length} messages…`);
    for (const m of messages) {
      await pool.query(
        `INSERT INTO messages (id, order_id, sender_id, body, created_at)
         OVERRIDING SYSTEM VALUE
         VALUES ($1, $2, $3, $4, $5)`,
        [m.id, m.order_id, m.sender_id, m.body, m.created_at]
      );
    }

    // ---- Import reviews (table may not exist in older SQLite DBs) ----
    const hasRevTable = sqlite.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='reviews'`
    ).get();
    const reviews = hasRevTable
      ? sqlite.prepare('SELECT * FROM reviews ORDER BY id').all()
      : [];
    console.log(`Importing ${reviews.length} reviews…`);
    for (const r of reviews) {
      await pool.query(
        `INSERT INTO reviews (id, order_id, reviewer_id, reviewee_id, rating, body, created_at)
         OVERRIDING SYSTEM VALUE
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [r.id, r.order_id, r.reviewer_id, r.reviewee_id, r.rating, nullify(r.body), r.created_at]
      );
    }

    // ---- Reset identity sequences ----
    console.log('\nResetting identity sequences…');
    for (const [table, col] of [
      ['users','id'], ['listings','id'], ['orders','id'],
      ['order_events','id'], ['messages','id'], ['reviews','id'],
    ]) {
      await pool.query(`
        SELECT setval(
          pg_get_serial_sequence($1, $2),
          COALESCE((SELECT MAX(id) FROM "${table}"), 0) + 1,
          false
        )
      `, [table, col]);
    }

    // ---- Validate ----
    console.log('\nValidating import…');
    let errors = 0;

    async function check(label, query, expectedVal) {
      const { rows } = await pool.query(query);
      const actual = rows[0] ? Object.values(rows[0])[0] : null;
      const pass = String(actual) === String(expectedVal);
      console.log(`  ${pass ? '✓' : '✗'}  ${label}: ${actual} ${pass ? '' : `(expected ${expectedVal})`}`);
      if (!pass) errors++;
    }

    // Row counts
    await check(`users:     ${users.length}`, `SELECT COUNT(*) FROM users`, users.length);
    await check(`listings:  ${listings.length}`, `SELECT COUNT(*) FROM listings`, listings.length);
    await check(`orders:    ${orders.length}`, `SELECT COUNT(*) FROM orders`, orders.length);
    await check(`events:    ${events.length}`, `SELECT COUNT(*) FROM order_events`, events.length);
    await check(`messages:  ${messages.length}`, `SELECT COUNT(*) FROM messages`, messages.length);
    await check(`reviews:   ${reviews.length}`, `SELECT COUNT(*) FROM reviews`, reviews.length);

    // Status totals
    const statusMap = orders.reduce((m, o) => { m[o.status] = (m[o.status] || 0) + 1; return m; }, {});
    for (const [status, count] of Object.entries(statusMap)) {
      await check(`${status}: ${count}`,
        `SELECT COUNT(*) FROM orders WHERE status = '${status}'`, count);
    }

    // Validate Orders 5-13 status
    console.log('\n  Orders 5–13 status check:');
    for (const [idStr, expected] of Object.entries(EXPECTED_ORDERS)) {
      const id = Number(idStr);
      const { rows } = await pool.query('SELECT id, status, stripe_payment_intent_id FROM orders WHERE id = $1', [id]);
      if (!rows[0]) {
        console.log(`  ✗  Order ${id}: not found`);
        errors++;
        continue;
      }
      const o = rows[0];
      const pass = o.status === expected.status;
      console.log(`  ${pass ? '✓' : '✗'}  Order ${id}: status=${o.status} pi=${o.stripe_payment_intent_id || '(none)'}`);
      if (!pass) { console.log(`       Expected status: ${expected.status}`); errors++; }
    }

    // Financial totals
    const { rows: [fin] } = await pool.query(`
      SELECT
        SUM(amount_cents) AS total_amount,
        SUM(platform_fee_cents) AS total_fees,
        SUM(seller_payout_cents) AS total_payouts
      FROM orders
    `);
    const srcFin = orders.reduce((acc, o) => {
      acc.amount  += o.amount_cents;
      acc.fees    += o.platform_fee_cents;
      acc.payouts += o.seller_payout_cents;
      return acc;
    }, { amount: 0, fees: 0, payouts: 0 });
    const fPass = fin.total_amount === srcFin.amount;
    console.log(`\n  ${fPass ? '✓' : '✗'}  Financial totals: amount=${fin.total_amount} fees=${fin.total_fees} payouts=${fin.total_payouts}`);
    if (!fPass) errors++;

    console.log('\n' + (errors === 0
      ? `Import complete — all ${users.length} users, ${listings.length} listings, ${orders.length} orders, ${events.length} events imported and validated.`
      : `Import completed with ${errors} validation error(s). Review output above.`
    ));

    if (errors > 0) process.exit(1);
  } finally {
    await pool.end();
    sqlite.close();
  }
}

main().catch((err) => { console.error('Import failed:', err); process.exit(1); });

#!/usr/bin/env node
// One-time script: copies listing and photo data from the existing SQLite
// database into PostgreSQL, preserving all original IDs and then resetting
// the identity sequences so future inserts continue after the imported max.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/migrate-from-sqlite.js
//
// Optional env:
//   SQLITE_PATH — path to listing.sqlite3 (default: data/listing.sqlite3)
//
// Safe to re-run: uses ON CONFLICT (id) DO NOTHING so rows already imported
// are silently skipped.
'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { Pool } = require('pg');

const SQLITE_PATH = process.env.SQLITE_PATH
  ? path.resolve(process.env.SQLITE_PATH)
  : path.join(__dirname, '..', 'data', 'listing.sqlite3');

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
  console.error('Error: DATABASE_URL is required');
  process.exit(1);
}

async function main() {
  // Open SQLite read-only so we can never accidentally modify the source.
  const sqlite = new Database(SQLITE_PATH, { readonly: true });

  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();

  try {
    const listings = sqlite.prepare('SELECT * FROM listings').all();
    const photos = sqlite.prepare('SELECT * FROM listing_photos').all();
    console.log(
      `Source: ${listings.length} listing(s), ${photos.length} photo(s) in ${SQLITE_PATH}`
    );

    await client.query('BEGIN');

    // --- Import listings ---
    let listingsInserted = 0;
    for (const row of listings) {
      const res = await client.query(
        `INSERT INTO listings
           (id, seller_id, title, description, price_cents, category, condition, status,
            meta_title, meta_description, tags, quality_score, created_at, updated_at)
         OVERRIDING SYSTEM VALUE
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (id) DO NOTHING`,
        [
          row.id,
          row.seller_id,
          row.title,
          row.description || '',
          row.price_cents,
          row.category || 'other',
          row.condition || 'used_good',
          row.status || 'active',
          row.meta_title || null,
          row.meta_description || null,
          row.tags || null,
          row.quality_score != null ? row.quality_score : null,
          row.created_at,
          row.updated_at,
        ]
      );
      listingsInserted += res.rowCount;
    }

    // --- Import photos ---
    let photosInserted = 0;
    for (const row of photos) {
      const res = await client.query(
        `INSERT INTO listing_photos (id, listing_id, filename, display_order, created_at)
         OVERRIDING SYSTEM VALUE
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [row.id, row.listing_id, row.filename, row.display_order || 0, row.created_at]
      );
      photosInserted += res.rowCount;
    }

    // --- Reset identity sequences to max imported ID ---
    // setval(seq, N, true)  → next insert gets N+1  (use when rows exist)
    // setval(seq, 1, false) → next insert gets 1    (use when table is empty)
    for (const table of ['listings', 'listing_photos']) {
      const { rows: maxRows } = await client.query(`SELECT MAX(id) AS m FROM ${table}`);
      const maxId = maxRows[0].m;
      if (maxId != null) {
        await client.query(
          `SELECT setval(pg_get_serial_sequence($1, 'id'), $2, true)`,
          [table, maxId]
        );
      } else {
        await client.query(
          `SELECT setval(pg_get_serial_sequence($1, 'id'), 1, false)`,
          [table]
        );
      }
    }

    await client.query('COMMIT');
    console.log(
      `Inserted: ${listingsInserted} listing(s), ${photosInserted} photo(s) ` +
        `(skipped ${listings.length - listingsInserted} + ${photos.length - photosInserted} already-present)`
    );

    // --- Validation ---
    console.log('\nValidation:');

    const totalListings = parseInt(
      (await client.query('SELECT COUNT(*) AS c FROM listings')).rows[0].c,
      10
    );
    const totalPhotos = parseInt(
      (await client.query('SELECT COUNT(*) AS c FROM listing_photos')).rows[0].c,
      10
    );
    console.log(`  Row counts — listings: ${totalListings}, photos: ${totalPhotos}`);

    const statusRows = (
      await client.query(
        `SELECT status, COUNT(*) AS c FROM listings GROUP BY status ORDER BY status`
      )
    ).rows;
    for (const s of statusRows) {
      console.log(`  Status '${s.status}': ${s.c}`);
    }

    const sellerRows = (
      await client.query(
        `SELECT seller_id, COUNT(*) AS c FROM listings GROUP BY seller_id ORDER BY seller_id`
      )
    ).rows;
    for (const s of sellerRows) {
      console.log(`  Seller ${s.seller_id}: ${s.c} listing(s)`);
    }

    const orphaned = parseInt(
      (
        await client.query(
          `SELECT COUNT(*) AS c FROM listing_photos lp
           LEFT JOIN listings l ON l.id = lp.listing_id
           WHERE l.id IS NULL`
        )
      ).rows[0].c,
      10
    );
    if (orphaned > 0) {
      console.warn(`  WARNING: ${orphaned} orphaned photo row(s) (no matching listing)`);
    } else {
      console.log(`  Photo relationships: OK (no orphans)`);
    }

    const maxListing = (await client.query('SELECT MAX(id) AS m FROM listings')).rows[0].m;
    const maxPhoto = (await client.query('SELECT MAX(id) AS m FROM listing_photos')).rows[0].m;
    console.log(
      `  ID ranges — listings: 1–${maxListing}, photos: ${maxPhoto != null ? '1–' + maxPhoto : 'none'}`
    );

    console.log('\nMigration complete.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    sqlite.close();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});

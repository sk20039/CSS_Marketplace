#!/usr/bin/env node
// One-time script: copies auth data from the existing SQLite database into
// PostgreSQL, preserving all user IDs, password hashes, roles, stripe account
// IDs, and active refresh token sessions. Resets identity sequences after
// import so future inserts continue beyond the highest imported ID.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/migrate-from-sqlite.js
//
// Optional env:
//   SQLITE_PATH — path to auth.sqlite3 (default: data/auth.sqlite3)
//
// Safe to re-run: uses ON CONFLICT (id) DO NOTHING throughout.
'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { Pool } = require('pg');

const SQLITE_PATH = process.env.SQLITE_PATH
  ? path.resolve(process.env.SQLITE_PATH)
  : path.join(__dirname, '..', 'data', 'auth.sqlite3');

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
  console.error('Error: DATABASE_URL is required');
  process.exit(1);
}

async function main() {
  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();

  try {
    // Read all users
    const users = sqlite.prepare('SELECT * FROM users').all();

    // Read only active (non-expired) refresh tokens to preserve live sessions
    const tokens = sqlite
      .prepare("SELECT * FROM refresh_tokens WHERE expires_at > datetime('now')")
      .all();

    // Email verification tokens — skip; all are expired in the source DB
    const evtCount = sqlite
      .prepare("SELECT COUNT(*) AS c FROM email_verification_tokens WHERE expires_at > datetime('now')")
      .get().c;

    console.log(`Source (${SQLITE_PATH}):`);
    console.log(`  ${users.length} user(s)`);
    console.log(`  ${tokens.length} active refresh token(s)`);
    console.log(`  ${evtCount} active email verification token(s) (skipped — all expired)`);

    await client.query('BEGIN');

    // --- Users ---
    let usersInserted = 0;
    for (const row of users) {
      const res = await client.query(
        `INSERT INTO users
           (id, name, email, password_hash, role, stripe_account_id, email_verified, created_at)
         OVERRIDING SYSTEM VALUE
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [
          row.id,
          row.name,
          row.email,
          row.password_hash,
          row.role || 'buyer',
          row.stripe_account_id || null,
          row.email_verified === 1,   // SQLite INTEGER 0/1 → PG BOOLEAN
          row.created_at,
        ]
      );
      usersInserted += res.rowCount;
    }

    // --- Active refresh tokens ---
    let tokensInserted = 0;
    for (const row of tokens) {
      const res = await client.query(
        `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at)
         OVERRIDING SYSTEM VALUE
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [row.id, row.user_id, row.token_hash, row.expires_at, row.created_at]
      );
      tokensInserted += res.rowCount;
    }

    // --- Reset identity sequences ---
    // setval(seq, N, true)  → next insert gets N+1  (use when rows exist)
    // setval(seq, 1, false) → next insert gets 1    (use when table is empty)
    for (const table of ['users', 'refresh_tokens', 'email_verification_tokens']) {
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

    const skippedUsers = users.length - usersInserted;
    const skippedTokens = tokens.length - tokensInserted;
    console.log(
      `\nInserted: ${usersInserted} user(s), ${tokensInserted} refresh token(s)` +
        (skippedUsers + skippedTokens > 0
          ? ` (skipped ${skippedUsers} + ${skippedTokens} already-present)`
          : '')
    );

    // --- Validation ---
    console.log('\nValidation:');

    const totalUsers = parseInt(
      (await client.query('SELECT COUNT(*) AS c FROM users')).rows[0].c, 10
    );
    const totalTokens = parseInt(
      (await client.query('SELECT COUNT(*) AS c FROM refresh_tokens')).rows[0].c, 10
    );
    console.log(`  Row counts — users: ${totalUsers}, refresh_tokens: ${totalTokens}`);

    const roleRows = (
      await client.query(`SELECT role, COUNT(*) AS c FROM users GROUP BY role ORDER BY role`)
    ).rows;
    for (const r of roleRows) {
      console.log(`  Role '${r.role}': ${r.c}`);
    }

    const verifiedRow = (
      await client.query(`SELECT COUNT(*) AS c FROM users WHERE email_verified = true`)
    ).rows[0];
    console.log(`  Verified users: ${verifiedRow.c} of ${totalUsers}`);

    // Verify seller Stripe account preserved
    const sellerStripe = (
      await client.query(
        `SELECT id, email, stripe_account_id FROM users WHERE stripe_account_id IS NOT NULL`
      )
    ).rows;
    if (sellerStripe.length === 0) {
      console.warn('  WARNING: no users with stripe_account_id found');
    } else {
      for (const s of sellerStripe) {
        console.log(`  Seller ${s.id} (${s.email}): stripe_account_id=${s.stripe_account_id}`);
      }
    }

    // Verify seller 3 specifically
    const seller3 = (
      await client.query(`SELECT stripe_account_id FROM users WHERE id = 3`)
    ).rows[0];
    if (seller3 && seller3.stripe_account_id === 'acct_1U590xBKfStkw42B') {
      console.log('  Seller 3 -> acct_1U590xBKfStkw42B: OK');
    } else if (seller3) {
      console.warn(`  WARNING: seller 3 stripe_account_id = ${seller3.stripe_account_id}`);
    } else {
      console.warn('  WARNING: user id=3 not found');
    }

    const maxUserId = (await client.query('SELECT MAX(id) AS m FROM users')).rows[0].m;
    const maxTokenId = (await client.query('SELECT MAX(id) AS m FROM refresh_tokens')).rows[0].m;
    console.log(`  ID ranges — users: 1–${maxUserId}, refresh_tokens: ${maxTokenId ? '1–' + maxTokenId : 'none'}`);

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

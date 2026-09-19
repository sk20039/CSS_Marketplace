'use strict';
// Cricket Market — BA Report V1
// Read-only. Connects to all 3 production DBs via Railway tunnel.
//
// Required env vars (set via tunnel URL extraction — see comments below):
//   DATABASE_URL_AUTH     — auth DB    (tunnel port 15440)
//   DATABASE_URL_LISTING  — listing DB (tunnel port 15441, db=listing_db)
//   DATABASE_URL_ESCROW   — escrow DB  (tunnel port 15441, db=escrow_db)
//
// Run via: node scripts/ba_report.js
// Outputs: terminal report + scripts/ba_report_YYYY-MM-DD.md

const path = require('path');
const fs   = require('fs');

// pg may live in a service node_modules when run from monorepo root.
let Pool, pgTypes;
try {
  ({ Pool, types: pgTypes } = require('pg'));
} catch {
  ({ Pool, types: pgTypes } = require(path.join(__dirname, '../auth-service/node_modules/pg')));
}

// Mirror escrow-service's BIGINT → Number type parser so SUM/COUNT BIGINT
// columns come back as JS numbers rather than strings.
pgTypes.setTypeParser(20, Number);

const Q = require('./ba_report_queries');
const { EXCLUDED_EMAILS, users: userQ, listings: listingQ, sales: salesQ } = Q;

// ── Safety guard: reject any non-SELECT SQL before it reaches the DB ──────
function assertSelectOnly(sql) {
  const first = sql.replace(/\/\*[\s\S]*?\*\//g, '').trim().split(/\s+/)[0].toUpperCase();
  if (first !== 'SELECT') {
    throw new Error(`SAFETY: non-SELECT query blocked — starts with "${first}"`);
  }
}

async function q(pool, { sql, params }) {
  assertSelectOnly(sql);
  const { rows } = await pool.query(sql, params);
  return rows;
}

// ── Formatting helpers ────────────────────────────────────────────────────
function usd(cents) {
  const n = Number(cents) || 0;
  return '$' + (n / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function pct(num, denom) {
  if (!denom) return '—';
  return ((Number(num) / Number(denom)) * 100).toFixed(1) + '%';
}

function bar(val, max, width = 24) {
  const v = Number(val); const m = Number(max) || 1;
  const filled = Math.round((v / m) * width);
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
}

// ── Build the report text ─────────────────────────────────────────────────
function buildReport(data) {
  const {
    totalUsers, buyers, sellers, verified, newLast7, newLast30, shipFrom,
    totalListings, byStatus, newListings7, newListings30, uniqueSellers,
    orderByStatus, released, cancelledCount, refundedCount, disputedCount, totalOrders,
  } = data;

  const W = 60;
  const SEP  = '═'.repeat(W);
  const TSEP = '─'.repeat(W);

  // Terminal lines
  const T = [];
  // Markdown lines
  const M = [];

  function tLine(s = '') { T.push(s); }
  function mLine(s = '') { M.push(s); }
  function both(t, m) { tLine(t); mLine(m != null ? m : t); }

  function section(title) {
    tLine(''); tLine(SEP); tLine('  ' + title); tLine(SEP);
    mLine(''); mLine('---'); mLine(''); mLine('## ' + title);
  }

  function sub(title) {
    tLine(''); tLine('  ── ' + title);
    mLine(''); mLine('### ' + title);
  }

  function kv(label, value, mdValue) {
    const pad = 38;
    tLine('  ' + label.padEnd(pad) + (value == null ? '—' : value));
    mLine('- **' + label.trimEnd() + '** ' + (mdValue != null ? mdValue : (value == null ? '—' : value)));
  }

  function blank() { tLine(''); mLine(''); }

  // Header
  const now = new Date().toISOString();
  tLine(SEP);
  tLine('  Cricket Market — Business Report');
  tLine('  ' + now);
  tLine(TSEP);
  tLine('  Excluded accounts: ' + EXCLUDED_EMAILS.join(', '));
  tLine(SEP);
  mLine('# Cricket Market — Business Report');
  mLine('');
  mLine('*' + now + '*');
  mLine('');
  mLine('*Excluded technical accounts: ' + EXCLUDED_EMAILS.join(', ') + '*');

  // ── 1. USERS ────────────────────────────────────────────────────────────
  section('1. USERS');
  kv('Total real marketplace users', totalUsers);
  kv('  Buyers',  buyers);
  kv('  Sellers', sellers);
  kv('Email-verified users',
    `${verified} (${pct(verified, totalUsers)} of total)`);
  blank();
  kv('New users — last 7 days',  newLast7);
  kv('New users — last 30 days', newLast30);
  blank();
  kv('Sellers with ship-from address',
    `${shipFrom} of ${sellers} sellers (${pct(shipFrom, sellers)})`);

  // ── 2. LISTINGS ─────────────────────────────────────────────────────────
  section('2. LISTINGS');
  kv('Total listings', totalListings);
  kv('  Active',   byStatus['active']   || 0);
  kv('  Sold',     byStatus['sold']     || 0);
  kv('  Inactive', byStatus['inactive'] || 0);
  blank();
  kv('New listings — last 7 days',  newListings7);
  kv('New listings — last 30 days', newListings30);
  blank();
  kv('Unique sellers who have listed', uniqueSellers);

  // ── 3. SALES ────────────────────────────────────────────────────────────
  section('3. SALES');

  sub('Orders by status');
  mLine('');
  mLine('| Status | Count |');
  mLine('|--------|-------|');
  for (const { status, count } of orderByStatus) {
    tLine('  ' + status.padEnd(18) + count);
    mLine(`| ${status} | ${count} |`);
  }

  sub('Completed (RELEASED)');
  kv('Completed sales count',            released.count);
  kv('Merchandise GMV',                  usd(released.gmv_cents));
  kv('Platform fees earned',             usd(released.fees_cents));
  kv('Seller payouts',                   usd(released.payouts_cents));
  kv('Average merchandise order value',  usd(released.avg_order_cents));

  sub('Other outcomes');
  kv('Cancelled orders',             cancelledCount);
  kv('Refunded orders (disputes)',   refundedCount);
  kv('Orders ever disputed',         disputedCount);
  if (released.count > 0 || refundedCount > 0) {
    kv('Dispute rate',
      pct(disputedCount, Number(released.count) + Number(refundedCount)));
  }

  // ── 4. FUNNEL ────────────────────────────────────────────────────────────
  section('4. SIMPLE MARKETPLACE FUNNEL');
  tLine('');
  tLine('  Note: page-view, checkout-page, traffic-source and');
  tLine('  abandonment metrics are not captured. Counts only.');
  mLine('');
  mLine('> Page-view, checkout-page, traffic-source and abandonment metrics');
  mLine('> are not currently captured. Counts only.');

  sub('Seller pipeline');
  mLine('');
  mLine('| Stage | Count |');
  mLine('|-------|-------|');

  const maxS = Number(sellers) || 1;
  tLine('');
  tLine(`  Sellers registered       ${bar(sellers,  maxS)}  ${sellers}`);
  tLine(`  Sellers listing-ready    ${bar(shipFrom, maxS)}  ${shipFrom}`);
  tLine(`  Sellers with ≥1 listing  ${bar(uniqueSellers, maxS)}  ${uniqueSellers}`);
  mLine(`| Sellers registered | ${sellers} |`);
  mLine(`| Sellers listing-ready (ship-from address set) | ${shipFrom} |`);
  mLine(`| Sellers with ≥1 listing | ${uniqueSellers} |`);

  if (Number(sellers) > 0) {
    tLine('');
    tLine(`  Listing-ready rate:  ${pct(shipFrom, sellers)}  |  Listed rate: ${pct(uniqueSellers, sellers)}`);
    mLine('');
    mLine(`*Listing-ready rate: ${pct(shipFrom, sellers)} — Listed rate: ${pct(uniqueSellers, sellers)}*`);
  }

  sub('Order pipeline');
  mLine('');
  mLine('| Stage | Count |');
  mLine('|-------|-------|');

  const maxO = Number(totalOrders) || 1;
  tLine('');
  tLine(`  Orders started          ${bar(totalOrders,    maxO)}  ${totalOrders}`);
  tLine(`  Released (complete)     ${bar(released.count, maxO)}  ${released.count}`);
  tLine(`  Cancelled               ${bar(cancelledCount, maxO)}  ${cancelledCount}`);
  tLine(`  Refunded / Disputed     ${bar(Number(refundedCount) + Number(disputedCount), maxO)}  ${refundedCount} refunded + ${disputedCount} disputed`);

  mLine(`| Orders started | ${totalOrders} |`);
  mLine(`| Released (complete) | ${released.count} |`);
  mLine(`| Cancelled | ${cancelledCount} |`);
  mLine(`| Refunded | ${refundedCount} |`);
  mLine(`| Disputed (ever) | ${disputedCount} |`);

  // Footer
  tLine(''); tLine(SEP); tLine('');

  return {
    terminal: T.join('\n'),
    markdown: M.join('\n'),
    reportDate: now.slice(0, 10),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const authUrl    = process.env.DATABASE_URL_AUTH;
  const listingUrl = process.env.DATABASE_URL_LISTING;
  const escrowUrl  = process.env.DATABASE_URL_ESCROW;

  if (!authUrl || !listingUrl || !escrowUrl) {
    console.error(
      '\n[BA REPORT] Missing required env vars:\n' +
      '  DATABASE_URL_AUTH     — auth DB    (tunnel: localhost:15440)\n' +
      '  DATABASE_URL_LISTING  — listing DB (tunnel: localhost:15441/listing_db)\n' +
      '  DATABASE_URL_ESCROW   — escrow DB  (tunnel: localhost:15441/escrow_db)\n' +
      '\nSee scripts/.env.ba.example for setup instructions.\n'
    );
    process.exit(1);
  }

  // ssl:false — tunnel connections are localhost; no TLS needed.
  const authPool    = new Pool({ connectionString: authUrl,    ssl: false });
  const listingPool = new Pool({ connectionString: listingUrl, ssl: false });
  const escrowPool  = new Pool({ connectionString: escrowUrl,  ssl: false });

  try {
    // ── DB identity pre-flight ─────────────────────────────────────────────
    // Verify each connection reports the expected database name BEFORE running
    // any business queries. An occupied tunnel port that belongs to a different
    // database (e.g. a stale staging tunnel) will fail this check and abort
    // clearly rather than silently querying the wrong data.
    const EXPECTED = [
      { pool: authPool,    name: 'railway',    label: 'auth (DATABASE_URL_AUTH)' },
      { pool: listingPool, name: 'listing_db', label: 'listing (DATABASE_URL_LISTING)' },
      { pool: escrowPool,  name: 'escrow_db',  label: 'escrow (DATABASE_URL_ESCROW)' },
    ];
    for (const { pool, name, label } of EXPECTED) {
      const { rows } = await pool.query('SELECT current_database() AS db');
      const actual = rows[0].db;
      if (actual !== name) {
        throw new Error(
          `TUNNEL SAFETY: ${label} connected to database "${actual}" ` +
          `but expected "${name}". ` +
          `Verify the tunnel on this port belongs to the correct production DB before re-running.`
        );
      }
    }

    // All queries are SELECT-only; the safety guard in q() verifies each one.
    const [
      [userTotal], userByRole, [userVerified],
      [userNew7],  [userNew30], [userShipFrom],
    ] = await Promise.all([
      q(authPool, userQ.totalReal),
      q(authPool, userQ.byRole),
      q(authPool, userQ.verified),
      q(authPool, userQ.newLast7),
      q(authPool, userQ.newLast30),
      q(authPool, userQ.sellersWithShipFrom),
    ]);

    const [
      [listingTotal], listingByStatus,
      [listingNew7],  [listingNew30], [listingUniqueSellers],
    ] = await Promise.all([
      q(listingPool, listingQ.total),
      q(listingPool, listingQ.byStatus),
      q(listingPool, listingQ.newLast7),
      q(listingPool, listingQ.newLast30),
      q(listingPool, listingQ.uniqueSellers),
    ]);

    const [
      orderByStatus, [released],
      [cancelled],   [refunded], [disputed], [totalOrders],
    ] = await Promise.all([
      q(escrowPool, salesQ.byStatus),
      q(escrowPool, salesQ.released),
      q(escrowPool, salesQ.cancelled),
      q(escrowPool, salesQ.refunded),
      q(escrowPool, salesQ.disputed),
      q(escrowPool, salesQ.totalOrders),
    ]);

    const buyers  = (userByRole.find(r => r.role === 'buyer')  || {}).count || 0;
    const sellers = (userByRole.find(r => r.role === 'seller') || {}).count || 0;
    const byStatus = Object.fromEntries(listingByStatus.map(r => [r.status, r.count]));

    const { terminal, markdown, reportDate } = buildReport({
      totalUsers: userTotal.count,
      buyers,
      sellers,
      verified:      userVerified.count,
      newLast7:      userNew7.count,
      newLast30:     userNew30.count,
      shipFrom:      userShipFrom.count,
      totalListings: listingTotal.count,
      byStatus,
      newListings7:  listingNew7.count,
      newListings30: listingNew30.count,
      uniqueSellers: listingUniqueSellers.count,
      orderByStatus,
      released,
      cancelledCount: cancelled.count,
      refundedCount:  refunded.count,
      disputedCount:  disputed.count,
      totalOrders:    totalOrders.count,
    });

    console.log(terminal);

    const mdPath = path.join(__dirname, `ba_report_${reportDate}.md`);
    fs.writeFileSync(mdPath, markdown, 'utf8');
    console.log(`  Markdown report → ${mdPath}\n`);

  } finally {
    await Promise.allSettled([authPool.end(), listingPool.end(), escrowPool.end()]);
  }
}

main().catch(err => {
  console.error('\n[BA REPORT ERROR]', err.message || err);
  process.exit(1);
});

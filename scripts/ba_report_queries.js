'use strict';

// Read-only SQL queries for the BA report.
// Every query is SELECT-only. The runner verifies this before executing.

// Accounts excluded from all business metrics.
// These are technical/operational accounts, not real marketplace users.
const EXCLUDED_EMAILS = [
  'admin@cricketmarketusa.com',           // Platform admin account (id=7)
  'qa-monitor@cricketmarketusa.com',      // QA monitoring account  (id=8)
  'smoke_nonexistent_probe@test.invalid', // Smoke-test probe       (id=3)
];

// Build a parameterised NOT IN clause: ($1,$2,$3)
const EX = `(${EXCLUDED_EMAILS.map((_, i) => `$${i + 1}`).join(',')})`;
const EP = EXCLUDED_EMAILS; // shorthand for params array

module.exports = {
  EXCLUDED_EMAILS,

  // ── USERS (auth DB) ────────────────────────────────────────────────────
  users: {
    totalReal: {
      sql: `SELECT COUNT(*)::INT AS count FROM users
            WHERE role != 'admin' AND email NOT IN ${EX}`,
      params: EP,
    },
    byRole: {
      sql: `SELECT role, COUNT(*)::INT AS count FROM users
            WHERE role != 'admin' AND email NOT IN ${EX}
            GROUP BY role ORDER BY role`,
      params: EP,
    },
    verified: {
      sql: `SELECT COUNT(*)::INT AS count FROM users
            WHERE role != 'admin' AND email_verified = true
            AND email NOT IN ${EX}`,
      params: EP,
    },
    newLast7: {
      sql: `SELECT COUNT(*)::INT AS count FROM users
            WHERE role != 'admin' AND email NOT IN ${EX}
            AND created_at >= NOW() - INTERVAL '7 days'`,
      params: EP,
    },
    newLast30: {
      sql: `SELECT COUNT(*)::INT AS count FROM users
            WHERE role != 'admin' AND email NOT IN ${EX}
            AND created_at >= NOW() - INTERVAL '30 days'`,
      params: EP,
    },
    sellersWithShipFrom: {
      sql: `SELECT COUNT(*)::INT AS count FROM users
            WHERE role = 'seller' AND ship_from_address IS NOT NULL
            AND email NOT IN ${EX}`,
      params: EP,
    },
  },

  // ── LISTINGS (listing DB) ──────────────────────────────────────────────
  listings: {
    total: {
      sql: `SELECT COUNT(*)::INT AS count FROM listings`,
      params: [],
    },
    byStatus: {
      sql: `SELECT status, COUNT(*)::INT AS count
            FROM listings GROUP BY status ORDER BY status`,
      params: [],
    },
    newLast7: {
      sql: `SELECT COUNT(*)::INT AS count FROM listings
            WHERE created_at >= NOW() - INTERVAL '7 days'`,
      params: [],
    },
    newLast30: {
      sql: `SELECT COUNT(*)::INT AS count FROM listings
            WHERE created_at >= NOW() - INTERVAL '30 days'`,
      params: [],
    },
    uniqueSellers: {
      sql: `SELECT COUNT(DISTINCT seller_id)::INT AS count FROM listings`,
      params: [],
    },
  },

  // ── SALES (escrow DB) ──────────────────────────────────────────────────
  sales: {
    byStatus: {
      sql: `SELECT status, COUNT(*)::INT AS count
            FROM orders GROUP BY status ORDER BY count DESC`,
      params: [],
    },
    released: {
      sql: `SELECT
              COUNT(*)::INT                                      AS count,
              COALESCE(SUM(item_price_cents), 0)::BIGINT         AS gmv_cents,
              COALESCE(SUM(platform_fee_cents), 0)::BIGINT        AS fees_cents,
              COALESCE(SUM(seller_payout_cents), 0)::BIGINT       AS payouts_cents,
              COALESCE(AVG(item_price_cents)::INT, 0)             AS avg_order_cents
            FROM orders WHERE status = 'RELEASED'`,
      params: [],
    },
    cancelled: {
      sql: `SELECT COUNT(*)::INT AS count FROM orders WHERE status = 'CANCELLED'`,
      params: [],
    },
    refunded: {
      sql: `SELECT COUNT(*)::INT AS count FROM orders WHERE status = 'REFUNDED'`,
      params: [],
    },
    disputed: {
      // Counts any order that was ever disputed (dispute_reason_text set),
      // including those resolved as RELEASED or REFUNDED.
      sql: `SELECT COUNT(*)::INT AS count
            FROM orders WHERE dispute_reason_text IS NOT NULL`,
      params: [],
    },
    totalOrders: {
      sql: `SELECT COUNT(*)::INT AS count FROM orders`,
      params: [],
    },
  },
};

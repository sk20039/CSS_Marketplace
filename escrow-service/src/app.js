'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');
const pool = require('./db');
const orderService = require('./orderService');
const { runReleaseCheck, cancelOrder } = require('./orderService');
const { runRecovery } = require('./recoveryService');
const { OrderError } = orderService;
const requireAuth = require('./middleware/requireAuth');
const { requireAdmin } = requireAuth;
const { buildHealthRouter } = require('./healthRoutes');

function isParty(user, order) {
  return (
    user.role === 'admin' ||
    String(user.id) === String(order.buyer_id) ||
    String(user.id) === String(order.seller_id)
  );
}

function buildApp() {
  const app = express();
  const allowedOrigins = (process.env.FRONTEND_ORIGIN || 'http://localhost:3003')
    .split(',').map(o => o.trim());
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
  }));
  app.use(express.json());

  // Health checks — no auth required.
  app.use('/health', buildHealthRouter(pool, 'escrow-service'));

  // ---- static demo UI (local development only) ----
  if (process.env.NODE_ENV !== 'production') {
    app.use(express.static(path.join(__dirname, '..', 'public')));
  }

  // ---- helper endpoints (admin-only: expose user/listing mirror for demo UI) ----
  app.get('/api/users', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const { rows } = await pool.query('SELECT id, name, email, role FROM users ORDER BY id');
      res.json(rows);
    } catch (err) { next(err); }
  });

  app.get('/api/listings', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT l.id, l.title, l.price_cents, l.seller_id, u.name AS seller_name
         FROM listings l JOIN users u ON u.id = l.seller_id ORDER BY l.id`
      );
      res.json(rows);
    } catch (err) { next(err); }
  });

  // ---- orders ----
  app.post('/orders', requireAuth, async (req, res, next) => {
    try {
      const { listing_id } = req.body;
      if (!listing_id) throw new OrderError('listing_id is required', 400);
      const order = await orderService.createOrder({ listingId: listing_id, buyerId: req.user.id });
      res.status(201).json(order);
    } catch (err) { next(err); }
  });

  app.get('/orders', requireAuth, async (req, res, next) => {
    try {
      const { status } = req.query;
      let orders;
      if (req.user.role === 'admin') {
        const { buyer_id, seller_id } = req.query;
        orders = await orderService.listOrders({ buyerId: buyer_id, sellerId: seller_id });
      } else {
        const [byBuyer, bySeller] = await Promise.all([
          orderService.listOrders({ buyerId: req.user.id }),
          orderService.listOrders({ sellerId: req.user.id }),
        ]);
        const mine = new Map();
        for (const o of byBuyer)  mine.set(o.id, o);
        for (const o of bySeller) mine.set(o.id, o);
        orders = Array.from(mine.values()).sort((a, b) => b.id - a.id);
      }
      if (status) {
        const wanted = String(status).split(',').map((s) => s.trim().toUpperCase());
        orders = orders.filter((o) => wanted.includes(o.status));
      }
      res.json(orders);
    } catch (err) { next(err); }
  });

  app.get('/orders/:id', requireAuth, async (req, res, next) => {
    try {
      const order = await orderService.getOrderWithTimeline(req.params.id);
      if (!isParty(req.user, order)) throw new OrderError('Forbidden: not a party to this order', 403);
      res.json(order);
    } catch (err) { next(err); }
  });

  app.get('/orders/:id/client-secret', requireAuth, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        'SELECT id, status, buyer_id, stripe_client_secret FROM orders WHERE id = $1',
        [req.params.id]
      );
      const order = rows[0];
      if (!order) throw new OrderError('Order not found', 404);
      if (req.user.role !== 'admin' && String(req.user.id) !== String(order.buyer_id)) {
        throw new OrderError('Forbidden', 403);
      }
      if (order.status !== 'CREATED') {
        throw new OrderError('Payment has already been submitted for this order', 400);
      }
      res.json({ client_secret: order.stripe_client_secret });
    } catch (err) { next(err); }
  });

  app.post('/orders/:id/capture', requireAuth, async (req, res, next) => {
    try {
      const order = await orderService.getOrderWithTimeline(req.params.id);
      if (req.user.role !== 'admin' && String(req.user.id) !== String(order.buyer_id)) {
        throw new OrderError('Forbidden: only the buyer can pay for this order', 403);
      }
      res.json(await orderService.captureOrder(req.params.id));
    } catch (err) { next(err); }
  });

  app.post('/orders/:id/ship', requireAuth, async (req, res, next) => {
    try {
      const order = await orderService.getOrderWithTimeline(req.params.id);
      if (req.user.role !== 'admin' && String(req.user.id) !== String(order.seller_id)) {
        throw new OrderError('Forbidden: only the seller can mark this order shipped', 403);
      }
      res.json(await orderService.shipOrder(req.params.id));
    } catch (err) { next(err); }
  });

  app.post('/orders/:id/deliver', requireAuth, async (req, res, next) => {
    try {
      const order = await orderService.getOrderWithTimeline(req.params.id);
      if (req.user.role !== 'admin' && String(req.user.id) !== String(order.seller_id)) {
        throw new OrderError('Forbidden: only the seller can mark this order delivered', 403);
      }
      res.json(await orderService.deliverOrder(req.params.id));
    } catch (err) { next(err); }
  });

  app.post('/orders/:id/confirm', requireAuth, async (req, res, next) => {
    try {
      const order = await orderService.getOrderWithTimeline(req.params.id);
      if (req.user.role !== 'admin' && String(req.user.id) !== String(order.buyer_id)) {
        throw new OrderError('Forbidden: only the buyer can confirm receipt of this order', 403);
      }
      res.json(await orderService.confirmOrder(req.params.id));
    } catch (err) { next(err); }
  });

  app.post('/orders/:id/cancel', requireAuth, async (req, res, next) => {
    try {
      const order = await orderService.getOrderWithTimeline(req.params.id);
      const isBuyer = String(req.user.id) === String(order.buyer_id);
      const isAdmin = req.user.role === 'admin';
      if (!isAdmin && !isBuyer) {
        throw new OrderError('Forbidden: only the buyer or an admin can cancel this order', 403);
      }
      const { reason } = req.body;
      const cancelledBy = isAdmin ? 'admin' : 'buyer';
      res.json(await cancelOrder(req.params.id, { cancelledBy, reason }));
    } catch (err) { next(err); }
  });

  app.post('/orders/:id/dispute', requireAuth, async (req, res, next) => {
    try {
      const order = await orderService.getOrderWithTimeline(req.params.id);
      if (req.user.role !== 'admin' && String(req.user.id) !== String(order.buyer_id)) {
        throw new OrderError('Forbidden: only the buyer can file a dispute on this order', 403);
      }
      const { reason } = req.body;
      res.json(await orderService.disputeOrder(req.params.id, reason));
    } catch (err) { next(err); }
  });

  // ---- internal sync endpoints ----
  app.post('/api/sync/user', requireAuth, async (req, res, next) => {
    try {
      const { id, name, email, role, stripe_account_id } = req.body;
      if (!id || !name || !email || !role) {
        return res.status(400).json({ error: 'id, name, email, and role are required' });
      }
      if (req.user.role !== 'admin' && String(req.user.id) !== String(id)) {
        return res.status(403).json({ error: 'Forbidden: can only sync your own user record' });
      }
      await pool.query(
        `INSERT INTO users (id, name, email, role, stripe_account_id)
         OVERRIDING SYSTEM VALUE
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           name              = EXCLUDED.name,
           email             = EXCLUDED.email,
           role              = EXCLUDED.role,
           stripe_account_id = COALESCE(EXCLUDED.stripe_account_id, users.stripe_account_id)`,
        [id, name, email, role, stripe_account_id || null]
      );
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  app.post('/api/sync/listing', requireAuth, async (req, res, next) => {
    try {
      const { id, seller_id, title, price_cents } = req.body;
      if (!id || !seller_id || !title || price_cents == null) {
        return res.status(400).json({ error: 'id, seller_id, title, and price_cents are required' });
      }
      if (req.user.role !== 'admin' && String(req.user.id) !== String(seller_id)) {
        return res.status(403).json({ error: 'Forbidden: only the listing owner can sync it to escrow' });
      }
      await pool.query(
        `INSERT INTO listings (id, seller_id, title, price_cents)
         OVERRIDING SYSTEM VALUE
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET
           seller_id   = EXCLUDED.seller_id,
           title       = EXCLUDED.title,
           price_cents = EXCLUDED.price_cents`,
        [id, seller_id, title, price_cents]
      );
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ---- reviews ----
  app.post('/orders/:id/review', requireAuth, async (req, res, next) => {
    try {
      const order = await orderService.getOrderWithTimeline(req.params.id);
      if (order.status !== 'RELEASED') throw new OrderError('Order must be RELEASED to leave a review', 400);
      if (String(req.user.id) !== String(order.buyer_id)) throw new OrderError('Only the buyer can review this order', 403);
      const { rating, body } = req.body;
      const r = Math.round(Number(rating));
      if (!r || r < 1 || r > 5) throw new OrderError('rating must be 1–5', 400);

      const existing = await pool.query(
        'SELECT id FROM reviews WHERE order_id = $1 AND reviewer_id = $2',
        [order.id, req.user.id]
      );
      if (existing.rows[0]) throw new OrderError('You have already reviewed this order', 409);

      const { rows } = await pool.query(
        `INSERT INTO reviews (order_id, reviewer_id, reviewee_id, rating, body, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *`,
        [order.id, req.user.id, order.seller_id, r, body ? String(body).trim() || null : null]
      );
      const rev = rows[0];
      res.status(201).json({ ...rev, created_at: rev.created_at instanceof Date ? rev.created_at.toISOString() : rev.created_at });
    } catch (err) { next(err); }
  });

  app.get('/orders/:id/review', requireAuth, async (req, res, next) => {
    try {
      const order = await orderService.getOrderWithTimeline(req.params.id);
      if (!isParty(req.user, order)) throw new OrderError('Forbidden', 403);
      const { rows } = await pool.query(
        'SELECT * FROM reviews WHERE order_id = $1 AND reviewer_id = $2',
        [order.id, req.user.id]
      );
      const rev = rows[0] || null;
      if (rev) rev.created_at = rev.created_at instanceof Date ? rev.created_at.toISOString() : rev.created_at;
      res.json(rev);
    } catch (err) { next(err); }
  });

  app.get('/users/:userId/reviews', async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT r.id, r.order_id, r.rating, r.body, r.created_at, u.name AS reviewer_name
         FROM reviews r JOIN users u ON u.id = r.reviewer_id
         WHERE r.reviewee_id = $1 ORDER BY r.created_at DESC`,
        [req.params.userId]
      );
      const reviews = rows.map((r) => ({
        ...r,
        created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      }));
      const count = reviews.length;
      const average_rating = count > 0
        ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / count) * 10) / 10
        : null;
      res.json({ reviews, average_rating, count });
    } catch (err) { next(err); }
  });

  // ---- messages ----
  app.get('/orders/:id/messages', requireAuth, async (req, res, next) => {
    try {
      const order = await orderService.getOrderWithTimeline(req.params.id);
      if (!isParty(req.user, order)) throw new OrderError('Forbidden', 403);
      const { rows } = await pool.query(
        `SELECT m.id, m.order_id, m.sender_id, u.name AS sender_name, m.body, m.created_at
         FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.order_id = $1 ORDER BY m.created_at ASC`,
        [order.id]
      );
      res.json(rows.map((m) => ({
        ...m,
        created_at: m.created_at instanceof Date ? m.created_at.toISOString() : m.created_at,
      })));
    } catch (err) { next(err); }
  });

  app.post('/orders/:id/messages', requireAuth, async (req, res, next) => {
    try {
      const order = await orderService.getOrderWithTimeline(req.params.id);
      if (!isParty(req.user, order)) throw new OrderError('Forbidden', 403);
      const { body } = req.body;
      if (!body || !String(body).trim()) throw new OrderError('body is required', 400);
      const { rows: ins } = await pool.query(
        `INSERT INTO messages (order_id, sender_id, body, created_at)
         VALUES ($1, $2, $3, NOW()) RETURNING id`,
        [order.id, req.user.id, String(body).trim()]
      );
      const { rows } = await pool.query(
        `SELECT m.id, m.order_id, m.sender_id, u.name AS sender_name, m.body, m.created_at
         FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = $1`,
        [ins[0].id]
      );
      const msg = rows[0];
      msg.created_at = msg.created_at instanceof Date ? msg.created_at.toISOString() : msg.created_at;
      res.status(201).json(msg);
    } catch (err) { next(err); }
  });

  // ---- admin ----
  app.post('/admin/orders/:id/resolve', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const { action } = req.body;
      res.json(await orderService.resolveDispute(req.params.id, action));
    } catch (err) { next(err); }
  });

  app.post('/admin/run-release-check', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      res.json(await runReleaseCheck());
    } catch (err) { next(err); }
  });

  app.post('/admin/run-recovery', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      res.json(await runRecovery());
    } catch (err) { next(err); }
  });

  // ---- error handler ----
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const statusCode = err.statusCode || 500;
    if (statusCode >= 500) console.error(err);
    res.status(statusCode).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

module.exports = { buildApp };

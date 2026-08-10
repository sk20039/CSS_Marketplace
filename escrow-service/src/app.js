const path = require('path');
const express = require('express');
const cors = require('cors');
const db = require('./db');
const orderService = require('./orderService');
const { runReleaseCheck, cancelOrder } = require('./orderService');
const { OrderError } = orderService;
const requireAuth = require('./middleware/requireAuth');
const { requireAdmin } = requireAuth;

function isParty(user, order) {
  return (
    user.role === 'admin' ||
    String(user.id) === String(order.buyer_id) ||
    String(user.id) === String(order.seller_id)
  );
}

function buildApp() {
  const app = express();
  app.use(cors({ origin: process.env.FRONTEND_ORIGIN || 'http://localhost:3003', credentials: true }));
  app.use(express.json());

  // ---- static demo UI ----
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---- helper endpoints for the demo UI. These expose every user's email
  // and every listing's seller, so they're admin-only now that real auth
  // exists - the legacy static demo pages under public/ were built before
  // auth-service existed and are superseded by the real frontend. ----
  app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
    res.json(db.prepare('SELECT id, name, email, role FROM users ORDER BY id').all());
  });

  app.get('/api/listings', requireAuth, requireAdmin, (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT listings.id, listings.title, listings.price_cents, listings.seller_id, users.name AS seller_name
           FROM listings JOIN users ON users.id = listings.seller_id ORDER BY listings.id`
        )
        .all()
    );
  });

  // ---- orders ----
  app.post('/orders', requireAuth, async (req, res, next) => {
    try {
      const { listing_id } = req.body;
      if (!listing_id) {
        throw new OrderError('listing_id is required', 400);
      }
      // buyerId always comes from the verified token, never the request body,
      // so a caller can't create an order "as" a different buyer.
      const order = await orderService.createOrder({ listingId: listing_id, buyerId: req.user.id });
      res.status(201).json(order);
    } catch (err) {
      next(err);
    }
  });

  app.get('/orders', requireAuth, (req, res, next) => {
    try {
      const { status } = req.query;
      let orders;
      if (req.user.role === 'admin') {
        const { buyer_id, seller_id } = req.query;
        orders = orderService.listOrders({ buyerId: buyer_id, sellerId: seller_id });
      } else {
        // Non-admins may only ever see orders where they're the buyer or the
        // seller - query params can't be used to look at someone else's orders.
        const mine = new Map();
        for (const o of orderService.listOrders({ buyerId: req.user.id })) mine.set(o.id, o);
        for (const o of orderService.listOrders({ sellerId: req.user.id })) mine.set(o.id, o);
        orders = Array.from(mine.values()).sort((a, b) => b.id - a.id);
      }
      if (status) {
        const wanted = String(status).split(',').map((s) => s.trim().toUpperCase());
        orders = orders.filter((o) => wanted.includes(o.status));
      }
      res.json(orders);
    } catch (err) {
      next(err);
    }
  });

  app.get('/orders/:id', requireAuth, (req, res, next) => {
    try {
      const order = orderService.getOrderWithTimeline(req.params.id);
      if (!isParty(req.user, order)) {
        throw new OrderError('Forbidden: not a party to this order', 403);
      }
      res.json(order);
    } catch (err) {
      next(err);
    }
  });

  app.post('/orders/:id/capture', requireAuth, async (req, res, next) => {
    try {
      const order = orderService.getOrderWithTimeline(req.params.id);
      if (req.user.role !== 'admin' && String(req.user.id) !== String(order.buyer_id)) {
        throw new OrderError('Forbidden: only the buyer can pay for this order', 403);
      }
      res.json(await orderService.captureOrder(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  app.post('/orders/:id/ship', requireAuth, (req, res, next) => {
    try {
      const order = orderService.getOrderWithTimeline(req.params.id);
      if (req.user.role !== 'admin' && String(req.user.id) !== String(order.seller_id)) {
        throw new OrderError('Forbidden: only the seller can mark this order shipped', 403);
      }
      res.json(orderService.shipOrder(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  app.post('/orders/:id/deliver', requireAuth, (req, res, next) => {
    try {
      const order = orderService.getOrderWithTimeline(req.params.id);
      if (req.user.role !== 'admin' && String(req.user.id) !== String(order.seller_id)) {
        throw new OrderError('Forbidden: only the seller can mark this order delivered', 403);
      }
      res.json(orderService.deliverOrder(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  app.post('/orders/:id/confirm', requireAuth, async (req, res, next) => {
    try {
      const order = orderService.getOrderWithTimeline(req.params.id);
      if (req.user.role !== 'admin' && String(req.user.id) !== String(order.buyer_id)) {
        throw new OrderError('Forbidden: only the buyer can confirm receipt of this order', 403);
      }
      res.json(await orderService.confirmOrder(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  app.post('/orders/:id/cancel', requireAuth, async (req, res, next) => {
    try {
      const order = orderService.getOrderWithTimeline(req.params.id);
      const isBuyer = String(req.user.id) === String(order.buyer_id);
      const isSeller = String(req.user.id) === String(order.seller_id);
      if (req.user.role !== 'admin' && !isBuyer && !isSeller) {
        throw new OrderError('Forbidden: only the buyer or seller can cancel this order', 403);
      }
      const cancelledBy = req.user.role === 'admin' ? 'admin' : isBuyer ? 'buyer' : 'seller';
      res.json(await cancelOrder(req.params.id, { cancelledBy }));
    } catch (err) { next(err); }
  });

  app.post('/orders/:id/dispute', requireAuth, (req, res, next) => {
    try {
      const order = orderService.getOrderWithTimeline(req.params.id);
      if (req.user.role !== 'admin' && String(req.user.id) !== String(order.buyer_id)) {
        throw new OrderError('Forbidden: only the buyer can file a dispute on this order', 403);
      }
      const { reason } = req.body;
      res.json(orderService.disputeOrder(req.params.id, reason));
    } catch (err) {
      next(err);
    }
  });

  // ---- internal sync endpoints (called by auth-service and listing-service after create) ----
  app.post('/api/sync/user', requireAuth, (req, res) => {
    const { id, name, email, role, stripe_account_id } = req.body;
    if (!id || !name || !email || !role) {
      return res.status(400).json({ error: 'id, name, email, and role are required' });
    }
    // You can only ever sync your own user record - otherwise any logged-in
    // user could overwrite another user's row (e.g. changing their role).
    if (req.user.role !== 'admin' && String(req.user.id) !== String(id)) {
      return res.status(403).json({ error: 'Forbidden: can only sync your own user record' });
    }
    db.prepare(
      'INSERT OR REPLACE INTO users (id, name, email, role, stripe_account_id) VALUES (?, ?, ?, ?, ?)'
    ).run(id, name, email, role, stripe_account_id || null);
    res.json({ ok: true });
  });

  app.post('/api/sync/listing', requireAuth, (req, res) => {
    const { id, seller_id, title, price_cents } = req.body;
    if (!id || !seller_id || !title || price_cents == null) {
      return res.status(400).json({ error: 'id, seller_id, title, and price_cents are required' });
    }
    // Only the listing's own seller (or an admin) may sync it. Without this,
    // any logged-in buyer could sync a fabricated price/seller for an
    // existing listing id right before buying it (price tampering).
    if (req.user.role !== 'admin' && String(req.user.id) !== String(seller_id)) {
      return res.status(403).json({ error: 'Forbidden: only the listing owner can sync it to escrow' });
    }
    db.prepare(
      'INSERT OR REPLACE INTO listings (id, seller_id, title, price_cents) VALUES (?, ?, ?, ?)'
    ).run(id, seller_id, title, price_cents);
    res.json({ ok: true });
  });

  // ---- reviews ----
  app.post('/orders/:id/review', requireAuth, (req, res, next) => {
    try {
      const order = orderService.getOrderWithTimeline(req.params.id);
      if (order.status !== 'RELEASED') throw new OrderError('Order must be RELEASED to leave a review', 400);
      if (String(req.user.id) !== String(order.buyer_id)) throw new OrderError('Only the buyer can review this order', 403);
      const { rating, body } = req.body;
      const r = Math.round(Number(rating));
      if (!r || r < 1 || r > 5) throw new OrderError('rating must be 1–5', 400);
      if (db.prepare('SELECT id FROM reviews WHERE order_id = ? AND reviewer_id = ?').get(order.id, req.user.id)) {
        throw new OrderError('You have already reviewed this order', 409);
      }
      const result = db.prepare(
        "INSERT INTO reviews (order_id, reviewer_id, reviewee_id, rating, body, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
      ).run(order.id, req.user.id, order.seller_id, r, body ? String(body).trim() || null : null);
      res.status(201).json(db.prepare('SELECT * FROM reviews WHERE id = ?').get(result.lastInsertRowid));
    } catch (err) { next(err); }
  });

  app.get('/orders/:id/review', requireAuth, (req, res, next) => {
    try {
      const order = orderService.getOrderWithTimeline(req.params.id);
      if (!isParty(req.user, order)) throw new OrderError('Forbidden', 403);
      res.json(db.prepare('SELECT * FROM reviews WHERE order_id = ? AND reviewer_id = ?').get(order.id, req.user.id) || null);
    } catch (err) { next(err); }
  });

  // Public — no auth required
  app.get('/users/:userId/reviews', (req, res, next) => {
    try {
      const reviews = db.prepare(
        `SELECT r.id, r.order_id, r.rating, r.body, r.created_at, u.name AS reviewer_name
         FROM reviews r JOIN users u ON u.id = r.reviewer_id
         WHERE r.reviewee_id = ? ORDER BY r.created_at DESC`
      ).all(req.params.userId);
      const count = reviews.length;
      const average_rating = count > 0
        ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / count) * 10) / 10
        : null;
      res.json({ reviews, average_rating, count });
    } catch (err) { next(err); }
  });

  // ---- messages ----
  app.get('/orders/:id/messages', requireAuth, (req, res, next) => {
    try {
      const order = orderService.getOrderWithTimeline(req.params.id);
      if (!isParty(req.user, order)) throw new OrderError('Forbidden', 403);
      const messages = db.prepare(
        `SELECT m.id, m.order_id, m.sender_id, u.name AS sender_name, m.body, m.created_at
         FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.order_id = ? ORDER BY m.created_at ASC`
      ).all(order.id);
      res.json(messages);
    } catch (err) { next(err); }
  });

  app.post('/orders/:id/messages', requireAuth, (req, res, next) => {
    try {
      const order = orderService.getOrderWithTimeline(req.params.id);
      if (!isParty(req.user, order)) throw new OrderError('Forbidden', 403);
      const { body } = req.body;
      if (!body || !String(body).trim()) throw new OrderError('body is required', 400);
      const result = db.prepare(
        "INSERT INTO messages (order_id, sender_id, body, created_at) VALUES (?, ?, ?, datetime('now'))"
      ).run(order.id, req.user.id, String(body).trim());
      const message = db.prepare(
        `SELECT m.id, m.order_id, m.sender_id, u.name AS sender_name, m.body, m.created_at
         FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`
      ).get(result.lastInsertRowid);
      res.status(201).json(message);
    } catch (err) { next(err); }
  });

  // ---- admin ----
  app.post('/admin/orders/:id/resolve', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const { action } = req.body;
      res.json(await orderService.resolveDispute(req.params.id, action));
    } catch (err) {
      next(err);
    }
  });

  app.post('/admin/run-release-check', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      res.json(await runReleaseCheck());
    } catch (err) {
      next(err);
    }
  });

  // ---- error handler ----
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const statusCode = err.statusCode || 500;
    if (statusCode >= 500) {
      console.error(err);
    }
    res.status(statusCode).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

module.exports = { buildApp };

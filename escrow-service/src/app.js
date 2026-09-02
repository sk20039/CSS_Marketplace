'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const pool = require('./db');
const orderService = require('./orderService');
const { runReleaseCheck, cancelOrder } = require('./orderService');
const { runRecovery } = require('./recoveryService');
const { OrderError } = orderService;
const requireAuth = require('./middleware/requireAuth');
const { requireAdmin } = requireAuth;
const { buildHealthRouter } = require('./healthRoutes');
const shippoClient = require('./shippoClient');

function isParty(user, order) {
  return (
    user.role === 'admin' ||
    String(user.id) === String(order.buyer_id) ||
    String(user.id) === String(order.seller_id)
  );
}

function buildApp() {
  const app = express();

  // Railway terminates TLS and proxies through exactly one hop before reaching
  // this service.  Setting trust proxy to 1 tells Express to trust the
  // rightmost entry in X-Forwarded-For as the real client IP (set by Railway's
  // proxy) while ignoring any XFF headers the client prefixed before that entry.
  // This gives rate limiters a per-client IP key and prevents clients from
  // bypassing their own limit by injecting a fake IP prefix in XFF.
  //
  // NOTE: the rate limiters below use Express's in-process memory store.
  // Each service instance maintains its own counters independently — there is
  // no shared counter across multiple Railway replicas.  This is acceptable for
  // the current single-instance deployment.  If horizontal scaling is added
  // later, replace the default store with a shared Redis store.
  app.set('trust proxy', 1);

  const allowedOrigins = (process.env.FRONTEND_ORIGIN || 'http://localhost:3003')
    .split(',').map(o => o.trim());
  // Permanent production domain and team alias (no deployment hash in hostname).
  // Allows: css-marketplace-frontend.vercel.app
  //         css-marketplace-frontend-sk20039s-projects.vercel.app
  const VERCEL_PROD_RE =
    /^https:\/\/css-marketplace-frontend(-sk20039s-projects)?\.vercel\.app$/;
  // Per-commit and per-branch Vercel preview URLs for this project and team.
  // Does not allow *.vercel.app broadly or other teams.
  const VERCEL_PREVIEW_RE =
    /^https:\/\/css-marketplace-frontend-[a-z0-9-]+-sk20039s-projects\.vercel\.app$/;
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      if (VERCEL_PROD_RE.test(origin)) return cb(null, true);
      if (VERCEL_PREVIEW_RE.test(origin)) return cb(null, true);
      cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
  }));
  app.use(express.json({ limit: '100kb' }));

  // Rate limiters — same library and style as auth-service.
  // Limits are configurable via env vars so tests can set lower values.
  // Limiters are created inside buildApp() so each test server starts with
  // a fresh in-memory counter.
  const shippingRatesLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.RATE_LIMIT_SHIPPING_RATES_MAX || 60),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many shipping rate requests from this IP, please try again later' },
  });
  const orderCreateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.RATE_LIMIT_ORDER_CREATE_MAX || 50),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many orders created from this IP, please try again later' },
  });
  const disputeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.RATE_LIMIT_DISPUTE_MAX || 10),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many disputes filed from this IP, please try again later' },
  });
  const messageLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.RATE_LIMIT_MESSAGE_MAX || 30),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many messages sent from this IP, please try again later' },
  });
  const adminResolveLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.RATE_LIMIT_ADMIN_RESOLVE_MAX || 30),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many dispute resolution requests from this IP, please try again later' },
  });
  const adminRecoveryLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.RATE_LIMIT_ADMIN_RECOVERY_MAX || 20),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many recovery requests from this IP, please try again later' },
  });

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

  // ---- shipping rates ----
  // POST /shipping-rates
  // Fetches available carrier rates for a listing given the buyer's ship-to address.
  // Requires buyer auth so unauthenticated clients cannot fish for rates.
  // Each returned rate includes a cryptographic rate_token that binds the rate to
  // this exact (listing, seller ship-from, buyer ship-to, parcel) context.
  // The token is verified on POST /orders before the rate price is accepted.
  app.post('/shipping-rates', shippingRatesLimiter, requireAuth, async (req, res, next) => {
    try {
      const { listing_id, shipping_address } = req.body;
      if (!listing_id) throw new OrderError('listing_id is required', 400);
      const addrError = orderService.validateShippingAddressPublic(shipping_address);
      if (addrError) throw new OrderError(addrError, 422);

      const listing = await orderService.fetchListingPublic(Number(listing_id));

      // Verify package dims — required before rates can be fetched.
      const { weight_oz, pkg_length_in, pkg_width_in, pkg_height_in } = listing;
      const missingDims = [
        !weight_oz     && 'weight_oz',
        !pkg_length_in && 'pkg_length_in',
        !pkg_width_in  && 'pkg_width_in',
        !pkg_height_in && 'pkg_height_in',
      ].filter(Boolean);
      if (missingDims.length > 0) {
        throw new OrderError(
          `Listing ${listing_id} is missing package dimensions required for shipping rate calculation: ${missingDims.join(', ')}. ` +
          'The seller must update this listing with package weight and dimensions before it can be purchased.',
          422
        );
      }

      // Fetch seller's ship-from address from escrow users table.
      const { rows: sellerRows } = await pool.query(
        'SELECT ship_from_address FROM users WHERE id = $1',
        [Number(listing.seller_id)]
      );
      const seller = sellerRows[0];
      if (!seller || !seller.ship_from_address) {
        throw new OrderError(
          'Seller has not set up a ship-from address. Rates cannot be calculated until the seller adds their address.',
          422
        );
      }

      const fromAddr = typeof seller.ship_from_address === 'string'
        ? JSON.parse(seller.ship_from_address)
        : seller.ship_from_address;

      const parcel = {
        weight_oz:    Number(weight_oz),
        length_in:    Number(pkg_length_in),
        width_in:     Number(pkg_width_in),
        height_in:    Number(pkg_height_in),
      };

      const rates = await shippoClient.getRates(
        fromAddr,
        shipping_address,
        parcel,
        Number(listing_id),
        shipping_address
      );

      res.json({ rates, stub: shippoClient.STUB_MODE });
    } catch (err) { next(err); }
  });

  // ---- orders ----
  app.post('/orders', orderCreateLimiter, requireAuth, async (req, res, next) => {
    try {
      const { listing_id, shipping_address, shippo_rate_id, rate_token } = req.body;
      if (!listing_id) throw new OrderError('listing_id is required', 400);
      const order = await orderService.createOrder({
        listingId: listing_id,
        buyerId: req.user.id,
        shippingAddress: shipping_address,
        shippoRateId: shippo_rate_id,
        rateToken: rate_token,
      });
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

  app.post('/orders/:id/dispute', disputeLimiter, requireAuth, async (req, res, next) => {
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

  function requireInternalSecret(req, res, next) {
    const secret = process.env.INTERNAL_SERVICE_SECRET || '';
    if (!secret || req.headers['x-internal-secret'] !== secret) {
      return res.status(401).json({ error: 'Invalid or missing internal service secret' });
    }
    next();
  }

  app.post('/api/sync/ship-from-address', requireInternalSecret, async (req, res, next) => {
    try {
      const { user_id, ship_from_address } = req.body;
      if (!user_id || !ship_from_address) {
        return res.status(400).json({ error: 'user_id and ship_from_address are required' });
      }
      await pool.query(
        `UPDATE users SET ship_from_address = $1 WHERE id = $2`,
        [JSON.stringify(ship_from_address), user_id]
      );
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

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

  app.post('/orders/:id/messages', messageLimiter, requireAuth, async (req, res, next) => {
    try {
      const order = await orderService.getOrderWithTimeline(req.params.id);
      if (!isParty(req.user, order)) throw new OrderError('Forbidden', 403);
      const { body } = req.body;
      const trimmed = body != null ? String(body).trim() : '';
      if (!trimmed) throw new OrderError('Message body is required', 400);
      if (trimmed.length > 2000) throw new OrderError('Message body must not exceed 2,000 characters', 400);
      const { rows: ins } = await pool.query(
        `INSERT INTO messages (order_id, sender_id, body, created_at)
         VALUES ($1, $2, $3, NOW()) RETURNING id`,
        [order.id, req.user.id, trimmed]
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
  app.post('/admin/orders/:id/resolve', adminResolveLimiter, requireAuth, requireAdmin, async (req, res, next) => {
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

  app.post('/admin/run-recovery', adminRecoveryLimiter, requireAuth, requireAdmin, async (req, res, next) => {
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

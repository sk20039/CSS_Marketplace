const path = require('path');
const express = require('express');
const db = require('./db');
const orderService = require('./orderService');
const { runReleaseCheck } = require('./orderService');
const { OrderError } = orderService;

function buildApp() {
  const app = express();
  app.use(express.json());

  // ---- static demo UI ----
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---- helper endpoints for the demo UI (not in the formal API list, but
  // needed so the static pages can populate buyer/listing pickers without a
  // real auth/catalog system - out of scope per the plan's non-goals) ----
  app.get('/api/users', (req, res) => {
    res.json(db.prepare('SELECT id, name, email, role FROM users ORDER BY id').all());
  });

  app.get('/api/listings', (req, res) => {
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
  app.post('/orders', async (req, res, next) => {
    try {
      const { listing_id, buyer_id } = req.body;
      if (!listing_id || !buyer_id) {
        throw new OrderError('listing_id and buyer_id are required', 400);
      }
      const order = await orderService.createOrder({ listingId: listing_id, buyerId: buyer_id });
      res.status(201).json(order);
    } catch (err) {
      next(err);
    }
  });

  app.get('/orders', (req, res, next) => {
    try {
      const { buyer_id, seller_id, status } = req.query;
      let orders = orderService.listOrders({ buyerId: buyer_id, sellerId: seller_id });
      if (status) {
        const wanted = String(status).split(',').map((s) => s.trim().toUpperCase());
        orders = orders.filter((o) => wanted.includes(o.status));
      }
      res.json(orders);
    } catch (err) {
      next(err);
    }
  });

  app.get('/orders/:id', (req, res, next) => {
    try {
      res.json(orderService.getOrderWithTimeline(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  app.post('/orders/:id/capture', async (req, res, next) => {
    try {
      res.json(await orderService.captureOrder(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  app.post('/orders/:id/ship', (req, res, next) => {
    try {
      res.json(orderService.shipOrder(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  app.post('/orders/:id/deliver', (req, res, next) => {
    try {
      res.json(orderService.deliverOrder(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  app.post('/orders/:id/confirm', async (req, res, next) => {
    try {
      res.json(await orderService.confirmOrder(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  app.post('/orders/:id/dispute', (req, res, next) => {
    try {
      const { reason } = req.body;
      res.json(orderService.disputeOrder(req.params.id, reason));
    } catch (err) {
      next(err);
    }
  });

  // ---- admin ----
  app.post('/admin/orders/:id/resolve', async (req, res, next) => {
    try {
      const { action } = req.body;
      res.json(await orderService.resolveDispute(req.params.id, action));
    } catch (err) {
      next(err);
    }
  });

  app.post('/admin/run-release-check', async (req, res, next) => {
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

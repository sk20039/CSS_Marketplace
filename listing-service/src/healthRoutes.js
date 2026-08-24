'use strict';

const express = require('express');

function buildHealthRouter(pool, serviceName) {
  const router = express.Router();

  // Liveness: Node process is up. No DB query.
  router.get('/live', (_req, res) => {
    res.json({ ok: true, service: serviceName });
  });

  // Readiness: Node process is up AND database responds.
  async function readinessCheck(_req, res) {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true, service: serviceName, database: 'connected' });
    } catch {
      res.status(503).json({ ok: false, service: serviceName, database: 'unavailable' });
    }
  }

  router.get('/ready', readinessCheck);
  router.get('/', readinessCheck); // Railway uses GET /health as the default check path

  return router;
}

module.exports = { buildHealthRouter };

const express = require('express');
const cors = require('cors');
const listingRoutes = require('./listingRoutes');
const { photoRouter } = require('./photoRoutes');
const seoRoutes = require('./seoRoutes');
const pool = require('./db');
const { buildHealthRouter } = require('./healthRoutes');

// Allows any per-commit or per-branch Vercel Preview URL for this specific
// project and Vercel team. Does not allow *.vercel.app broadly.
const VERCEL_PREVIEW_RE =
  /^https:\/\/css-marketplace-frontend-[a-z0-9-]+-sk20039s-projects\.vercel\.app$/;

function buildApp() {
  const app = express();
  const allowedOrigins = (process.env.FRONTEND_ORIGIN || 'http://localhost:3003')
    .split(',').map(o => o.trim());
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      if (VERCEL_PREVIEW_RE.test(origin)) return cb(null, true);
      cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
  }));
  app.use(express.json());

  // Health checks — no auth required.
  app.use('/health', buildHealthRouter(pool, 'listing-service'));

  app.use('/listings', listingRoutes);
  app.use('/', photoRouter); // handles POST /listings/:id/photos and GET /photos/:filename
  app.use('/listings', seoRoutes);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const statusCode = err.statusCode || 500;
    if (statusCode >= 500) console.error(err);
    res.status(statusCode).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

module.exports = { buildApp };

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const authRoutes = require('./authRoutes');
const pool = require('./db');
const { buildHealthRouter } = require('./healthRoutes');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again in 15 minutes' },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many accounts created from this IP, please try again in an hour' },
});

const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many token refresh attempts, please try again in 15 minutes' },
});

// Stripe Connect webhook handler.
// Must be defined before buildApp() mounts express.json() so the raw request
// body is preserved — Stripe signature verification requires the exact bytes
// Stripe sent, which express.json() would replace with a parsed JS object.
async function handleStripeWebhook(req, res) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripeKey = process.env.STRIPE_SECRET_KEY;

  // In production the config module prevents startup without these keys, but
  // guard here as defence-in-depth: never silently accept unsigned events.
  if (!webhookSecret || !stripeKey) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[webhook] STRIPE_WEBHOOK_SECRET / STRIPE_SECRET_KEY missing in production');
      return res.status(500).json({ error: 'Webhook verification not configured' });
    }
    return res.json({ received: true, stub: true });
  }

  const sig = req.headers['stripe-signature'];
  // TEMP DIAGNOSTIC — remove after webhook body investigation
  console.log('[webhook-debug] isBuffer:', Buffer.isBuffer(req.body),
    '| typeof:', typeof req.body,
    '| length:', req.body?.length,
    '| content-type:', req.headers['content-type'],
    '| has-sig:', !!sig);
  if (!sig) return res.status(400).json({ error: 'Missing stripe-signature header' });

  let event;
  try {
    const Stripe = require('stripe');
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' });
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('[webhook] Signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook signature error: ${err.message}` });
  }

  if (event.type === 'account.updated') {
    const account = event.data.object;
    const pool = require('./db');
    const { rows } = await pool.query(
      'SELECT id, email FROM users WHERE stripe_account_id = $1',
      [account.id]
    );
    const user = rows[0];
    if (user) {
      console.log(
        `[webhook] account.updated: seller ${user.email} (id=${user.id}) ` +
        `charges_enabled=${account.charges_enabled} payouts_enabled=${account.payouts_enabled}`
      );
    } else {
      console.warn(`[webhook] account.updated for unrecognised account ${account.id}`);
    }
  }

  res.json({ received: true });
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

  // Health checks — no auth, no raw body parsing required.
  app.use('/health', buildHealthRouter(pool, 'auth-service'));

  // Webhook route registered BEFORE express.json() — raw body required for Stripe signature check.
  app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);

  app.use(express.json());
  app.use(cookieParser());

  app.post('/auth/login', loginLimiter);
  app.post('/auth/register', registerLimiter);
  app.post('/auth/refresh', refreshLimiter);
  app.use('/auth', authRoutes);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const statusCode = err.statusCode || 500;
    if (statusCode >= 500) console.error(err);
    res.status(statusCode).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

module.exports = { buildApp };

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const requireAuth = require('./middleware/requireAuth');
const { sendVerificationEmail } = require('./emailer');

const router = express.Router();

const SALT_ROUNDS = 12;
const ACCESS_EXPIRES = '15m';
const REFRESH_BYTES = 32;
const REFRESH_DAYS = 7;

function jwtSecret() {
  return process.env.JWT_SECRET || 'change-me';
}

function issueAccessToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    jwtSecret(),
    { expiresIn: ACCESS_EXPIRES }
  );
}

function setRefreshCookie(res, token) {
  res.cookie('refresh_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: REFRESH_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

async function storeRefreshToken(userId) {
  const raw = crypto.randomBytes(REFRESH_BYTES).toString('hex');
  const hash = await bcrypt.hash(raw, 10);
  const expiresAt = new Date(Date.now() + REFRESH_DAYS * 86400000).toISOString();
  db.prepare(
    "INSERT INTO refresh_tokens (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, datetime('now'))"
  ).run(userId, hash, expiresAt);
  return raw;
}

async function findAndDeleteRefreshToken(raw) {
  const rows = db.prepare("SELECT * FROM refresh_tokens WHERE expires_at > datetime('now')").all();
  for (const row of rows) {
    if (await bcrypt.compare(raw, row.token_hash)) {
      db.prepare('DELETE FROM refresh_tokens WHERE id = ?').run(row.id);
      return row;
    }
  }
  return null;
}

// POST /auth/register
router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, and password are required' });
    }
    const userRole = ['buyer', 'seller'].includes(role) ? role : 'buyer';

    if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = db.prepare(
      "INSERT INTO users (name, email, password_hash, role, email_verified, created_at) VALUES (?, ?, ?, ?, 0, datetime('now'))"
    ).run(name, email, passwordHash, userRole);

    const user = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(result.lastInsertRowid);

    // Generate and store verification token
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(verifyToken).digest('hex');
    const expiresAt = new Date(Date.now() + 24 * 3600000).toISOString();
    db.prepare(
      'INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)'
    ).run(user.id, tokenHash, expiresAt);

    await sendVerificationEmail(user.email, verifyToken);

    res.status(201).json({
      message: 'Registration successful. Please check your email to verify your account before signing in.',
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    next(err);
  }
});

// GET /auth/verify-email?token=...
router.get('/verify-email', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'token is required' });

  const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
  const row = db.prepare(
    "SELECT * FROM email_verification_tokens WHERE token_hash = ? AND expires_at > datetime('now')"
  ).get(tokenHash);

  if (!row) return res.status(400).json({ error: 'Invalid or expired verification link' });

  db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(row.user_id);
  db.prepare('DELETE FROM email_verification_tokens WHERE id = ?').run(row.id);

  res.json({ message: 'Email verified. You can now sign in.' });
});

// POST /auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (!user.email_verified) {
      return res.status(403).json({ error: 'Please verify your email address before signing in. Check your inbox for the verification link.' });
    }

    const raw = await storeRefreshToken(user.id);
    setRefreshCookie(res, raw);
    res.json({
      access_token: issueAccessToken(user),
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/logout
router.post('/logout', async (req, res, next) => {
  try {
    const raw = req.cookies?.refresh_token;
    if (raw) await findAndDeleteRefreshToken(raw);
    res.clearCookie('refresh_token', { path: '/' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /auth/refresh
router.post('/refresh', async (req, res, next) => {
  try {
    const raw = req.cookies?.refresh_token;
    if (!raw) return res.status(401).json({ error: 'No refresh token' });

    const matched = await findAndDeleteRefreshToken(raw);
    if (!matched) return res.status(401).json({ error: 'Invalid or expired refresh token' });

    const user = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(matched.user_id);
    if (!user) return res.status(401).json({ error: 'User not found' });

    // Rotate: issue new refresh token
    const newRaw = await storeRefreshToken(user.id);
    setRefreshCookie(res, newRaw);
    res.json({ access_token: issueAccessToken(user) });
  } catch (err) {
    next(err);
  }
});

// GET /auth/me
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, name, email, role, stripe_account_id, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// POST /auth/sellers/connect
// Creates (or re-opens) a Stripe Express account onboarding link for the seller.
// Returns { url } to redirect the seller to Stripe's hosted onboarding UI.
// Requires STRIPE_SECRET_KEY to be set; returns 503 in stub mode.
router.post('/sellers/connect', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'seller' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only sellers can connect a Stripe account' });
    }
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      return res.status(503).json({
        error: 'Stripe is not configured on this server. Set STRIPE_SECRET_KEY to enable real payouts.',
        stub: true,
      });
    }

    const Stripe = require('stripe');
    const stripe = new Stripe(key, { apiVersion: '2024-06-20' });
    const BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3003';

    const user = db.prepare('SELECT id, email, stripe_account_id FROM users WHERE id = ?').get(req.user.id);

    // Get or create Express account
    let accountId = user.stripe_account_id;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'US',
        email: user.email,
        capabilities: { transfers: { requested: true } },
      });
      accountId = account.id;
      db.prepare('UPDATE users SET stripe_account_id = ? WHERE id = ?').run(accountId, user.id);
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${BASE_URL}/dashboard/seller?stripe_refresh=1`,
      return_url: `${BASE_URL}/dashboard/seller?stripe_return=1`,
      type: 'account_onboarding',
    });

    res.json({ url: accountLink.url });
  } catch (err) {
    next(err);
  }
});

// GET /auth/sellers/connect/status
// Returns the current Stripe Connect account status for the seller.
router.get('/sellers/connect/status', requireAuth, async (req, res, next) => {
  try {
    const key = process.env.STRIPE_SECRET_KEY;
    const user = db.prepare('SELECT stripe_account_id FROM users WHERE id = ?').get(req.user.id);

    if (!key || !user.stripe_account_id) {
      return res.json({ connected: false, charges_enabled: false, details_submitted: false, stub: !key });
    }

    const Stripe = require('stripe');
    const stripe = new Stripe(key, { apiVersion: '2024-06-20' });
    const account = await stripe.accounts.retrieve(user.stripe_account_id);

    res.json({
      connected: true,
      charges_enabled: account.charges_enabled,
      details_submitted: account.details_submitted,
      payouts_enabled: account.payouts_enabled,
      stripe_account_id: user.stripe_account_id,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

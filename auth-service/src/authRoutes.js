const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('./db');
const requireAuth = require('./middleware/requireAuth');
const { sendVerificationEmail, sendPasswordResetEmail } = require('./emailer');

const router = express.Router();

const SALT_ROUNDS = 12;
const ACCESS_EXPIRES = '15m';
const REFRESH_BYTES = 32;
const REFRESH_DAYS = 7;

// US address validation
const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
]);
const ZIP_RE = /^\d{5}(-\d{4})?$/;

function validateShipFromAddress(addr) {
  if (!addr || typeof addr !== 'object') return 'ship_from_address is required';
  if (!addr.name || typeof addr.name !== 'string' || !addr.name.trim()) return 'name is required';
  if (!addr.line1 || typeof addr.line1 !== 'string' || !addr.line1.trim()) return 'line1 is required';
  if (!addr.city  || typeof addr.city  !== 'string' || !addr.city.trim())  return 'city is required';
  if (!addr.state || !US_STATES.has(String(addr.state).toUpperCase())) return 'state must be a valid US state or DC abbreviation';
  if (!addr.zip   || !ZIP_RE.test(String(addr.zip).trim())) return 'zip must be a 5-digit or ZIP+4 US postal code';
  const phone = addr.phone ? String(addr.phone).replace(/\D/g, '') : '';
  if (phone.length < 10) return 'phone must contain at least 10 digits';
  return null;
}

function sanitizeShipFromAddress(addr) {
  return {
    name:    String(addr.name).trim(),
    company: addr.company ? String(addr.company).trim() : null,
    line1:   String(addr.line1).trim(),
    line2:   addr.line2 ? String(addr.line2).trim() : null,
    city:    String(addr.city).trim(),
    state:   String(addr.state).toUpperCase().trim(),
    zip:     String(addr.zip).trim(),
    phone:   String(addr.phone).replace(/\D/g, ''),
  };
}

function syncShipFromToEscrow(userId, shipFromAddress) {
  const escrowUrl = process.env.ESCROW_SERVICE_URL || 'http://localhost:3000';
  const secret = process.env.INTERNAL_SERVICE_SECRET || '';
  fetch(`${escrowUrl}/api/sync/ship-from-address`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-secret': secret,
    },
    body: JSON.stringify({ user_id: userId, ship_from_address: shipFromAddress }),
  }).catch((err) => {
    console.error('[auth] syncShipFromToEscrow failed (non-fatal):', err.message);
  });
}

function requireInternalSecret(req, res, next) {
  const secret = process.env.INTERNAL_SERVICE_SECRET || '';
  if (!secret || req.headers['x-internal-secret'] !== secret) {
    return res.status(401).json({ error: 'Invalid or missing internal service secret' });
  }
  next();
}

function jwtSecret() {
  return process.env.JWT_SECRET || '';
}

function adminJwtSecret() {
  // If ADMIN_JWT_SECRET is set, admin tokens are signed with it so they cannot
  // be accepted by endpoints that only verify against JWT_SECRET, and vice versa.
  // Falls back to JWT_SECRET when ADMIN_JWT_SECRET is not configured (backwards compatible).
  return process.env.ADMIN_JWT_SECRET || jwtSecret();
}

function issueAccessToken(user) {
  const secret = user.role === 'admin' ? adminJwtSecret() : jwtSecret();
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, has_ship_from_address: !!user.ship_from_address },
    secret,
    { expiresIn: ACCESS_EXPIRES }
  );
}

// Returns the base cookie options for the refresh token.
// In production (HTTPS), SameSite=None + Secure allows the cookie to be sent
// on cross-origin fetch requests (credentials: 'include') from the frontend
// hosted on a different domain.  In local development (HTTP), SameSite=Lax
// is correct and Secure must be omitted so the cookie works on plain HTTP.
function refreshCookieOptions() {
  const prod = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    sameSite: prod ? 'none' : 'lax',
    secure: prod,
    path: '/',
  };
}

function setRefreshCookie(res, token) {
  res.cookie('refresh_token', token, {
    ...refreshCookieOptions(),
    maxAge: REFRESH_DAYS * 24 * 60 * 60 * 1000,
  });
}

async function storeRefreshToken(userId) {
  const raw = crypto.randomBytes(REFRESH_BYTES).toString('hex');
  const hash = await bcrypt.hash(raw, 10);
  const expiresAt = new Date(Date.now() + REFRESH_DAYS * 86400000).toISOString();
  await pool.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, hash, expiresAt]
  );
  return raw;
}

async function findAndDeleteRefreshToken(raw) {
  const { rows } = await pool.query('SELECT * FROM refresh_tokens WHERE expires_at > NOW()');
  for (const row of rows) {
    if (await bcrypt.compare(raw, row.token_hash)) {
      await pool.query('DELETE FROM refresh_tokens WHERE id = $1', [row.id]);
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

    const { rows: existing } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing[0]) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const { rows: inserted } = await pool.query(
      'INSERT INTO users (name, email, password_hash, role, email_verified) VALUES ($1, $2, $3, $4, false) RETURNING id',
      [name, email, passwordHash, userRole]
    );
    const userId = inserted[0].id;

    const { rows: userRows } = await pool.query(
      'SELECT id, name, email, role FROM users WHERE id = $1',
      [userId]
    );
    const user = userRows[0];

    // Generate and store verification token
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(verifyToken).digest('hex');
    const expiresAt = new Date(Date.now() + 24 * 3600000).toISOString();
    await pool.query(
      'INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, tokenHash, expiresAt]
    );

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
router.get('/verify-email', async (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'token is required' });

    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const { rows } = await pool.query(
      'SELECT * FROM email_verification_tokens WHERE token_hash = $1 AND expires_at > NOW()',
      [tokenHash]
    );
    if (!rows[0]) return res.status(400).json({ error: 'Invalid or expired verification link' });

    await pool.query('UPDATE users SET email_verified = true WHERE id = $1', [rows[0].user_id]);
    await pool.query('DELETE FROM email_verification_tokens WHERE id = $1', [rows[0].id]);

    res.json({ message: 'Email verified. You can now sign in.' });
  } catch (err) {
    next(err);
  }
});

// POST /auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = rows[0];
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
    res.clearCookie('refresh_token', refreshCookieOptions());
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

    const { rows } = await pool.query(
      'SELECT id, name, email, role, ship_from_address FROM users WHERE id = $1',
      [matched.user_id]
    );
    const user = rows[0];
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
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, role, stripe_account_id, ship_from_address, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
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

    const { rows: userRows } = await pool.query(
      'SELECT id, email, stripe_account_id FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = userRows[0];

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
      await pool.query('UPDATE users SET stripe_account_id = $1 WHERE id = $2', [accountId, user.id]);
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
    const { rows: userRows } = await pool.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = userRows[0];

    if (!key || !user.stripe_account_id) {
      return res.json({ connected: false, charges_enabled: false, details_submitted: false, stub: !key });
    }

    const Stripe = require('stripe');
    const stripe = new Stripe(key, { apiVersion: '2024-06-20' });
    const account = await stripe.accounts.retrieve(user.stripe_account_id);
    const transfersActive = account.capabilities?.transfers === 'active';

    res.json({
      connected: account.charges_enabled && transfersActive,
      charges_enabled: account.charges_enabled,
      details_submitted: account.details_submitted,
      payouts_enabled: account.payouts_enabled,
      transfers_active: transfersActive,
      stripe_account_id: user.stripe_account_id,
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/forgot-password
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });

    // Always return the same message regardless of whether the email exists
    // to prevent account enumeration.
    const genericResponse = {
      message: 'If that email is registered, you will receive a password reset link shortly.',
    };

    const { rows } = await pool.query('SELECT id, email FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (!user) return res.json(genericResponse);

    // Remove any existing unused reset tokens for this user before issuing a new one.
    await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [user.id]);

    const resetToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    await pool.query(
      'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, tokenHash, expiresAt]
    );

    await sendPasswordResetEmail(user.email, resetToken);

    res.json(genericResponse);
  } catch (err) {
    next(err);
  }
});

// POST /auth/reset-password
router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'token and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const { rows } = await pool.query(
      'SELECT * FROM password_reset_tokens WHERE token_hash = $1 AND expires_at > NOW()',
      [tokenHash]
    );
    if (!rows[0]) {
      return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
    }

    const resetRow = rows[0];
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, resetRow.user_id]);
    // Consume the reset token.
    await pool.query('DELETE FROM password_reset_tokens WHERE id = $1', [resetRow.id]);
    // Invalidate all active sessions so any attacker who had the old password
    // cannot stay logged in via a still-valid refresh token.
    await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [resetRow.user_id]);

    res.json({ message: 'Password reset successful. You can now sign in with your new password.' });
  } catch (err) {
    next(err);
  }
});


// POST /auth/resend-verification
router.post('/resend-verification', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });

    // Always return generic response to prevent account enumeration.
    const genericResponse = {
      message: 'If that email is registered and unverified, a new verification link has been sent.',
    };

    const { rows } = await pool.query(
      'SELECT id, email, email_verified FROM users WHERE email = $1',
      [email]
    );
    const user = rows[0];
    // Return generic response for unknown email or already-verified account.
    if (!user || user.email_verified) return res.json(genericResponse);

    // Replace any existing unused token before issuing a fresh one.
    await pool.query('DELETE FROM email_verification_tokens WHERE user_id = $1', [user.id]);

    const verifyToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(verifyToken).digest('hex');
    const expiresAt = new Date(Date.now() + 24 * 3600000).toISOString();

    await pool.query(
      'INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, tokenHash, expiresAt]
    );

    await sendVerificationEmail(user.email, verifyToken);

    res.json(genericResponse);
  } catch (err) {
    next(err);
  }
});

// PUT /auth/address/ship-from
// Sellers save their ship-from address here. Returns a fresh access_token so
// the seller's listing gate (has_ship_from_address claim) takes effect immediately.
router.put('/address/ship-from', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'seller' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only sellers can set a ship-from address' });
    }
    const validationError = validateShipFromAddress(req.body);
    if (validationError) return res.status(422).json({ error: validationError });

    const sanitized = sanitizeShipFromAddress(req.body);
    await pool.query(
      'UPDATE users SET ship_from_address = $1 WHERE id = $2',
      [JSON.stringify(sanitized), req.user.id]
    );

    // Re-fetch to build the updated token
    const { rows } = await pool.query(
      'SELECT id, name, email, role, ship_from_address FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = rows[0];

    // Sync to escrow user mirror (fire-and-forget)
    syncShipFromToEscrow(user.id, sanitized);

    res.json({
      ship_from_address: sanitized,
      access_token: issueAccessToken(user),
    });
  } catch (err) {
    next(err);
  }
});

// GET /auth/internal/seller/:id/has-ship-from
// Internal endpoint for listing-service to check if a seller has a ship-from address.
// Secured with x-internal-secret header. Not needed for the JWT-claim approach but
// provided as a fallback for future service-to-service checks.
router.get('/internal/seller/:id/has-ship-from', requireInternalSecret, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT ship_from_address FROM users WHERE id = $1',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ has_ship_from_address: !!rows[0].ship_from_address });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

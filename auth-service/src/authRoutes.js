const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const requireAuth = require('./middleware/requireAuth');

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
      "INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run(name, email, passwordHash, userRole);

    const user = db.prepare('SELECT id, name, email, role, stripe_account_id, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
    const raw = await storeRefreshToken(user.id);
    setRefreshCookie(res, raw);
    res.status(201).json({
      access_token: issueAccessToken(user),
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    next(err);
  }
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

module.exports = router;

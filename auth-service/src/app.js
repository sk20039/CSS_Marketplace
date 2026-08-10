const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const authRoutes = require('./authRoutes');

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

function buildApp() {
  const app = express();
  app.use(cors({
    origin: process.env.FRONTEND_ORIGIN || 'http://localhost:3003',
    credentials: true,
  }));
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

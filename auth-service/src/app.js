const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const authRoutes = require('./authRoutes');

function buildApp() {
  const app = express();
  app.use(cors({
    origin: process.env.FRONTEND_ORIGIN || 'http://localhost:3003',
    credentials: true,
  }));
  app.use(express.json());
  app.use(cookieParser());

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

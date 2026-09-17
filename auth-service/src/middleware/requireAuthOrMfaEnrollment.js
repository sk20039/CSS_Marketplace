'use strict';
// Middleware used only on MFA enrollment endpoints.
// Accepts either:
//   - A normal access token (any authenticated user enrolling MFA voluntarily)
//   - An mfa_enrollment token (admin forced to enroll before accessing the platform)
// Rejects mfa_pending tokens (those are only accepted by /auth/mfa/verify).
const jwt = require('jsonwebtoken');

function requireAuthOrMfaEnrollment(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = authHeader.slice(7);
  try {
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET || '');
    } catch {
      if (process.env.ADMIN_JWT_SECRET && process.env.ADMIN_JWT_SECRET !== (process.env.JWT_SECRET || '')) {
        payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
      } else {
        throw new Error('token invalid');
      }
    }
    // mfa_pending tokens are only for /auth/mfa/verify — reject them here.
    if (payload.mfa_pending) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.user = { id: payload.sub, email: payload.email, role: payload.role };
    // Flag indicates this session is from a forced enrollment (no prior full access).
    req.mfaEnrollment = !!payload.mfa_enrollment;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = requireAuthOrMfaEnrollment;

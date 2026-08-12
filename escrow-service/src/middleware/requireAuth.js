const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = authHeader.slice(7);
  try {
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET || 'change-me');
    } catch {
      // If ADMIN_JWT_SECRET is set and differs, admin tokens are signed with it — try that too.
      if (process.env.ADMIN_JWT_SECRET && process.env.ADMIN_JWT_SECRET !== (process.env.JWT_SECRET || 'change-me')) {
        payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
      } else {
        throw new Error('token invalid');
      }
    }
    req.user = { id: payload.sub, email: payload.email, role: payload.role };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden: admin role required' });
  }
  // If ADMIN_JWT_SECRET is configured, re-verify the raw token against it.
  // This ensures admin tokens signed with ADMIN_JWT_SECRET in auth-service are
  // the only tokens accepted on admin endpoints — a regular user token (signed
  // with JWT_SECRET only) will fail this secondary check even if role='admin'
  // were somehow embedded in it.
  if (process.env.ADMIN_JWT_SECRET) {
    const authHeader = req.headers.authorization;
    const token = authHeader.slice(7); // header format already validated by requireAuth above
    try {
      jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    } catch {
      return res.status(403).json({ error: 'Admin token invalid' });
    }
  }
  next();
}

module.exports = requireAuth;
module.exports.requireAdmin = requireAdmin;

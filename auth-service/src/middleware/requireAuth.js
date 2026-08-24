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
      payload = jwt.verify(token, process.env.JWT_SECRET || '');
    } catch {
      // Admin tokens may be signed with ADMIN_JWT_SECRET — try that as fallback.
      if (process.env.ADMIN_JWT_SECRET && process.env.ADMIN_JWT_SECRET !== (process.env.JWT_SECRET || '')) {
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

module.exports = requireAuth;

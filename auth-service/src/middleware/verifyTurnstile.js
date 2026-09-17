'use strict';

// Cloudflare's published test secret — short-circuits the network call in
// automated tests. Simulates documented response: { success: true, hostname: 'localhost' }.
const CF_TEST_SECRET = '1x0000000000000000000000000000000AA';

async function verifyTurnstile(req, res, next) {
  const secret = process.env.TURNSTILE_SECRET_KEY;

  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(500).json({ error: 'CAPTCHA not configured' });
    }
    return next(); // local dev bypass
  }

  const rawToken = req.body?.turnstile_token;
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!token) {
    return res.status(400).json({ error: 'CAPTCHA token is required' });
  }

  let data;
  if (secret === CF_TEST_SECRET) {
    data = { success: true, hostname: 'localhost' };
  } else {
    try {
      const cfRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret, response: token, remoteip: req.ip }),
        signal: AbortSignal.timeout(5000),
      });
      data = await cfRes.json();
    } catch (err) {
      console.error('[turnstile] verification request failed:', err.message);
      if (process.env.NODE_ENV === 'production') {
        return res.status(503).json({ error: 'CAPTCHA service unavailable. Please try again shortly.' });
      }
      return next();
    }
  }

  if (!data.success) {
    return res.status(403).json({ error: 'CAPTCHA verification failed. Please try again.' });
  }

  // Hostname validation against server-side allowlist
  const allowedRaw = process.env.TURNSTILE_ALLOWED_HOSTNAME || '';
  const allowedHostnames = allowedRaw.split(',').map(h => h.trim()).filter(Boolean);
  if (allowedHostnames.length > 0 && !allowedHostnames.includes(data.hostname)) {
    console.error(`[turnstile] hostname rejected: "${data.hostname}" not in [${allowedHostnames.join(', ')}]`);
    return res.status(403).json({ error: 'CAPTCHA verification failed.' });
  }

  next();
}

module.exports = { verifyTurnstile };

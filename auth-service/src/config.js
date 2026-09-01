'use strict';
// src/config.js — Production environment validation for auth-service.
//
// Call assertProductionEnv() at process start; the service will refuse to
// start when NODE_ENV=production and any required variable is missing,
// uses a placeholder value, is too short, or uses an insecure URL.
//
// validateProductionEnv(env) is exported as a pure function for unit tests
// so tests can exercise the rules without starting the server or database.

const MIN_SECRET_LENGTH = 32;

// Values that are obviously example/scaffold text and must never reach production.
const PLACEHOLDER_RE = [
  /^change[_-]?me$/i,
  /^changethis$/i,
  /^your[_\-. ]*secret[_\-. ]*here$/i,
  /^placeholder$/i,
  /^example$/i,
  /^todo$/i,
  /^insert[_-]*(secret|key|value|token)/i,
];

function isPlaceholder(value) {
  return PLACEHOLDER_RE.some((re) => re.test(value.trim()));
}

function isLocalhost(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function isHttp(url) {
  try {
    return new URL(url).protocol === 'http:';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pure validation — returns an array of human-readable error strings.
// Accepts an env object so unit tests can inject controlled values.
// ---------------------------------------------------------------------------
function validateProductionEnv(env) {
  const errors = [];

  function need(name) {
    const v = env[name];
    if (!v || !v.trim()) {
      errors.push(`${name}: required in production but not set`);
      return false;
    }
    if (isPlaceholder(v)) {
      errors.push(`${name}: must not be a placeholder value (got "${v.trim()}")`);
      return false;
    }
    return true;
  }

  function needMinLen(name, min) {
    if (!need(name)) return;
    if ((env[name] || '').trim().length < min) {
      errors.push(`${name}: must be at least ${min} characters in production`);
    }
  }

  function needHttpsUrl(name) {
    if (!need(name)) return;
    const v = (env[name] || '').trim();
    if (isLocalhost(v)) {
      errors.push(`${name}: must not use localhost in production`);
    } else if (isHttp(v)) {
      errors.push(`${name}: must use HTTPS in production`);
    }
  }

  // ---- Required variables ----
  need('DATABASE_URL');
  needMinLen('JWT_SECRET', MIN_SECRET_LENGTH);
  needMinLen('ADMIN_JWT_SECRET', MIN_SECRET_LENGTH);
  need('STRIPE_SECRET_KEY');
  need('STRIPE_WEBHOOK_SECRET');
  needHttpsUrl('APP_BASE_URL');
  needHttpsUrl('FRONTEND_ORIGIN');
  // Email is required in production — without it, password reset and email
  // verification links are silently dropped (logged to console only).
  need('RESEND_API_KEY');
  need('EMAIL_FROM');

  return errors;
}

// ---------------------------------------------------------------------------
// Call this once at process startup. No-op outside production.
// ---------------------------------------------------------------------------
function assertProductionEnv() {
  if (process.env.NODE_ENV !== 'production') return;
  const errors = validateProductionEnv(process.env);
  if (errors.length === 0) return;
  console.error('[config] Production startup blocked — fix these environment errors:');
  for (const e of errors) console.error(`  \u2717 ${e}`);
  process.exit(1);
}

module.exports = { validateProductionEnv, assertProductionEnv };

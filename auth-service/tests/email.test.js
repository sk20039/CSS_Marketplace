'use strict';

/**
 * Focused tests for auth-service emailer — reply-to and Resend request shape.
 * Does not require a database or Resend API key.
 * Run: node auth-service/tests/email.test.js  (from repo root)
 *   or: node tests/email.test.js              (from auth-service/)
 */

// Ensure RESEND_API_KEY is set so resendSend() is exercised (not stub-mode).
// Using a fake key that will never hit the real Resend API because fetch is mocked.
process.env.RESEND_API_KEY = 'test-key-not-real';
process.env.APP_BASE_URL   = 'https://www.cricketmarketusa.com';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        console.log(`  ✓  ${name}`);
        passed++;
      }).catch((err) => {
        console.error(`  ✗  ${name}`);
        console.error(`     ${err.message}`);
        failed++;
      });
    }
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
  return Promise.resolve();
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

// ── fetch mock helpers ─────────────────────────────────────────────────────
// Replace global.fetch with a capturer that returns a fake 200 response.

let _capturedRequests = [];

function installFetchMock() {
  _capturedRequests = [];
  global.fetch = async (url, options) => {
    _capturedRequests.push({ url, options });
    return {
      ok: true,
      status: 200,
      text: async () => '{"id":"test-id"}',
    };
  };
}

function installFetchErrorMock(status) {
  _capturedRequests = [];
  global.fetch = async (url, options) => {
    _capturedRequests.push({ url, options });
    return {
      ok: false,
      status,
      text: async () => '{"message":"error"}',
    };
  };
}

function lastBody() {
  const last = _capturedRequests[_capturedRequests.length - 1];
  return last ? JSON.parse(last.options.body) : null;
}

// ── Load emailer (after env setup) ────────────────────────────────────────

// Clear module cache so env vars take effect.
Object.keys(require.cache).forEach((k) => {
  if (k.includes('emailer')) delete require.cache[k];
});
const emailer = require('../src/emailer');

// ── Tests ──────────────────────────────────────────────────────────────────

async function run() {
  // ── reply_to default ───────────────────────────────────────────────────

  console.log('\nreply_to — default value');

  await test('sendVerificationEmail includes reply_to in Resend request body', async () => {
    delete process.env.EMAIL_REPLY_TO;
    installFetchMock();
    await emailer.sendVerificationEmail('user@test.com', 'tok123');
    const body = lastBody();
    assert(body !== null, 'fetch must have been called');
    assert(body.reply_to === 'support@cricketmarketusa.com',
      `expected reply_to=support@cricketmarketusa.com, got: ${body.reply_to}`);
  });

  await test('sendPasswordResetEmail includes reply_to in Resend request body', async () => {
    delete process.env.EMAIL_REPLY_TO;
    installFetchMock();
    await emailer.sendPasswordResetEmail('user@test.com', 'tok456');
    const body = lastBody();
    assert(body !== null, 'fetch must have been called');
    assert(body.reply_to === 'support@cricketmarketusa.com',
      `expected reply_to=support@cricketmarketusa.com, got: ${body.reply_to}`);
  });

  await test('sendMfaRecoveryCodeUsedEmail includes reply_to in Resend request body', async () => {
    delete process.env.EMAIL_REPLY_TO;
    installFetchMock();
    await emailer.sendMfaRecoveryCodeUsedEmail('user@test.com');
    const body = lastBody();
    assert(body !== null, 'fetch must have been called');
    assert(body.reply_to === 'support@cricketmarketusa.com',
      `expected reply_to=support@cricketmarketusa.com, got: ${body.reply_to}`);
  });

  // ── reply_to override ──────────────────────────────────────────────────

  console.log('\nreply_to — EMAIL_REPLY_TO override');

  await test('EMAIL_REPLY_TO env var overrides default reply_to', async () => {
    process.env.EMAIL_REPLY_TO = 'custom-reply@cricketmarketusa.com';
    installFetchMock();
    await emailer.sendVerificationEmail('user@test.com', 'tok789');
    const body = lastBody();
    assert(body.reply_to === 'custom-reply@cricketmarketusa.com',
      `expected overridden reply_to, got: ${body.reply_to}`);
    delete process.env.EMAIL_REPLY_TO;
  });

  // ── request shape ──────────────────────────────────────────────────────

  console.log('\nResend request shape');

  await test('sendVerificationEmail sends to correct recipient', async () => {
    delete process.env.EMAIL_REPLY_TO;
    installFetchMock();
    await emailer.sendVerificationEmail('verify@example.com', 'abc');
    const body = lastBody();
    assert(body.to === 'verify@example.com',
      `expected to=verify@example.com, got: ${body.to}`);
  });

  await test('sendVerificationEmail includes verification link in text body', async () => {
    installFetchMock();
    await emailer.sendVerificationEmail('u@t.com', 'mytoken');
    const body = lastBody();
    assert(body.text.includes('mytoken'), 'text body must contain the token link');
    assert(body.html.includes('mytoken'), 'html body must contain the token link');
  });

  await test('sendPasswordResetEmail includes reset link in text body', async () => {
    installFetchMock();
    await emailer.sendPasswordResetEmail('u@t.com', 'resettoken');
    const body = lastBody();
    assert(body.text.includes('resettoken'), 'text must contain reset token link');
  });

  await test('sendVerificationEmail does not include password or secrets', async () => {
    installFetchMock();
    await emailer.sendVerificationEmail('u@t.com', 'tok');
    const raw = JSON.stringify(lastBody());
    assert(!raw.toLowerCase().includes('password'), 'must not include password');
    assert(!raw.includes(process.env.RESEND_API_KEY || ''), 'must not include API key');
  });

  // ── stub mode (no RESEND_API_KEY) ─────────────────────────────────────

  console.log('\nstub mode (no RESEND_API_KEY)');

  await test('stub mode does not call fetch when RESEND_API_KEY is absent', async () => {
    const savedKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    installFetchMock();
    await emailer.sendVerificationEmail('u@t.com', 'tok');
    assert(_capturedRequests.length === 0, 'fetch must NOT be called in stub mode');
    process.env.RESEND_API_KEY = savedKey;
  });

  // ── summary ────────────────────────────────────────────────────────────

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});

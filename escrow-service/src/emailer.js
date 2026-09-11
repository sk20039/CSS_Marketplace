const nodemailer = require('nodemailer');

const FROM = process.env.EMAIL_FROM || 'noreply@cricket.test';

function createTransport() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

const transport = createTransport();

// In stub mode (no SMTP_HOST), all sent emails are recorded here so tests can inspect them.
const _capturedEmails = [];

async function sendEmail({ to, subject, text }) {
  if (!transport) {
    _capturedEmails.push({ to, subject, text });
    console.log(`[EMAIL STUB] To: ${to}`);
    console.log(`[EMAIL STUB] Subject: ${subject}`);
    console.log(`[EMAIL STUB] ${text.split('\n')[0]}`);
    return;
  }
  await transport.sendMail({ from: FROM, to, subject, text });
}

function _clearCaptured() { _capturedEmails.length = 0; }
function _getCaptured()   { return [..._capturedEmails]; }

module.exports = { sendEmail, _clearCaptured, _getCaptured };

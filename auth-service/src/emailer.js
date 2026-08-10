const nodemailer = require('nodemailer');

// APP_BASE_URL is the frontend origin — the verify-email page lives there.
const BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3003';
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

async function sendVerificationEmail(email, token) {
  const link = `${BASE_URL}/verify-email?token=${token}`;
  if (!transport) {
    console.log(`[EMAIL STUB] Verification email → ${email}`);
    console.log(`[EMAIL STUB] Link: ${link}`);
    return;
  }
  await transport.sendMail({
    from: FROM,
    to: email,
    subject: 'Verify your USA Cricket Marketplace account',
    text: `Click the link below to verify your email address:\n\n${link}\n\nThis link expires in 24 hours.`,
    html: `<p>Click the link below to verify your email address:</p>
           <p><a href="${link}">${link}</a></p>
           <p>This link expires in 24 hours.</p>`,
  });
}

module.exports = { sendVerificationEmail };

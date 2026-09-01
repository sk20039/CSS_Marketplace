// APP_BASE_URL is the frontend origin — the verify-email page lives there.
const BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3003';
const FROM = process.env.EMAIL_FROM || 'noreply@cricket.test';

// Send one email via the Resend HTTPS API.
// Throws if the API returns a non-2xx status so callers can surface the error.
async function resendSend({ to, subject, text, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to, subject, text, html }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}

async function sendVerificationEmail(email, token) {
  const link = `${BASE_URL}/verify-email?token=${token}`;
  if (!process.env.RESEND_API_KEY) {
    console.log(`[EMAIL STUB] Verification email → ${email}`);
    console.log(`[EMAIL STUB] Link: ${link}`);
    return;
  }
  await resendSend({
    to: email,
    subject: 'Verify your USA Cricket Marketplace account',
    text: `Click the link below to verify your email address:\n\n${link}\n\nThis link expires in 24 hours.`,
    html: `<p>Click the link below to verify your email address:</p>
           <p><a href="${link}">${link}</a></p>
           <p>This link expires in 24 hours.</p>`,
  });
}

async function sendPasswordResetEmail(email, token) {
  const link = `${BASE_URL}/reset-password?token=${token}`;
  if (!process.env.RESEND_API_KEY) {
    console.log(`[EMAIL STUB] Password reset email → ${email}`);
    console.log(`[EMAIL STUB] Link: ${link}`);
    return;
  }
  await resendSend({
    to: email,
    subject: 'Reset your Cricket Market USA password',
    text: `You requested a password reset for your Cricket Market USA account.\n\nClick the link below to set a new password:\n\n${link}\n\nThis link expires in 1 hour. If you did not request this, you can safely ignore this email — your password will not change.`,
    html: `<p>You requested a password reset for your Cricket Market USA account.</p>
           <p>Click the link below to set a new password:</p>
           <p><a href="${link}">${link}</a></p>
           <p>This link expires in 1 hour. If you did not request this, you can safely ignore this email — your password will not change.</p>`,
  });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail };

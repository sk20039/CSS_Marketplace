// APP_BASE_URL is the frontend origin — the verify-email page lives there.
const BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3003';
const FROM = process.env.EMAIL_FROM || 'noreply@cricket.test';

// Send one email via the Resend HTTPS API.
// Throws if the API returns a non-2xx status so callers can surface the error.
async function resendSend({ to, subject, text, html }) {
  const replyTo = process.env.EMAIL_REPLY_TO || 'support@cricketmarketusa.com';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to, subject, text, html, reply_to: replyTo }),
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

async function sendMfaRecoveryCodeUsedEmail(email) {
  const msg =
    'A recovery code was used to sign in to your Cricket Market USA account. ' +
    'If this was not you, please sign in immediately and disable MFA under Settings › Security to revoke all recovery codes.';
  if (!process.env.RESEND_API_KEY) {
    console.log(`[EMAIL STUB] MFA recovery code used → ${email}`);
    return;
  }
  await resendSend({
    to: email,
    subject: 'Security alert: recovery code used on your account',
    text: msg,
    html: `<p>${msg}</p>`,
  });
}

async function sendOtpEmail(email, code) {
  const msg =
    `Your Cricket Market USA verification code is: ${code}\n\n` +
    `This code expires in 15 minutes. If you did not request this, you can safely ignore this email.`;
  if (!process.env.RESEND_API_KEY) {
    // Log the destination only — never log the code itself
    console.log(`[EMAIL STUB] OTP email → ${email} (set RESEND_API_KEY to send for real)`);
    return;
  }
  await resendSend({
    to: email,
    subject: `${code} — your Cricket Market USA verification code`,
    text: msg,
    html: `<p style="font-size:32px;font-weight:bold;letter-spacing:8px;">${code}</p>
           <p>Enter this code to continue checking out on Cricket Market USA.</p>
           <p>This code expires in 15 minutes. If you did not request this, you can safely ignore this email.</p>`,
  });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail, sendMfaRecoveryCodeUsedEmail, sendOtpEmail };

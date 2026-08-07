const axios = require('axios');

// Real transactional email via Resend (resend.com) - free for 3,000
// emails/month, which comfortably covers password resets and signup
// verification for a small-to-mid WiFi business.
//
// HONEST LIMIT: sending to real customers (not just your own Resend
// account email) requires verifying a domain you own in Resend's
// dashboard (a couple of DNS records). Without that, Resend will only
// deliver to the email address you signed up with - fine for testing,
// not for real customers.
//
// If RESEND_API_KEY isn't set, this falls back to logging the link to the
// console instead of crashing - useful for local development before you've
// set up Resend, but NOT something to rely on for real users.
const resend = axios.create({
  baseURL: 'https://api.resend.com',
  headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
});

async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[EMAIL STUB - no RESEND_API_KEY set] To: ${to} | Subject: ${subject}`);
    console.log(html);
    return;
  }

  await resend.post('/emails', {
    from: process.env.EMAIL_FROM || 'YourNet Control <onboarding@resend.dev>',
    to: [to],
    subject,
    html,
  });
}

async function sendPasswordResetEmail(toEmail, resetLink) {
  await sendEmail({
    to: toEmail,
    subject: 'Reset your YourNet Control password',
    html: `
      <p>Someone requested a password reset for your YourNet Control account.</p>
      <p><a href="${resetLink}">Click here to reset your password</a> (expires in 30 minutes).</p>
      <p>If you didn't request this, you can safely ignore this email.</p>
    `,
  });
}

async function sendVerificationEmail(toEmail, verifyLink) {
  await sendEmail({
    to: toEmail,
    subject: 'Verify your YourNet Control account',
    html: `
      <p>Welcome to YourNet Control.</p>
      <p><a href="${verifyLink}">Click here to verify your email address</a>.</p>
    `,
  });
}

module.exports = { sendPasswordResetEmail, sendVerificationEmail };

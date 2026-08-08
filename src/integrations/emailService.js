const axios = require('axios');

// Real transactional email via Brevo (brevo.com) - free for 300
// emails/day. Sends over HTTPS, not raw SMTP - this matters because
// Render (and many hosts) block outbound SMTP ports to prevent abuse,
// which is why Gmail SMTP timed out no matter which port we tried.
//
// HONEST LIMITS:
// - Requires verifying the sender email address in Brevo's dashboard
//   (click a confirmation link - no domain or DNS needed, unlike Resend).
// - Free tier caps at 300 emails/day - plenty for testing and early
//   real usage, not for large-scale sending.
// - Sends from whatever address you verified in Brevo (e.g. your Gmail),
//   not a branded "yournet.net" address - a polish limit, not a
//   delivery one.
//
// When there's revenue to justify ~$10-15/year for a real domain, you
// can verify a domain in Brevo (or swap to Resend) for branded
// "no-reply@yournet.net" sending - the sendEmail/sendPasswordResetEmail/
// sendVerificationEmail function signatures below won't need to change.
//
// If BREVO_API_KEY isn't set, this falls back to logging the link to the
// console instead of crashing - useful for local development, but NOT
// something to rely on for real users.
const brevo = axios.create({
  baseURL: 'https://api.brevo.com/v3',
  headers: {
    'api-key': process.env.BREVO_API_KEY,
    'Content-Type': 'application/json',
  },
});

async function sendEmail({ to, subject, html }) {
  if (!process.env.BREVO_API_KEY) {
    console.log(`[EMAIL STUB - no BREVO_API_KEY set] To: ${to} | Subject: ${subject}`);
    console.log(html);
    return;
  }

  try {
    await brevo.post('/smtp/email', {
      sender: {
        name: 'YourNet Control',
        email: process.env.EMAIL_FROM_ADDRESS,
      },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    });
  } catch (err) {
    console.error(JSON.stringify({
      time: new Date().toISOString(),
      level: 'error',
      message: 'Email failed to send',
      email: to,
      error: err.response?.data?.message || err.message,
    }));
    throw err;
  }
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
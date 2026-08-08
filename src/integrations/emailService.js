const nodemailer = require('nodemailer');

// Real transactional email via Gmail SMTP - free, no domain required.
//
// HONEST LIMITS:
// - Sends from your own Gmail address (e.g. yournet.control@gmail.com),
//   not a branded "yournet.net" address - fine for now, less polished
//   than a real domain.
// - Gmail's free sending cap is ~500 emails/day, which is plenty for
//   testing and early real usage but won't scale to a large customer base.
// - Requires a Gmail "App Password" (NOT your normal Gmail password) -
//   generate one at https://myaccount.google.com/apppasswords (needs
//   2-Step Verification enabled on the Google account first).
// - Uses an explicit host/port (465, SSL) instead of the 'service: gmail'
//   shorthand, since some hosts (Render included) can behave differently
//   depending on which port/method is used to reach Gmail's SMTP servers.
//
// When there's revenue to justify ~$10-15/year for a real domain, swap
// this back to Resend (or similar) + a verified domain for branded
// "no-reply@yournet.net" sending - the sendEmail/sendPasswordResetEmail/
// sendVerificationEmail function signatures below won't need to change.
//
// If GMAIL_USER / GMAIL_APP_PASSWORD aren't set, this falls back to
// logging the link to the console instead of crashing - useful for local
// development, but NOT something to rely on for real users.
let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
  }
  return transporter;
}

async function sendEmail({ to, subject, html }) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.log(`[EMAIL STUB - no GMAIL_USER/GMAIL_APP_PASSWORD set] To: ${to} | Subject: ${subject}`);
    console.log(html);
    return;
  }

  try {
    await getTransporter().sendMail({
      from: process.env.EMAIL_FROM || `YourNet Control <${process.env.GMAIL_USER}>`,
      to,
      subject,
      html,
    });
  } catch (err) {
    console.error(JSON.stringify({
      time: new Date().toISOString(),
      level: 'error',
      message: 'Email failed to send',
      email: to,
      error: err.message,
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
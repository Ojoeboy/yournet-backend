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
      // Render's containers resolve smtp.gmail.com to an IPv6 address by
      // default, and that connection often hangs until it times out -
      // this is what produced the "Connection timeout" error. Forcing
      // IPv4 here is the fix; the 'service: gmail' shorthand this
      // replaced didn't expose a way to set this.
      family: 4,
      connectionTimeout: 15000,
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
    const info = await getTransporter().sendMail({
      from: process.env.EMAIL_FROM || `YourNet Control <${process.env.GMAIL_USER}>`,
      to,
      subject,
      html,
    });
    console.log(`[EMAIL SENT] To: ${to} | Subject: ${subject} | messageId: ${info.messageId} | response: ${info.response}`);
  } catch (err) {
    // Surface the real SMTP failure reason (bad auth, revoked app password,
    // Gmail rate limit, etc.) instead of letting callers' .catch(()=>{})
    // swallow it into total silence.
    console.error(`[EMAIL FAILED] To: ${to} | Subject: ${subject} | error: ${err.message}`);
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

// Sent once, right after an owner/manager creates an agent account (see
// routes/agents.js POST /). Includes the password in plaintext ONLY
// because this is the one moment it exists outside its bcrypt hash - the
// owner already sees it the same way, once, in the creation response
// (see the tempPassword comment there). Password reset emails never do
// this; this one has to, since there's no separate "invite link" flow
// for agents yet, just direct email+password login.
async function sendAgentWelcomeEmail(toEmail, { agentName, businessName, password, isTempPassword, loginUrl }) {
  await sendEmail({
    to: toEmail,
    subject: `You've been added as an agent for ${businessName}`,
    html: `
      <p>Hi ${agentName},</p>
      <p>${businessName} has added you as an agent on YourNet Control. You can log in to generate and track your own vouchers.</p>
      <p><a href="${loginUrl}">${loginUrl}</a></p>
      <p><strong>Email:</strong> ${toEmail}<br>
      <strong>${isTempPassword ? 'Temporary password' : 'Password'}:</strong> ${password}</p>
      ${isTempPassword ? '<p>Please log in and change this password as soon as possible.</p>' : ''}
      <p>If you weren't expecting this, you can ignore this email.</p>
    `,
  });
}

module.exports = { sendPasswordResetEmail, sendVerificationEmail, sendAgentWelcomeEmail };

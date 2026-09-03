const axios = require('axios');

// Real transactional email via Brevo's HTTP API - the same account and
// sender already verified and working for license-key emails in
// integrations/brevo.js. Reuses BREVO_API_KEY and BREVO_SENDER_EMAIL /
// EMAIL_FROM_ADDRESS, whichever is already set - nothing new to sign up
// for or verify.
//
// WHY NOT SMTP (Gmail or otherwise): Render blocks outbound SMTP ports
// on its containers as an anti-spam measure. Every attempt to connect to
// smtp.gmail.com - port 465, port 587, forcing IPv4 - failed with the
// same "Connection timeout", because the port itself never opens, not
// because of DNS/routing. HTTP APIs (port 443, same as any normal web
// request) aren't affected, which is why this uses one instead.
//
// WHY NOT RESEND: Resend's free tier only lets you send FROM a domain
// you've verified with them (DNS records) - without one, it refuses to
// send to anyone but the account owner's own inbox ("You can only send
// testing emails to your own email address"). This project doesn't have
// a domain yet, so Brevo (verify a single sender address, no DNS needed)
// is the practical option until there is one.
//
// If BREVO_API_KEY or a sender email isn't set, this falls back to
// logging the email content to the console instead of crashing - useful
// for local dev, not something to rely on for real users.
function senderEmail() {
  return process.env.BREVO_SENDER_EMAIL || process.env.EMAIL_FROM_ADDRESS;
}

async function sendEmail({ to, subject, html }) {
  const from = senderEmail();
  if (!process.env.BREVO_API_KEY || !from) {
    console.log(`[EMAIL STUB - BREVO_API_KEY/sender email not set] To: ${to} | Subject: ${subject}`);
    console.log(html);
    return;
  }

  try {
    await axios.post(
      'https://api.brevo.com/v3/smtp/email',
      {
        sender: { email: from, name: process.env.BREVO_SENDER_NAME || 'YourNet Control' },
        to: [{ email: to }],
        subject,
        htmlContent: html,
      },
      { headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' } }
    );
    console.log(`[EMAIL SENT] To: ${to} | Subject: ${subject}`);
  } catch (err) {
    // Surface the real failure reason (bad API key, unverified sender,
    // rate limit, etc.) instead of letting callers' .catch(()=>{})
    // swallow it into total silence.
    const detail = err.response?.data?.message || err.message;
    console.error(`[EMAIL FAILED] To: ${to} | Subject: ${subject} | error: ${detail}`);
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

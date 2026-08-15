// Real transactional email via Resend's HTTP API.
//
// WHY NOT SMTP (Gmail or otherwise): Render blocks outbound SMTP ports
// on its containers as an anti-spam measure. Every attempt to connect to
// smtp.gmail.com - port 465, port 587, forcing IPv4 - failed with the
// same "Connection timeout", because the port itself never opens, not
// because of DNS/routing. HTTP APIs (port 443, same as any normal web
// request) aren't affected, which is why this uses one instead.
//
// SETUP: sign up free at https://resend.com (100 emails/day free tier,
// no credit card), grab an API key from the dashboard, and set it as
// RESEND_API_KEY in Render's Environment tab.
//
// HONEST LIMITS:
// - Resend's free tier only lets you send FROM a domain you've verified
//   with them (adding a couple DNS TXT/CNAME records) - it does NOT let
//   you send from an arbitrary Gmail address the way SMTP did. Until a
//   domain is verified, use Resend's shared sandbox sender
//   'onboarding@resend.dev' via EMAIL_FROM (received emails will show
//   that address, not a branded one).
// - If RESEND_API_KEY isn't set, this falls back to logging the email
//   content to the console instead of crashing - useful for local dev,
//   not something to rely on for real users.
async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[EMAIL STUB - no RESEND_API_KEY set] To: ${to} | Subject: ${subject}`);
    console.log(html);
    return;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'YourNet Control <onboarding@resend.dev>',
        to,
        subject,
        html,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Resend ${res.status}: ${data.message || JSON.stringify(data)}`);
    }
    console.log(`[EMAIL SENT] To: ${to} | Subject: ${subject} | id: ${data.id}`);
  } catch (err) {
    // Surface the real failure reason (bad API key, unverified domain,
    // rate limit, etc.) instead of letting callers' .catch(()=>{})
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

const axios = require('axios');

// Brevo (formerly Sendinblue) transactional email, used specifically for
// license key delivery from /license-admin - separate from the Gmail SMTP
// integration in emailService.js, which handles account verification and
// password reset. Docs: https://developers.brevo.com/reference/sendtransacemail
//
// Sender address: reads BREVO_SENDER_EMAIL first, falling back to
// EMAIL_FROM_ADDRESS if that's what you've already got set for another
// part of your deployment - either name works, no need to duplicate it.
//
// If BREVO_API_KEY isn't set, this falls back to logging the key to the
// console instead of crashing - useful for local development, but the
// owner should treat "not configured" as "email was not actually sent"
// (the license-admin page surfaces this rather than pretending it worked).

function senderEmail() {
  return process.env.BREVO_SENDER_EMAIL || process.env.EMAIL_FROM_ADDRESS;
}

async function sendLicenseKeyEmail(toEmail, keyCode) {
  const from = senderEmail();
  if (!process.env.BREVO_API_KEY || !from) {
    console.log(`[BREVO STUB - BREVO_API_KEY/sender email not set] To: ${toEmail} | Key: ${keyCode}`);
    return { sent: false, reason: 'Brevo is not configured (BREVO_API_KEY and BREVO_SENDER_EMAIL or EMAIL_FROM_ADDRESS are required in .env).' };
  }

  await axios.post(
    'https://api.brevo.com/v3/smtp/email',
    {
      sender: {
        email: from,
        name: process.env.BREVO_SENDER_NAME || 'YourNet Control',
      },
      to: [{ email: toEmail }],
      subject: 'Your YourNet Control activation key',
      htmlContent: `
        <p>Here is your YourNet Control activation key:</p>
        <p style="font-family:monospace;font-size:20px;font-weight:700">${keyCode}</p>
        <p>Save this - you'll need it once, during signup at /admin. It cannot be reused for a second business.</p>
      `,
    },
    { headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' } }
  );

  return { sent: true };
}

module.exports = { sendLicenseKeyEmail };

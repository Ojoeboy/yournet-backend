const axios = require('axios');
const logger = require('../utils/logger');

// Real SMS via Arkesel (arkesel.com) - Ghana-built, direct connections to
// MTN, Telecel, and AirtelTigo. Free to create an account; the SMS credits
// themselves cost money (topped up via MoMo or card) - same honest pattern
// as Resend for email: nothing here works until you sign up and configure
// ARKESEL_API_KEY, and a Sender ID needs approval from Arkesel before it
// shows your business name instead of a generic one.
//
// If ARKESEL_API_KEY isn't set, this falls back to logging instead of
// crashing - useful for local development, not something to rely on for
// real customers.
const arkesel = axios.create({
  baseURL: 'https://sms.arkesel.com/api/v2',
  headers: { 'api-key': process.env.ARKESEL_API_KEY },
});

async function sendSms(toPhone, message) {
  if (!process.env.ARKESEL_API_KEY) {
    logger.warn('[SMS STUB - no ARKESEL_API_KEY set]', { to: toPhone, message });
    return;
  }

  try {
    await arkesel.post('/sms/send', {
      sender: process.env.SMS_SENDER_ID || 'YourNet',
      message,
      recipients: [toPhone],
    });
  } catch (err) {
    // SMS failing shouldn't crash whatever triggered it (e.g. approving a
    // MoMo claim still succeeds even if the SMS notification fails) - log
    // and move on rather than throw.
    logger.error('SMS send failed', { to: toPhone, message: err.message });
  }
}

async function sendLicenseKeySms(toPhone, keyCode) {
  await sendSms(toPhone, `Your YourNet Control activation key: ${keyCode}. Keep this safe - enter it once at signup.`);
}

module.exports = { sendSms, sendLicenseKeySms };

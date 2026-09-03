const axios = require('axios');

// Hubtel Online Checkout API (businessdocs-developers.hubtel.com). Unlike
// Paystack, Hubtel authenticates with HTTP Basic Auth built from your
// Client ID and Client Secret (found on the Hubtel dashboard), and needs
// your Merchant Account Number (also from the dashboard) on every request.
//
// HONEST NOTE ON VERIFICATION: Hubtel's primary confirmation path is a
// webhook - it POSTs the transaction result to the callbackUrl you provide
// at checkout time, rather than you polling a "verify" endpoint the way
// Paystack works. The webhook handler in routes/portal.js logs the raw
// payload it receives so you can confirm the exact field names against
// your live Hubtel dashboard before fully trusting this in production -
// Hubtel's documented payload shape is used here, but payment webhook
// formats are exactly the kind of detail worth double-checking against
// your own real account before real money depends on it.

function authHeader(clientId, clientSecret) {
  const token = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  return `Basic ${token}`;
}

async function initializePayment({ clientId, clientSecret, merchantAccountNumber, amountGHS, reference, callbackUrl, returnUrl, description }) {
  const res = await axios.post(
    'https://payproxyapi.hubtel.com/items/initiate',
    {
      totalAmount: amountGHS,
      description: description || 'YourNet Control voucher',
      callbackUrl,
      returnUrl,
      merchantAccountNumber,
      cancellationUrl: returnUrl,
      clientReference: reference,
    },
    { headers: { Authorization: authHeader(clientId, clientSecret), 'Content-Type': 'application/json' } }
  );
  return {
    checkoutUrl: res.data.data.checkoutUrl,
    reference,
  };
}

// Called from the webhook handler once Hubtel POSTs a result - this
// function just interprets the payload, it doesn't make an extra API call
// (unlike Paystack/Flutterwave's verify-by-reference pattern).
function interpretWebhook(payload) {
  const status = payload?.Status || payload?.status || payload?.data?.status;
  const success = String(status).toLowerCase() === 'success' || String(status).toLowerCase() === 'paid';
  return {
    success,
    reference: payload?.ClientReference || payload?.clientReference || payload?.data?.clientReference,
    raw: payload,
  };
}

module.exports = { initializePayment, interpretWebhook };

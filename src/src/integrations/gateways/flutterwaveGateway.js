const axios = require('axios');

// Flutterwave v3 Standard Checkout (developer.flutterwave.com). v3 is the
// stable production API as of early 2026; Flutterwave has a v4 in beta,
// but v3 remains the documented default for new integrations.

// currency defaults to 'GHS' for backward compatibility. Flutterwave
// supports a much wider currency list than Paystack, but still only what's
// enabled on the merchant's own account - an unsupported currency fails at
// Flutterwave's end, surfaced as-is to the caller.
async function initializePayment({ secretKey, email, phone, amountGHS, currency, reference, redirectUrl, title }) {
  const res = await axios.post(
    'https://api.flutterwave.com/v3/payments',
    {
      tx_ref: reference,
      amount: amountGHS,
      currency: currency || 'GHS',
      redirect_url: redirectUrl,
      customer: { email, phonenumber: phone },
      customizations: { title: title || 'YourNet Control' },
    },
    { headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' } }
  );
  return {
    checkoutUrl: res.data.data.link,
    reference,
  };
}

async function verifyPayment({ secretKey, transactionId }) {
  const res = await axios.get(`https://api.flutterwave.com/v3/transactions/${transactionId}/verify`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const success = res.data.data.status === 'successful';
  return {
    success,
    amountGHS: res.data.data.amount,
    customerEmail: res.data.data.customer?.email,
    reference: res.data.data.tx_ref,
    raw: res.data.data,
  };
}

module.exports = { initializePayment, verifyPayment };

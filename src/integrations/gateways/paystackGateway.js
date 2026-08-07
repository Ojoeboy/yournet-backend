const axios = require('axios');

// Same Paystack API as integrations/billing.js, but this version accepts
// credentials explicitly per call - it can run with the PLATFORM's own
// Paystack keys (license/subscription payments) or a TENANT's own linked
// Paystack account (their customers paying them directly), depending on
// which credentials get passed in.

async function initializePayment({ secretKey, email, amountGHS, reference, callbackUrl, metadata }) {
  const res = await axios.post(
    'https://api.paystack.co/transaction/initialize',
    {
      email,
      amount: Math.round(amountGHS * 100),
      currency: 'GHS',
      reference,
      callback_url: callbackUrl,
      metadata,
    },
    { headers: { Authorization: `Bearer ${secretKey}` } }
  );
  return {
    checkoutUrl: res.data.data.authorization_url,
    reference: res.data.data.reference,
  };
}

async function verifyPayment({ secretKey, reference }) {
  const res = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const success = res.data.data.status === 'success';
  return {
    success,
    amountGHS: res.data.data.amount / 100,
    customerEmail: res.data.data.customer?.email,
    raw: res.data.data,
  };
}

module.exports = { initializePayment, verifyPayment };

// Paystack handles cards AND Mobile Money (MTN, Vodafone, AirtelTigo) which
// matters a lot for a Ghana-market product - most kiosk owners will pay
// their own subscription via MoMo, not a card.

const axios = require('axios');

const paystack = axios.create({
  baseURL: 'https://api.paystack.co',
  headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
});

// Subscription plans for THIS SaaS (what a WiFi owner pays to use YourNet
// Control itself) - separate from the voucher packages they sell to their
// own customers. Adjust prices freely; this is just a starting point.
const PLANS = {
  starter: { label: 'Starter', priceGHS: 50, days: 30 },
  // 4 months (120 days) for GHS 180 - a bulk discount vs. paying Starter
  // four separate times (GHS 200), not a different feature tier. See
  // routes/billing.js for the "no accidental collision with the /license
  // auto-renewal cron" and "early payment doesn't lose days" fixes that
  // make a multi-month purchase like this safe.
  pro: { label: 'Pro', priceGHS: 180, days: 120 },
};

async function initializePayment({ email, amountGHS, tenantId, planCode, callbackPath }) {
  const res = await paystack.post('/transaction/initialize', {
    email,
    amount: Math.round(amountGHS * 100), // Paystack uses pesewas/kobo
    currency: 'GHS',
    metadata: { tenantId, planCode },
    callback_url: `${process.env.APP_BASE_URL}${callbackPath || '/billing/callback'}`,
  });
  return res.data.data; // { authorization_url, reference }
}

async function verifyPayment(reference) {
  const res = await paystack.get(`/transaction/verify/${reference}`);
  return res.data.data; // includes status: 'success' | 'failed' etc.
}

module.exports = { initializePayment, verifyPayment, PLANS };

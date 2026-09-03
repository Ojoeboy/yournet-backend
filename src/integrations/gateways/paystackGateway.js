const axios = require('axios');
const crypto = require('crypto');

// Same Paystack API as integrations/billing.js, but this version accepts
// credentials explicitly per call - it can run with the PLATFORM's own
// Paystack keys (license/subscription payments) or a TENANT's own linked
// Paystack account (their customers paying them directly), depending on
// which credentials get passed in.

// currency defaults to 'GHS' for backward compatibility with existing
// callers. Paystack only supports a handful of currencies (GHS, NGN, USD,
// ZAR, KES as of writing) and only if the merchant's account has that
// currency enabled - if a tenant picks an unsupported one at signup, this
// call will fail with a Paystack error, which the caller surfaces as-is.
async function initializePayment({ secretKey, email, amountGHS, currency, reference, callbackUrl, metadata }) {
  const res = await axios.post(
    'https://api.paystack.co/transaction/initialize',
    {
      email,
      amount: Math.round(amountGHS * 100),
      currency: currency || 'GHS',
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
  const auth = res.data.data.authorization;
  return {
    success,
    amountGHS: res.data.data.amount / 100,
    customerEmail: res.data.data.customer?.email,
    // Only trust this for future auto-charges when Paystack itself marks it
    // reusable (`reusable: true`) - some card/issuer combos return an
    // authorization_code that looks usable but Paystack will reject a
    // later charge_authorization call against it.
    authorizationCode: auth?.reusable ? auth.authorization_code : null,
    raw: res.data.data,
  };
}

// Charges a previously-captured, reusable authorization with no further
// buyer interaction - this is what makes monthly renewal automatic. Used
// by services/subscriptionBilling.js. Paystack still requires an `email`
// on this call even though no checkout page is shown.
async function chargeAuthorization({ secretKey, email, amountGHS, authorizationCode, reference }) {
  const res = await axios.post(
    'https://api.paystack.co/transaction/charge_authorization',
    {
      email,
      amount: Math.round(amountGHS * 100),
      currency: 'GHS',
      authorization_code: authorizationCode,
      reference,
    },
    { headers: { Authorization: `Bearer ${secretKey}` } }
  );
  const success = res.data.data.status === 'success';
  return { success, reference: res.data.data.reference, raw: res.data.data };
}

// Verifies the `x-paystack-signature` header on an inbound webhook: Paystack
// HMACs the EXACT raw request body with your secret key (SHA512) and sends
// the hex digest in that header. This must run against the raw bytes, not
// JSON.stringify(req.body) - re-serializing a parsed object isn't guaranteed
// to reproduce byte-identical output (key order, spacing, unicode escaping),
// which would make legitimate webhooks fail this check unpredictably. See
// server.js's express.json({ verify }) for where rawBody comes from.
// timingSafeEqual needs equal-length buffers - a length mismatch (e.g. a
// malformed/short header) means it's not a valid signature, full stop, so
// that's checked before comparing rather than letting timingSafeEqual throw.
function verifyWebhookSignature({ secretKey, rawBody, signature }) {
  if (!secretKey || !rawBody || !signature) return false;
  const expected = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const signatureBuf = Buffer.from(signature, 'utf8');
  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

module.exports = { initializePayment, verifyPayment, chargeAuthorization, verifyWebhookSignature };

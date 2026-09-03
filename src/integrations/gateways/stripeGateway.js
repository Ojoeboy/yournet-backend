const axios = require('axios');
const crypto = require('crypto');

// Stripe Checkout Sessions (docs.stripe.com/api/checkout/sessions). Unlike
// Paystack/Flutterwave/Hubtel (all built for GHS-first African markets),
// Stripe is the international-card leg of the platform - used for tenants
// who want to accept card payments from customers outside the
// currencies/regions the other three gateways cover well.
//
// Calling Stripe's REST API directly with axios here, same as every other
// file in this folder - no @stripe/stripe-node dependency added, for
// consistency with how Paystack/Hubtel/Flutterwave are each called
// directly rather than through their official SDKs.
//
// Auth: Stripe uses HTTP Basic Auth with the secret key as the username
// and an empty password - axios's `auth` option handles this directly
// rather than hand-building the header, unlike Hubtel's Basic Auth which
// needed a manual base64 pair.
//
// Body encoding: Stripe's API expects application/x-www-form-urlencoded,
// NOT JSON, including for nested objects (Stripe's own bracket-array
// convention - see line_items[]... below). This is different from every
// other gateway in this folder, which are conventional JSON APIs.

function authFor(secretKey) {
  return { username: secretKey, password: '' };
}

// currency: Stripe wants a lowercase ISO 4217 code (e.g. 'usd', 'eur'),
// and amount in the SMALLEST currency unit (cents for usd/eur, but some
// currencies - e.g. JPY - have no minor unit at all). This function only
// handles the common two-decimal-place currencies (multiply by 100) - a
// tenant billing in a zero-decimal currency would need that handled
// separately before this is production-ready for those currencies.
async function createCheckoutSession({ secretKey, amount, currency, reference, email, successUrl, cancelUrl, description }) {
  const body = new URLSearchParams();
  body.append('mode', 'payment');
  body.append('client_reference_id', reference);
  body.append('success_url', successUrl);
  body.append('cancel_url', cancelUrl);
  if (email) body.append('customer_email', email);
  body.append('line_items[0][quantity]', '1');
  body.append('line_items[0][price_data][currency]', (currency || 'usd').toLowerCase());
  body.append('line_items[0][price_data][unit_amount]', String(Math.round(amount * 100)));
  body.append('line_items[0][price_data][product_data][name]', description || 'YourNet WiFi voucher');
  // Stored on the Session so the webhook (which only gets the Stripe
  // session/event object, not our own request) can look the order back up
  // by OUR reference rather than needing to trust session.id alone.
  body.append('metadata[reference]', reference);

  const res = await axios.post('https://api.stripe.com/v1/checkout/sessions', body, {
    auth: authFor(secretKey),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  return {
    checkoutUrl: res.data.url,
    reference, // our own reference, not Stripe's session id - kept consistent with how Paystack/Flutterwave/Hubtel all return the caller-supplied reference
    sessionId: res.data.id,
  };
}

// Re-fetches a session directly from Stripe rather than trusting the
// webhook payload's own fields - same "verify independently" pattern
// paystackGateway.verifyPayment and flutterwaveGateway use, so a forged
// or replayed webhook body alone is never enough to issue a voucher.
async function verifyCheckoutSession({ secretKey, sessionId }) {
  const res = await axios.get(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
    auth: authFor(secretKey),
  });
  const session = res.data;
  return {
    success: session.payment_status === 'paid',
    amount: session.amount_total != null ? session.amount_total / 100 : null,
    currency: session.currency,
    customerEmail: session.customer_details?.email || null,
    reference: session.metadata?.reference || session.client_reference_id || null,
    raw: session,
  };
}

// Verifies the `Stripe-Signature` header on an inbound webhook. Stripe's
// scheme (docs.stripe.com/webhooks/signatures) differs from Paystack's
// plain HMAC-of-body: the header carries a timestamp (`t=`) and one or
// more signatures (`v1=`), and the signed payload is `${timestamp}.${rawBody}`,
// not the raw body alone. Must run against the exact raw request bytes -
// same rawBody capture in server.js's express.json({ verify }) that
// Paystack's check already depends on.
//
// The timestamp is deliberately NOT checked against a tolerance window
// here (Stripe recommends rejecting old timestamps to block replay
// attacks) - left as a known gap rather than guessing an appropriate
// tolerance without seeing this running against a live Stripe account
// first, same "flag it rather than hide it" approach as the Ruijie work's
// unvalidated wire format.
function verifyWebhookSignature({ webhookSecret, rawBody, signatureHeader }) {
  if (!webhookSecret || !rawBody || !signatureHeader) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(',').map((pair) => pair.split('='))
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', webhookSecret).update(signedPayload).digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const signatureBuf = Buffer.from(signature, 'utf8');
  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

module.exports = { createCheckoutSession, verifyCheckoutSession, verifyWebhookSignature };

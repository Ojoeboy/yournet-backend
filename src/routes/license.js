const express = require('express');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const license = require('../services/licenseService');
const sms = require('../integrations/smsService');
const paystackGateway = require('../integrations/gateways/paystackGateway');
const flutterwaveGateway = require('../integrations/gateways/flutterwaveGateway');
const hubtelGateway = require('../integrations/gateways/hubtelGateway');
const brevo = require('../integrations/brevo');
const validate = require('../utils/validate');
const asyncHandler = require('../utils/asyncHandler');
const { requireOwnerAuth } = require('../middleware/auth');

const router = express.Router();

const LICENSE_PRICE_GHS = Number(process.env.LICENSE_PRICE_GHS || 500);
const SUPPORTED_PROVIDERS = ['paystack', 'flutterwave', 'hubtel'];

function isConfigured(provider) {
  if (provider === 'paystack') return !!process.env.PAYSTACK_SECRET_KEY;
  if (provider === 'flutterwave') return !!process.env.FLUTTERWAVE_SECRET_KEY;
  if (provider === 'hubtel') {
    return !!(process.env.HUBTEL_CLIENT_ID && process.env.HUBTEL_CLIENT_SECRET && process.env.HUBTEL_MERCHANT_ACCOUNT_NUMBER);
  }
  return false;
}

// PUBLIC: which gateways the /license checkout can actually offer right
// now, so the page never shows a provider that would just fail on submit.
router.get('/purchase/providers', (req, res) => {
  const labels = { paystack: 'Paystack (Card & Mobile Money)', flutterwave: 'Flutterwave', hubtel: 'Hubtel' };
  res.json({ providers: SUPPORTED_PROVIDERS.filter(isConfigured).map((id) => ({ id, label: labels[id] })) });
});

// PUBLIC: buyer picks a provider on /license and this kicks off that
// provider's checkout. A pending order row is created up front so whichever
// callback/webhook comes back later (browser redirect for Paystack/
// Flutterwave, server-to-server webhook for Hubtel) can look the buyer back
// up by reference alone.
router.post('/purchase/initialize', asyncHandler(async (req, res) => {
  const { provider, email, phone } = req.body;
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: `provider must be one of: ${SUPPORTED_PROVIDERS.join(', ')}` });
  }
  if (!isConfigured(provider)) {
    return res.status(400).json({ error: `${provider} is not configured on this server yet.` });
  }
  const validationError = validate.required(req.body, ['email']) || (!validate.isEmail(email) ? 'Please enter a valid email address.' : null);
  if (validationError) return res.status(400).json({ error: validationError });
  if (provider === 'hubtel' && !validate.isNonEmptyString(phone, 30)) {
    return res.status(400).json({ error: 'A phone number is required for Hubtel checkout.' });
  }

  const reference = `LIC-${uuidv4().slice(0, 12)}`;
  const base = process.env.APP_BASE_URL;

  try {
    let checkoutUrl;
    if (provider === 'paystack') {
      const result = await paystackGateway.initializePayment({
        secretKey: process.env.PAYSTACK_SECRET_KEY,
        email,
        amountGHS: LICENSE_PRICE_GHS,
        reference,
        callbackUrl: `${base}/license/purchase/callback/paystack`,
        metadata: { purpose: 'license_purchase' },
      });
      checkoutUrl = result.checkoutUrl;
    } else if (provider === 'flutterwave') {
      const result = await flutterwaveGateway.initializePayment({
        secretKey: process.env.FLUTTERWAVE_SECRET_KEY,
        email,
        phone,
        amountGHS: LICENSE_PRICE_GHS,
        reference,
        redirectUrl: `${base}/license/purchase/callback/flutterwave`,
        title: 'YourNet Control license',
      });
      checkoutUrl = result.checkoutUrl;
    } else {
      const result = await hubtelGateway.initializePayment({
        clientId: process.env.HUBTEL_CLIENT_ID,
        clientSecret: process.env.HUBTEL_CLIENT_SECRET,
        merchantAccountNumber: process.env.HUBTEL_MERCHANT_ACCOUNT_NUMBER,
        amountGHS: LICENSE_PRICE_GHS,
        reference,
        callbackUrl: `${base}/license/purchase/webhook/hubtel`,
        returnUrl: `${base}/license/purchase/status/${reference}`,
        description: 'YourNet Control license',
      });
      checkoutUrl = result.checkoutUrl;
    }

    await pool.query(
      `INSERT INTO license_purchase_orders (provider, provider_reference, buyer_email, buyer_phone, amount)
       VALUES ($1,$2,$3,$4,$5)`,
      [provider, reference, email, phone || null, LICENSE_PRICE_GHS]
    );

    res.json({ checkoutUrl, provider, reference });
  } catch (err) {
    res.status(502).json({ error: 'Could not start payment. Check the provider is configured correctly.', detail: err.message });
  }
}));

// Shared: once a gateway confirms payment succeeded, generate the real key,
// mark the order paid, and get it to the buyer (SMS too if we have their
// phone - the only channel a webhook flow like Hubtel's can rely on).
async function fulfillOrder(order, provider) {
  const key = await license.issueKey({
    amount: order.amount,
    paymentMethod: provider,
    paymentReference: order.provider_reference,
    buyerEmail: order.buyer_email,
    buyerPhone: order.buyer_phone,
  });

  await pool.query(
    `UPDATE license_purchase_orders SET status='paid', issued_key_id=$1, completed_at=now() WHERE id=$2`,
    [key.id, order.id]
  );

  if (order.buyer_phone) {
    sms.sendLicenseKeySms(order.buyer_phone, key.key_code).catch(() => {});
  }

  return key;
}

// PUBLIC: Paystack/Flutterwave redirect the buyer's browser here after
// payment. Always verified server-side before anything is issued - never
// trust the redirect alone.
router.get('/purchase/callback/:provider', asyncHandler(async (req, res) => {
  const { provider } = req.params;
  if (!['paystack', 'flutterwave'].includes(provider)) return res.status(404).send('Unknown provider.');

  const reference = req.query.reference || req.query.tx_ref || req.query.trxref;
  const transactionId = req.query.transaction_id; // Flutterwave-specific
  if (!reference) return res.status(400).send('Missing payment reference.');

  const { rows } = await pool.query(
    `SELECT * FROM license_purchase_orders WHERE provider=$1 AND provider_reference=$2`,
    [provider, reference]
  );
  if (!rows.length) return res.status(404).send(renderPage('Order not found', '<p>We could not find this payment.</p>'));
  const order = rows[0];

  if (order.status === 'paid') {
    const { rows: keyRows } = await pool.query('SELECT key_code FROM license_keys WHERE id=$1', [order.issued_key_id]);
    return res.send(renderKeyPage(keyRows[0]?.key_code));
  }

  try {
    const result = provider === 'paystack'
      ? await paystackGateway.verifyPayment({ secretKey: process.env.PAYSTACK_SECRET_KEY, reference })
      : await flutterwaveGateway.verifyPayment({ secretKey: process.env.FLUTTERWAVE_SECRET_KEY, transactionId });

    if (!result.success) {
      await pool.query(`UPDATE license_purchase_orders SET status='failed' WHERE id=$1`, [order.id]);
      return res.send(renderPage('Payment failed', '<p>No key was issued. If you were charged, contact support.</p>'));
    }

    const key = await fulfillOrder(order, provider);
    res.send(renderKeyPage(key.key_code));
  } catch (err) {
    res.status(502).send('Could not verify payment: ' + err.message);
  }
}));

// PUBLIC: Hubtel confirms via a server-to-server webhook, not a browser
// redirect - see integrations/gateways/hubtelGateway.js for why. There's no
// page to show the buyer here; /purchase/status/:reference (their return
// URL) picks the key up once this has run.
router.post('/purchase/webhook/hubtel', asyncHandler(async (req, res) => {
  const interpreted = hubtelGateway.interpretWebhook(req.body);
  if (!interpreted.reference) return res.status(400).json({ error: 'No reference in webhook payload' });

  const { rows } = await pool.query(
    `SELECT * FROM license_purchase_orders WHERE provider='hubtel' AND provider_reference=$1`,
    [interpreted.reference]
  );
  if (!rows.length) return res.status(404).json({ error: 'Order not found' });
  const order = rows[0];

  if (order.status === 'paid') return res.json({ ok: true, note: 'already fulfilled' });

  if (interpreted.success) {
    await fulfillOrder(order, 'hubtel');
  } else {
    await pool.query(`UPDATE license_purchase_orders SET status='failed' WHERE id=$1`, [order.id]);
  }

  res.json({ ok: true });
}));

// PUBLIC: where Hubtel sends the buyer's browser back to (returnUrl). The
// webhook above usually lands within a few seconds but isn't guaranteed to
// beat the redirect, so this auto-refreshes itself until the order is no
// longer pending.
router.get('/purchase/status/:reference', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM license_purchase_orders WHERE provider_reference=$1',
    [req.params.reference]
  );
  if (!rows.length) return res.status(404).send(renderPage('Order not found', '<p>We could not find this payment.</p>'));
  const order = rows[0];

  if (order.status === 'paid') {
    const { rows: keyRows } = await pool.query('SELECT key_code FROM license_keys WHERE id=$1', [order.issued_key_id]);
    return res.send(renderKeyPage(keyRows[0]?.key_code));
  }
  if (order.status === 'failed') {
    return res.send(renderPage('Payment failed', '<p>No key was issued. If you were charged, contact support.</p>'));
  }
  res.send(renderPendingPage());
}));

// OWNER ONLY: manually issue a key - a deliberate escape hatch for a sale
// made outside the three online gateways (e.g. an in-person/offline deal).
// If an email is given, it's sent to the buyer via Brevo right away - the
// result (sent or not) is returned so the owner isn't left assuming an
// email went out when it didn't.
router.post('/admin/issue-manual', requireOwnerAuth, asyncHandler(async (req, res) => {
  const { buyerPhone, buyerEmail, notes, amount } = req.body;
  const key = await license.issueKey({
    amount: amount || LICENSE_PRICE_GHS,
    paymentMethod: 'manual',
    buyerPhone,
    buyerEmail,
    notes,
  });
  if (buyerPhone) sms.sendLicenseKeySms(buyerPhone, key.key_code).catch(() => {});

  let email = { sent: false };
  if (buyerEmail) {
    try {
      email = await brevo.sendLicenseKeyEmail(buyerEmail, key.key_code);
    } catch (err) {
      email = { sent: false, reason: err.message };
    }
  }

  res.json({ ...key, email });
}));

// OWNER ONLY: (re)send an already-issued key to an email address - for a
// buyer who lost the original email, or to correct a typo'd address.
// Looks the key up by its code rather than trusting an arbitrary pasted
// string, so this can only ever send a key that's real and already exists.
router.post('/admin/resend-email', requireOwnerAuth, asyncHandler(async (req, res) => {
  const { keyCode, email } = req.body;
  const validationError = validate.required(req.body, ['keyCode', 'email']) || (!validate.isEmail(email) ? 'Please enter a valid email address.' : null);
  if (validationError) return res.status(400).json({ error: validationError });

  const { rows } = await pool.query('SELECT * FROM license_keys WHERE key_code=$1', [keyCode.trim().toUpperCase()]);
  if (!rows.length) return res.status(404).json({ error: 'No key found with that code.' });

  try {
    const result = await brevo.sendLicenseKeyEmail(email, rows[0].key_code);
    if (!result.sent) return res.status(502).json({ error: result.reason || 'Could not send email.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: 'Could not send email.', detail: err.message });
  }
}));

// OWNER ONLY: see everything issued so far.
router.get('/admin/list', requireOwnerAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM license_keys ORDER BY created_at DESC LIMIT 200');
  res.json(rows);
}));

function renderPage(title, bodyHtml) {
  return `
    <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0d1a1e;color:#e8f0f1">
      <h1>${title}</h1>
      <style>.key{font-family:monospace;font-size:24px;font-weight:800;color:#ffc55a;
        background:#132228;border:1px solid rgba(255,255,255,.15);border-radius:10px;
        padding:16px;display:inline-block;margin:20px 0}
      .copyBtn{display:block;margin:0 auto;padding:10px 18px;border:none;border-radius:8px;
        background:#e8a33d;color:#0d1a1e;font-weight:700;cursor:pointer;font-size:14px}</style>
      ${bodyHtml}
    </body></html>
  `;
}

function renderKeyPage(keyCode) {
  if (!keyCode) return renderPage('Payment successful', '<p>Your key is being issued - refresh this page in a moment.</p>');
  return renderPage(
    'Payment successful - here is your activation key',
    `<div class="key" id="keyCode">${keyCode}</div>
     <button class="copyBtn" onclick="navigator.clipboard.writeText('${keyCode}').then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy key',1500)})">Copy key</button>
     <p>Save this key now - you'll need it once, during signup at <a href="/admin" style="color:#2ec4b6">/admin</a>. It cannot be reused for a second business.</p>`
  );
}

function renderPendingPage() {
  return `
    <html><head><meta http-equiv="refresh" content="4"></head>
    <body style="font-family:sans-serif;text-align:center;padding:60px;background:#0d1a1e;color:#e8f0f1">
      <h1>Confirming your payment...</h1>
      <p>This page will update automatically once it's confirmed - usually within a few seconds.</p>
    </body></html>
  `;
}

module.exports = router;

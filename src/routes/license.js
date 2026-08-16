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
const webhookToken = require('../utils/webhookToken');
const { requireOwnerAuth } = require('../middleware/auth');

const router = express.Router();

const LICENSE_SIGNUP_PRICE_GHS = Number(process.env.LICENSE_SIGNUP_PRICE_GHS || 150);
const LICENSE_REACTIVATION_PRICE_GHS = Number(process.env.LICENSE_REACTIVATION_PRICE_GHS || 50);
const LICENSE_GRACE_DAYS = Number(process.env.LICENSE_GRACE_DAYS || 2);
const SUPPORTED_PROVIDERS = ['paystack', 'flutterwave', 'hubtel'];
// Only Paystack's authorization-reuse gives us a true "charge again next
// month with no buyer interaction" flow. Flutterwave's Standard Checkout
// (what initializePayment/verifyPayment below use) does not return a
// reusable token - Flutterwave's own tokenized/recurring charges require a
// different, non-redirect card API. Hubtel Mobile Money has no reusable-
// charge concept at all. Buyers on those two still get a monthly license,
// they just have to come back to /license and pay again each month instead
// of it happening automatically - the UI should say so.
const AUTO_RENEW_PROVIDERS = ['paystack'];

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
  res.json({
    providers: SUPPORTED_PROVIDERS.filter(isConfigured).map((id) => ({ id, label: labels[id] })),
    // Only meaningful when providers above is empty - license.html shows
    // this on the manual-pay fallback so the buyer actually knows where
    // to send their money, instead of just a reference field with no
    // destination.
    manualMomo: process.env.OWNER_MOMO_NUMBER
      ? { number: process.env.OWNER_MOMO_NUMBER, name: process.env.OWNER_MOMO_NAME || null }
      : null,
  });
});

// PUBLIC: buyer picks a provider on /license and this kicks off that
// provider's checkout. A pending order row is created up front so whichever
// callback/webhook comes back later (browser redirect for Paystack/
// Flutterwave, server-to-server webhook for Hubtel) can look the buyer back
// up by reference alone.
router.post('/purchase/initialize', asyncHandler(async (req, res) => {
  const { provider, email, phone, purpose } = req.body;
  const orderPurpose = purpose === 'reactivate' ? 'reactivate' : 'signup';
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

  let tenantId = null;
  if (orderPurpose === 'reactivate') {
    const { rows } = await pool.query('SELECT id FROM tenants WHERE owner_email=$1', [email]);
    if (!rows.length) return res.status(404).json({ error: 'No account found with that email.' });
    tenantId = rows[0].id;
  }

  const amountGHS = orderPurpose === 'reactivate' ? LICENSE_REACTIVATION_PRICE_GHS : LICENSE_SIGNUP_PRICE_GHS;
  const reference = `LIC-${uuidv4().slice(0, 12)}`;
  const base = process.env.APP_BASE_URL;
  const hubtelToken = provider === 'hubtel' ? webhookToken.generateToken() : null;

  try {
    let checkoutUrl;
    if (provider === 'paystack') {
      const result = await paystackGateway.initializePayment({
        secretKey: process.env.PAYSTACK_SECRET_KEY,
        email,
        amountGHS,
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
        amountGHS,
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
        amountGHS,
        reference,
        // Same forged-webhook concern as portal.js's buy-voucher - see
        // utils/webhookToken.js. Here it's worse than a free voucher: it's
        // a free license key, so this token is non-negotiable.
        callbackUrl: `${base}/license/purchase/webhook/hubtel?wt=${hubtelToken.raw}`,
        returnUrl: `${base}/license/purchase/status/${reference}`,
        description: 'YourNet Control license',
      });
      checkoutUrl = result.checkoutUrl;
    }

    await pool.query(
      `INSERT INTO license_purchase_orders (provider, provider_reference, buyer_email, buyer_phone, amount, purpose, tenant_id, webhook_token_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [provider, reference, email, phone || null, amountGHS, orderPurpose, tenantId, hubtelToken?.hash || null]
    );

    res.json({ checkoutUrl, provider, reference });
  } catch (err) {
    res.status(502).json({ error: 'Could not start payment. Check the provider is configured correctly.', detail: err.message });
  }
}));

// Shared: once a gateway confirms payment succeeded, either (a) reactivate
// an existing tenant's subscription directly, or (b) generate a signup key
// as before. `authorizationCode` (Paystack only - see AUTO_RENEW_PROVIDERS)
// is whatever reusable charge token the gateway handed back from this
// payment; when present it's stored so subscriptionBilling.js can charge
// this same card automatically next month with no key and no buyer action.
async function fulfillOrder(order, provider, authorizationCode) {
  // Same TOCTOU race as voucherService.fulfillOrder had: the Paystack/
  // Flutterwave callback and the Hubtel webhook both do a SELECT-then-
  // check-status before calling this, so a webhook retry or a refreshed
  // callback page racing against the original call could otherwise both
  // pass the "not yet paid" check and both issue a key / reactivate a
  // subscription for the same order. Claim it atomically here so every
  // caller shares one guard.
  const claim = await pool.query(
    `UPDATE license_purchase_orders SET status='fulfilling' WHERE id=$1 AND status='pending' RETURNING *`,
    [order.id]
  );
  if (!claim.rows.length) {
    // Lost the race - whatever the winning call returns/returned, this
    // call has nothing new to issue.
    return null;
  }
  order = claim.rows[0];

  const nextBillingAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  try {
  if (order.purpose === 'reactivate') {
    const subscriptionStatus = authorizationCode ? 'active' : 'manual';
    await pool.query(
      `UPDATE tenants
       SET plan='licensed', plan_expires_at=$1, next_billing_at=$1,
           subscription_status=$2, billing_provider=$3, billing_authorization=$4, plan_started_at=now()
       WHERE id=$5`,
      [nextBillingAt, subscriptionStatus, provider, authorizationCode || null, order.tenant_id]
    );
    await pool.query(
      `INSERT INTO subscription_payments (tenant_id, amount, currency, provider, provider_reference, status, kind)
       VALUES ($1,$2,'GHS',$3,$4,'paid','initial')`,
      [order.tenant_id, order.amount, provider, order.provider_reference]
    );
    await pool.query(
      `UPDATE license_purchase_orders SET status='paid', completed_at=now() WHERE id=$1`,
      [order.id]
    );
    if (order.buyer_phone) sms.sendLicenseKeySms(order.buyer_phone, 'Your YourNet Control subscription is active again.').catch(() => {});
    return { reactivated: true, tenantId: order.tenant_id };
  }

  const key = await license.issueKey({
    amount: order.amount,
    paymentMethod: provider,
    paymentReference: order.provider_reference,
    buyerEmail: order.buyer_email,
    buyerPhone: order.buyer_phone,
    keyType: 'signup',
    billingProvider: provider,
    billingAuthorization: authorizationCode || null,
  });

  await pool.query(
    `UPDATE license_purchase_orders SET status='paid', issued_key_id=$1, completed_at=now() WHERE id=$2`,
    [key.id, order.id]
  );

  if (order.buyer_phone) {
    sms.sendLicenseKeySms(order.buyer_phone, key.key_code).catch(() => {});
  }

  return key;
  } catch (err) {
    // Key issuance or a write failed after we claimed the order - put it
    // back to 'pending' so a retried webhook or a reloaded callback page
    // can actually succeed later, instead of the order being stuck in
    // 'fulfilling' forever with no key and no way to retry it.
    await pool.query(
      `UPDATE license_purchase_orders SET status='pending' WHERE id=$1 AND status='fulfilling'`,
      [order.id]
    ).catch(() => {});
    throw err;
  }
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
    if (order.purpose === 'reactivate') return res.send(renderReactivatedPage());
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

    // SECURITY: same reference/amount-confusion gap as portal.js's
    // gateway-callback, and worse here - it's a signup/reactivation key,
    // not a WiFi voucher. `reference` (used to look up `order` above) and
    // `transactionId` (used to verify with Flutterwave) are independent,
    // client-supplied query params with nothing tying them together on
    // Flutterwave's end. Without this check, a paid $50 reactivation's
    // transactionId could be replayed against a $150 signup order's
    // reference to get a signup key for reactivation price. Paystack is
    // unaffected: its verify call is keyed by the same reference used for
    // the order lookup, so there's no separate id to mismatch.
    if (provider === 'flutterwave') {
      if (result.reference !== order.provider_reference) {
        await pool.query(`UPDATE license_purchase_orders SET status='failed' WHERE id=$1`, [order.id]);
        return res.send(renderPage('Payment could not be verified', '<p>This transaction does not match this order.</p>'));
      }
      if (Math.round(Number(result.amountGHS) * 100) < Math.round(Number(order.amount) * 100)) {
        await pool.query(`UPDATE license_purchase_orders SET status='failed' WHERE id=$1`, [order.id]);
        return res.send(renderPage('Payment could not be verified', '<p>The amount paid does not match this order.</p>'));
      }
    }

    const authorizationCode = AUTO_RENEW_PROVIDERS.includes(provider) ? result.authorizationCode : null;
    const outcome = await fulfillOrder(order, provider, authorizationCode);

    if (!outcome) {
      // Lost the race to a concurrent call (e.g. this page got reloaded
      // while the original request was still finishing) - re-fetch the
      // now-completed order rather than reporting failure.
      const { rows: refreshed } = await pool.query(`SELECT * FROM license_purchase_orders WHERE id=$1`, [order.id]);
      const current = refreshed[0];
      if (current?.purpose === 'reactivate') return res.send(renderReactivatedPage(!!authorizationCode));
      const { rows: keyRows } = await pool.query('SELECT key_code FROM license_keys WHERE id=$1', [current?.issued_key_id]);
      return res.send(renderKeyPage(keyRows[0]?.key_code));
    }

    if (order.purpose === 'reactivate') return res.send(renderReactivatedPage(!!authorizationCode));
    res.send(renderKeyPage(outcome.key_code));
  } catch (err) {
    res.status(502).send('Could not verify payment: ' + err.message);
  }
}));

// PUBLIC: Paystack's server-to-server webhook - a second, independent path
// to fulfillment alongside the redirect-based /purchase/callback/paystack
// above. The redirect alone misses a real edge case: a buyer can complete
// payment successfully and then close the tab, lose signal, or have their
// browser killed before the redirect back to us ever fires - Paystack
// still processed the charge, but we'd never find out and no key would be
// issued. This webhook catches exactly that case, independently of
// whether the redirect ever happens.
//
// SECURITY: unlike the Hubtel webhook (protected by a per-order token
// minted at initialize time), Paystack calls one fixed URL for every event
// on the account, so there's no per-order secret to check here. What
// stops a forged "charge.success" POST from a stranger is the
// x-paystack-signature header - an HMAC-SHA512 of the raw body using your
// Paystack secret key, which only Paystack (and you) know. Reject
// anything that doesn't carry a valid one before looking at the payload
// at all. On top of that, the payload's own claim of success is still not
// trusted for what actually gets issued - see the verifyPayment call
// below, same as the redirect path already does.
router.post('/purchase/webhook/paystack', asyncHandler(async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const validSignature = paystackGateway.verifyWebhookSignature({
    secretKey: process.env.PAYSTACK_SECRET_KEY,
    rawBody: req.rawBody,
    signature,
  });
  if (!validSignature) return res.status(401).json({ error: 'Invalid signature' });

  const event = req.body || {};
  // Paystack sends many event types on this same URL (transfer events,
  // subscription events, etc.) - only charge.success is relevant to
  // license purchases/reactivations, everything else is a silent no-op
  // (still 200, so Paystack doesn't keep retrying an event we're
  // deliberately ignoring).
  if (event.event !== 'charge.success') return res.json({ received: true });

  const reference = event.data?.reference;
  if (!reference) return res.json({ received: true });

  const { rows } = await pool.query(
    `SELECT * FROM license_purchase_orders WHERE provider='paystack' AND provider_reference=$1`,
    [reference]
  );
  // Not every charge.success on this Paystack account is a license order -
  // the same account/key also fires this event for subscriptionBilling.js's
  // monthly auto-renewal charges (reference prefix RENEW-, no matching row
  // here by design). Nothing to do with those from this route.
  if (!rows.length) return res.json({ received: true });
  const order = rows[0];
  if (order.status === 'paid') return res.json({ received: true, note: 'already fulfilled' });

  // Re-verify directly with Paystack's API rather than trusting the
  // webhook payload's own amount/status fields for what gets issued - same
  // rule the redirect callback follows above, now applied here too.
  const result = await paystackGateway.verifyPayment({ secretKey: process.env.PAYSTACK_SECRET_KEY, reference });
  if (!result.success) {
    await pool.query(`UPDATE license_purchase_orders SET status='failed' WHERE id=$1 AND status='pending'`, [order.id]);
    return res.json({ received: true });
  }

  const authorizationCode = AUTO_RENEW_PROVIDERS.includes('paystack') ? result.authorizationCode : null;
  // fulfillOrder's own atomic claim (status='pending' -> 'fulfilling') is
  // what makes this safe to run concurrently with the redirect callback
  // firing for the same order - whichever gets there first wins, the
  // other gets `null` back and does nothing further.
  await fulfillOrder(order, 'paystack', authorizationCode);
  res.json({ received: true });
}));

// PUBLIC: Hubtel confirms via a server-to-server webhook, not a browser
// redirect - see integrations/gateways/hubtelGateway.js for why. There's no
// page to show the buyer here; /purchase/status/:reference (their return
// URL) picks the key up once this has run.
//
// SECURITY: see utils/webhookToken.js - the `wt` param is what stops
// anyone who's ever called purchase/initialize from POSTing a fake
// "success" here and getting a free license key using the reference that
// same call handed them back.
router.post('/purchase/webhook/hubtel', asyncHandler(async (req, res) => {
  const interpreted = hubtelGateway.interpretWebhook(req.body);
  if (!interpreted.reference) return res.status(400).json({ error: 'No reference in webhook payload' });

  const { rows } = await pool.query(
    `SELECT * FROM license_purchase_orders WHERE provider='hubtel' AND provider_reference=$1`,
    [interpreted.reference]
  );
  if (!rows.length) return res.status(404).json({ error: 'Order not found' });
  const order = rows[0];

  if (!webhookToken.tokensMatch(req.query.wt, order.webhook_token_hash)) {
    return res.status(401).json({ error: 'Invalid or missing webhook token' });
  }

  if (order.status === 'paid') return res.json({ ok: true, note: 'already fulfilled' });

  if (interpreted.success) {
    // Hubtel Mobile Money has no reusable-charge token, so this is never an
    // AUTO_RENEW_PROVIDERS entry - authorizationCode is always null here,
    // meaning subscription_status lands as 'manual' (owner/tenant repeats
    // this checkout each month rather than it happening automatically).
    await fulfillOrder(order, 'hubtel', null);
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
    if (order.purpose === 'reactivate') return res.send(renderReactivatedPage());
    const { rows: keyRows } = await pool.query('SELECT key_code FROM license_keys WHERE id=$1', [order.issued_key_id]);
    return res.send(renderKeyPage(keyRows[0]?.key_code));
  }
  if (order.status === 'failed') {
    return res.send(renderPage('Payment failed', '<p>No key was issued. If you were charged, contact support.</p>'));
  }
  res.send(renderPendingPage());
}));

// Stopgap for when no gateway is configured (see /purchase/providers -
// license.html hides the automated checkout entirely and shows this
// instead). Buyer submits their MoMo transaction reference; nothing is
// verified automatically here - it just queues the claim for the owner
// to check against their own phone's MoMo message and approve/reject
// from /license-admin. No key is issued until that happens.
router.post('/purchase/claim-manual', asyncHandler(async (req, res) => {
  const { purpose, buyerEmail, buyerPhone, momoReference, notes } = req.body;
  const resolvedPurpose = purpose === 'reactivate' ? 'reactivate' : 'signup';
  const validationError =
    validate.required(req.body, ['buyerEmail', 'momoReference']) ||
    (!validate.isEmail(buyerEmail) ? 'Please enter a valid email address.' : null);
  if (validationError) return res.status(400).json({ error: validationError });

  const { rows } = await pool.query(
    `INSERT INTO license_manual_claims (purpose, buyer_email, buyer_phone, momo_reference, notes)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [resolvedPurpose, buyerEmail.trim(), buyerPhone || null, momoReference.trim(), notes || null]
  );
  const claim = rows[0];

  // Best-effort - a failed alert shouldn't fail the buyer's submission,
  // the claim is already saved and visible on /license-admin regardless.
  brevo.sendManualClaimAlertEmail(claim).catch(() => {});
  if (process.env.OWNER_ALERT_PHONE) {
    sms.sendSms(process.env.OWNER_ALERT_PHONE, `New manual MoMo claim from ${claim.buyer_email}, ref: ${claim.momo_reference}. Review on /license-admin.`).catch(() => {});
  }

  res.json({ ok: true, claimId: claim.id });
}));

// OWNER ONLY: queue of manual claims waiting on the owner to check their
// own MoMo message and decide.
router.get('/admin/manual-claims', requireOwnerAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM license_manual_claims ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 200`
  );
  res.json(rows);
}));

// OWNER ONLY: approve a manual claim - issues a key exactly like
// /admin/issue-manual does, then links it back to the claim so the two
// stay traceable to each other.
router.post('/admin/manual-claims/:id/approve', requireOwnerAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM license_manual_claims WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Claim not found.' });
  const claim = rows[0];
  if (claim.status !== 'pending') return res.status(400).json({ error: `This claim was already ${claim.status}.` });

  const resolvedKeyType = claim.purpose === 'reactivate' ? 'reactivation' : 'signup';
  const key = await license.issueKey({
    amount: resolvedKeyType === 'reactivation' ? LICENSE_REACTIVATION_PRICE_GHS : LICENSE_SIGNUP_PRICE_GHS,
    paymentMethod: 'momo_manual',
    paymentReference: claim.momo_reference,
    buyerEmail: claim.buyer_email,
    buyerPhone: claim.buyer_phone,
    notes: claim.notes,
    keyType: resolvedKeyType,
  });

  await pool.query(
    `UPDATE license_manual_claims SET status='approved', issued_key_id=$1, reviewed_at=now() WHERE id=$2`,
    [key.id, claim.id]
  );

  if (claim.buyer_phone) sms.sendLicenseKeySms(claim.buyer_phone, key.key_code).catch(() => {});
  let email = { sent: false };
  try {
    email = await brevo.sendLicenseKeyEmail(claim.buyer_email, key.key_code);
  } catch (err) {
    email = { sent: false, reason: err.message };
  }

  res.json({ ...key, email });
}));

// OWNER ONLY: reject a manual claim - e.g. the reference doesn't match
// anything in the owner's own MoMo message history. No key is issued.
router.post('/admin/manual-claims/:id/reject', requireOwnerAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM license_manual_claims WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Claim not found.' });
  if (rows[0].status !== 'pending') return res.status(400).json({ error: `This claim was already ${rows[0].status}.` });

  await pool.query(`UPDATE license_manual_claims SET status='rejected', reviewed_at=now() WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
}));

// OWNER ONLY: manually issue a key - a deliberate escape hatch for a sale
// made outside the three online gateways (e.g. an in-person/offline deal).
// If an email is given, it's sent to the buyer via Brevo right away - the
// result (sent or not) is returned so the owner isn't left assuming an
// email went out when it didn't.
router.post('/admin/issue-manual', requireOwnerAuth, asyncHandler(async (req, res) => {
  const { buyerPhone, buyerEmail, notes, amount, keyType } = req.body;
  const resolvedKeyType = keyType === 'reactivation' ? 'reactivation' : 'signup';
  const key = await license.issueKey({
    amount: amount || (resolvedKeyType === 'reactivation' ? LICENSE_REACTIVATION_PRICE_GHS : LICENSE_SIGNUP_PRICE_GHS),
    paymentMethod: 'manual',
    buyerPhone,
    buyerEmail,
    notes,
    // 'reactivation' - for migrating an old one-time-license tenant onto the
    // monthly plan, or reviving a lapsed subscriber, without them paying
    // through the gateway (e.g. an in-person/offline renewal). Consumed the
    // same way as a signup key but by an EXISTING account - see auth.js.
    keyType: resolvedKeyType,
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

// OWNER ONLY: platform revenue - what YourNet itself has earned from
// tenant signup/reactivation payments and monthly auto-renewals. Pulled
// straight from subscription_payments (status='paid' = money actually
// received, not attempts). This is YOUR money, distinct from the
// tenant-sales endpoint below which tracks money that lands in tenants'
// own accounts, not the platform's.
router.get('/admin/revenue-summary', requireOwnerAuth, asyncHandler(async (req, res) => {
  const [{ rows: totals }, { rows: byMonth }, { rows: byProvider }, { rows: byKind }] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count
                FROM subscription_payments WHERE status='paid'`),
    pool.query(`SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
                       COALESCE(SUM(amount),0) AS total, COUNT(*) AS count
                FROM subscription_payments WHERE status='paid'
                GROUP BY 1 ORDER BY 1 ASC`),
    pool.query(`SELECT COALESCE(provider,'unknown') AS provider,
                       COALESCE(SUM(amount),0) AS total, COUNT(*) AS count
                FROM subscription_payments WHERE status='paid'
                GROUP BY 1 ORDER BY total DESC`),
    pool.query(`SELECT kind, COALESCE(SUM(amount),0) AS total, COUNT(*) AS count
                FROM subscription_payments WHERE status='paid'
                GROUP BY 1 ORDER BY total DESC`),
  ]);
  res.json({
    currency: 'GHS',
    totalRevenue: Number(totals[0].total),
    totalPayments: Number(totals[0].count),
    byMonth: byMonth.map(r => ({ month: r.month, total: Number(r.total), count: Number(r.count) })),
    byProvider: byProvider.map(r => ({ provider: r.provider, total: Number(r.total), count: Number(r.count) })),
    byKind: byKind.map(r => ({ kind: r.kind, total: Number(r.total), count: Number(r.count) })),
  });
}));

// OWNER ONLY: tenant sales logs - how much each tenant's own end-customers
// have paid THEM for WiFi vouchers, through the tenant's own linked
// gateway. This money never touches the platform account; it's visibility
// only, pulled from voucher_orders (status='paid'), grouped per tenant.
// Kept deliberately separate from revenue-summary above so the two are
// never confused: one is YourNet's income, this is tenants' income that
// YourNet merely has visibility into.
router.get('/admin/tenant-sales', requireOwnerAuth, asyncHandler(async (req, res) => {
  const [{ rows: perTenant }, { rows: byMonth }] = await Promise.all([
    pool.query(`
      SELECT t.id AS tenant_id, t.business_name, t.owner_email,
             COALESCE(SUM(p.price), 0) AS total,
             COUNT(vo.id) AS count
      FROM tenants t
      LEFT JOIN voucher_orders vo ON vo.tenant_id = t.id AND vo.status = 'paid'
      LEFT JOIN packages p ON p.id = vo.package_id
      GROUP BY t.id, t.business_name, t.owner_email
      ORDER BY total DESC
    `),
    pool.query(`
      SELECT to_char(date_trunc('month', vo.created_at), 'YYYY-MM') AS month,
             COALESCE(SUM(p.price), 0) AS total, COUNT(*) AS count
      FROM voucher_orders vo
      LEFT JOIN packages p ON p.id = vo.package_id
      WHERE vo.status='paid'
      GROUP BY 1 ORDER BY 1 ASC
    `),
  ]);
  res.json({
    currency: 'GHS',
    perTenant: perTenant.map(r => ({
      tenantId: r.tenant_id, businessName: r.business_name, ownerEmail: r.owner_email,
      total: Number(r.total), count: Number(r.count),
    })),
    byMonth: byMonth.map(r => ({ month: r.month, total: Number(r.total), count: Number(r.count) })),
  });
}));

// OWNER ONLY: full tenant directory for the Tenant Data page - name,
// both emails, country, gender, both WhatsApp numbers, logo, and which
// payment gateway providers each tenant has configured (provider names
// only - never keys/secrets, those stay encrypted in payment_gateways
// and are never selected here).
router.get('/admin/tenants', requireOwnerAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT t.id, t.business_name, t.admin_full_name, t.owner_email, t.business_email,
           t.owner_phone, t.admin_whatsapp,
           CASE t.business_whatsapp_mode
             WHEN 'custom' THEN t.business_whatsapp_custom
             WHEN 'account' THEN t.admin_whatsapp
             ELSE NULL
           END AS business_whatsapp,
           t.country, t.gender, t.account_logo, t.subscription_status, t.plan_expires_at,
           t.created_at,
           COALESCE(
             (SELECT array_agg(pg.provider ORDER BY pg.provider) FROM payment_gateways pg WHERE pg.tenant_id = t.id),
             ARRAY[]::text[]
           ) AS payment_gateways
    FROM tenants t
    ORDER BY t.created_at DESC
  `);
  res.json(rows.map(t => ({
    id: t.id,
    businessName: t.business_name,
    adminFullName: t.admin_full_name,
    personalEmail: t.owner_email,
    businessEmail: t.business_email,
    mobileNumber: t.owner_phone,
    adminWhatsapp: t.admin_whatsapp,
    businessWhatsapp: t.business_whatsapp,
    country: t.country,
    gender: t.gender,
    logoUrl: t.account_logo,
    subscriptionStatus: t.subscription_status,
    planExpiresAt: t.plan_expires_at,
    createdAt: t.created_at,
    paymentGateways: t.payment_gateways,
  })));
}));

// OWNER ONLY: aggregate stats behind the dashboard graphs - gender split,
// country split, and active-vs-offline. "Active" mirrors the same
// subscription_status the tenant's own login grace-period check already
// uses (see routes/auth.js) - 'active' or 'manual' with a plan not yet
// expired counts as a live business; everything else (past_due, canceled,
// or an expired plan_expires_at) counts as offline/not reactivated.
router.get('/admin/tenant-stats', requireOwnerAuth, asyncHandler(async (req, res) => {
  const [{ rows: gender }, { rows: country }, { rows: activity }] = await Promise.all([
    pool.query(`SELECT COALESCE(gender,'unspecified') AS gender, COUNT(*) AS count
                FROM tenants GROUP BY 1 ORDER BY count DESC`),
    pool.query(`SELECT COALESCE(country,'unspecified') AS country, COUNT(*) AS count
                FROM tenants GROUP BY 1 ORDER BY count DESC`),
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE subscription_status IN ('active','manual') AND (plan_expires_at IS NULL OR plan_expires_at > now())) AS active,
        COUNT(*) FILTER (WHERE NOT (subscription_status IN ('active','manual') AND (plan_expires_at IS NULL OR plan_expires_at > now()))) AS offline
      FROM tenants
    `),
  ]);
  res.json({
    byGender: gender.map(r => ({ gender: r.gender, count: Number(r.count) })),
    byCountry: country.map(r => ({ country: r.country, count: Number(r.count) })),
    active: Number(activity[0].active),
    offline: Number(activity[0].offline),
  });
}));

// ---- Tutorials / media library (owner writes, every tenant reads) ----
// Read side for tenants lives at GET /api/dashboard/tutorials in
// routes/dashboard.js - deliberately unauthenticated-by-tenant-id since
// the whole point is every tenant sees the same list.

router.get('/admin/tutorials', requireOwnerAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, title, body, photo, position, created_at FROM tutorials ORDER BY position ASC, created_at DESC'
  );
  res.json(rows);
}));

router.post('/admin/tutorials', requireOwnerAuth, asyncHandler(async (req, res) => {
  const { title, body, photo, position } = req.body;
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required.' });
  // Same 1.5MB-ish ballpark as the account/portal logo uploads - this is a
  // small illustrative photo, not a banner, so keep it light. Client
  // should run it through logo-editor.js-style resizing before sending.
  if (photo && photo.length > 2 * 1024 * 1024) {
    return res.status(400).json({ error: 'Photo is too large - please use a smaller image.' });
  }
  if (photo && !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(photo)) {
    return res.status(400).json({ error: 'Photo must be an image (PNG/JPEG/WEBP/GIF).' });
  }
  const { rows } = await pool.query(
    `INSERT INTO tutorials (title, body, photo, position) VALUES ($1,$2,$3,$4) RETURNING id`,
    [String(title).trim(), body || null, photo || null, Number(position) || 0]
  );
  res.json({ ok: true, id: rows[0].id });
}));

router.delete('/admin/tutorials/:id', requireOwnerAuth, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM tutorials WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
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
     <p>Save this key now - you'll need it once, on the "I already have a key" tab at <a href="/login" style="color:#2ec4b6">/login</a>. It cannot be reused for a second business.</p>`
  );
}

function renderReactivatedPage(autoRenews) {
  const note = autoRenews
    ? "<p>Your card is on file - we'll charge it automatically each month, no key needed.</p>"
    : "<p>This provider doesn't support automatic monthly charging, so come back to /license to pay again before next month.</p>";
  return renderPage(
    'Subscription active',
    `<p>Your YourNet Control account has been reactivated. You can log in now.</p>${note}
     <p><a href="/dashboard" style="color:#2ec4b6">Go to dashboard</a></p>`
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

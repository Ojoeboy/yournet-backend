const express = require('express');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const voucherService = require('../services/voucherService');
const gatewayService = require('../services/paymentGatewayService');
const paystackGateway = require('../integrations/gateways/paystackGateway');
const hubtelGateway = require('../integrations/gateways/hubtelGateway');
const freeStockPhotos = require('../integrations/freeStockPhotos');
const logger = require('../utils/logger');
const asyncHandler = require('../utils/asyncHandler');
const webhookToken = require('../utils/webhookToken');

const router = express.Router();

// PUBLIC: everything the default portal template needs to render itself -
// branding, the optional extras (background image / caution notice /
// WhatsApp / manual MoMo), the tenant's active package list, and whether
// online payment is available. Deliberately excludes gateway credentials -
// only a boolean + provider name, so this is safe to call with no auth.
router.get('/:siteId/config', asyncHandler(async (req, res) => {
  const { siteId } = req.params;
  const { rows } = await pool.query(
    `SELECT s.tenant_id, s.portal_business_name, s.portal_logo_url, s.portal_primary_color,
            s.portal_background_image_url, s.portal_caution_text, s.portal_whatsapp_number,
            s.portal_help_email, s.portal_help_phone,
            s.portal_momo_number, s.portal_momo_name, s.portal_use_rotating_backgrounds,
            t.currency
     FROM sites s JOIN tenants t ON t.id = s.tenant_id
     WHERE s.id=$1`,
    [siteId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Unknown site' });
  const site = rows[0];

  const { rows: packages } = await pool.query(
    `SELECT id, label, price, duration_minutes AS "durationMinutes"
     FROM packages WHERE tenant_id=$1 AND active=true ORDER BY price ASC`,
    [site.tenant_id]
  );

  const activeGateway = await gatewayService.getActiveGateway(site.tenant_id);

  // A tenant's own custom background always wins over the rotating set -
  // only fetch/send the rotating list when there's no custom image AND the
  // tenant hasn't turned this off.
  const rotatingBackgrounds = (!site.portal_background_image_url && site.portal_use_rotating_backgrounds)
    ? await freeStockPhotos.getRotatingBackgrounds()
    : [];

  res.json({
    businessName: site.portal_business_name,
    logoUrl: site.portal_logo_url,
    primaryColor: site.portal_primary_color,
    backgroundImageUrl: site.portal_background_image_url,
    cautionText: site.portal_caution_text,
    whatsappNumber: site.portal_whatsapp_number,
    helpEmail: site.portal_help_email,
    helpPhone: site.portal_help_phone,
    momoNumber: site.portal_momo_number,
    momoName: site.portal_momo_name,
    currency: site.currency,
    packages,
    onlinePaymentAvailable: !!activeGateway,
    rotatingBackgrounds,
  });
}));

// Public, no JWT required - this is what the captive portal page (served to
// a customer's phone the moment they join the WiFi) calls after they type
// in their voucher code. siteId is embedded in the portal page's URL so we
// know which router/controller to talk to.
router.post('/:siteId/redeem', asyncHandler(async (req, res) => {
  const { siteId } = req.params;
  const { code, clientMac, apMac, ssidName, radioId, baseGrantUrl, continueUrl } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });

  const { rows } = await pool.query('SELECT tenant_id FROM sites WHERE id=$1', [siteId]);
  if (!rows.length) return res.status(404).json({ error: 'Unknown site' });
  const tenantId = rows[0].tenant_id;

  try {
    const result = await voucherService.redeemVoucher(tenantId, code.trim().toUpperCase(), {
      clientMac, apMac, ssidName, radioId, baseGrantUrl, continueUrl,
    });
    if (!result.ok) {
      // Return a reason CODE, not English text - the portal page translates
      // it into whichever language the customer has selected.
      return res.status(400).json({ error: true, reason: result.reason || 'redemption_failed' });
    }
    // redirectUrl is only present for Meraki - the portal page must send
    // the customer's OWN browser there to actually complete the grant
    // (see src/integrations/meraki.js for why). Every other provider
    // authorizes server-side already, so this is null for them.
    res.json({ ok: true, expiresAt: result.expiresAt, redirectUrl: result.redirectUrl || null });
  } catch (err) {
    // Router/controller unreachable, wrong credentials, etc. - surfaced
    // honestly rather than silently marking the voucher as used.
    res.status(502).json({ error: true, reason: 'network_error', detail: err.message });
  }
}));

// Shared: once a gateway confirms payment succeeded, generate the actual
// voucher, mark the order paid, and get it to the customer. See
// voucherService.fulfillOrder - shared with the owner's manual-MoMo
// approval path in routes/vouchers.js, so both roads to "paid" end up
// issuing the voucher and sending the SMS the exact same way.
const fulfillOrder = voucherService.fulfillOrder;

// PUBLIC: customer picks a package on the portal and pays online instead of
// using a printed/MoMo-manual code. Works with whichever gateway the
// tenant has activated (Paystack, Hubtel, or Flutterwave) - the customer
// never needs to know which one.
router.post('/:siteId/buy-voucher', asyncHandler(async (req, res) => {
  const { siteId } = req.params;
  const { packageId, email, phone } = req.body;
  if (!packageId) return res.status(400).json({ error: 'packageId is required' });

  const { rows } = await pool.query(
    `SELECT s.tenant_id, t.currency FROM sites s JOIN tenants t ON t.id = s.tenant_id WHERE s.id=$1`,
    [siteId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Unknown site' });
  const tenantId = rows[0].tenant_id;
  const currency = rows[0].currency;

  const { rows: pkgRows } = await pool.query('SELECT * FROM packages WHERE id=$1 AND tenant_id=$2', [packageId, tenantId]);
  if (!pkgRows.length) return res.status(404).json({ error: 'Package not found' });
  const pkg = pkgRows[0];

  const activeGateway = await gatewayService.getActiveGateway(tenantId);
  if (!activeGateway) return res.status(400).json({ error: 'This WiFi provider has not set up online payment yet.' });

  const reference = `YN-${uuidv4().slice(0, 12)}`;
  const base = process.env.APP_BASE_URL;
  // Hubtel's webhook has no built-in signature - see utils/webhookToken.js
  // for why this token is appended to ITS callback URL specifically, and
  // not needed for Paystack/Flutterwave (those are verified independently
  // via gateway-callback below, never trusting the redirect/body alone).
  const hubtelToken = activeGateway.provider === 'hubtel' ? webhookToken.generateToken() : null;
  const callbackUrl = activeGateway.provider === 'hubtel'
    ? `${base}/portal/gateway-webhook/hubtel?wt=${hubtelToken.raw}`
    : `${base}/portal/gateway-callback/${activeGateway.provider}`;

  try {
    const checkout = await gatewayService.initializeCheckout(tenantId, {
      amountGHS: Number(pkg.price),
      currency,
      email: email || 'customer@example.com',
      phone,
      reference,
      callbackUrl,
      returnUrl: `${base}/portal/${siteId}/order-status?ref=${reference}`,
      description: `${pkg.label} - YourNet WiFi`,
    });

    await pool.query(
      `INSERT INTO voucher_orders (tenant_id, site_id, package_id, customer_email, customer_phone, provider, provider_reference, webhook_token_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, siteId, packageId, email || null, phone || null, checkout.provider, checkout.reference, hubtelToken?.hash || null]
    );

    res.json({ checkoutUrl: checkout.checkoutUrl, provider: checkout.provider, reference: checkout.reference });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// PUBLIC: fallback for tenants who haven't set up a real payment gateway.
// The customer has (or is about to) send money directly to the owner's
// personal MoMo number shown on the portal - this just records the claim
// as PENDING so it lands in the owner's dashboard queue. Nothing is
// verified here and no voucher is created yet: there is no API that lets
// this app confirm a P2P MoMo transfer actually happened, so the owner
// checking their own MoMo alert and clicking "Approve" (see routes/
// vouchers.js /manual-orders/:id/approve) is the real trust boundary, not
// this submission.
router.post('/:siteId/buy-voucher-manual', asyncHandler(async (req, res) => {
  const { siteId } = req.params;
  const { packageId, phone, note } = req.body;
  if (!packageId) return res.status(400).json({ error: 'packageId is required' });
  if (!phone) return res.status(400).json({ error: 'A phone number is required so we can send your voucher once approved.' });

  const { rows } = await pool.query('SELECT tenant_id, portal_momo_number FROM sites WHERE id=$1', [siteId]);
  if (!rows.length) return res.status(404).json({ error: 'Unknown site' });
  const { tenant_id: tenantId, portal_momo_number: momoNumber } = rows[0];
  if (!momoNumber) return res.status(400).json({ error: 'Manual MoMo payment is not set up for this WiFi provider.' });

  const { rows: pkgRows } = await pool.query('SELECT id FROM packages WHERE id=$1 AND tenant_id=$2 AND active=true', [packageId, tenantId]);
  if (!pkgRows.length) return res.status(404).json({ error: 'Package not found' });

  const reference = `MANUAL-${uuidv4().slice(0, 12)}`;
  const { rows: orderRows } = await pool.query(
    `INSERT INTO voucher_orders (tenant_id, site_id, package_id, customer_phone, customer_note, provider, provider_reference)
     VALUES ($1,$2,$3,$4,$5,'manual_momo',$6) RETURNING id, created_at`,
    [tenantId, siteId, packageId, phone, note || null, reference]
  );

  res.json({ ok: true, orderId: orderRows[0].id, status: 'pending' });
}));

// PUBLIC: Paystack/Flutterwave redirect the customer's browser here after
// payment. We verify server-side (never trust the redirect alone) before
// issuing anything.
router.get('/gateway-callback/:provider', asyncHandler(async (req, res) => {
  const { provider } = req.params;
  const reference = req.query.reference || req.query.tx_ref || req.query.trxref;
  const transactionId = req.query.transaction_id; // Flutterwave-specific

  const { rows } = await pool.query(
    `SELECT vo.*, p.price AS package_price
     FROM voucher_orders vo JOIN packages p ON p.id = vo.package_id
     WHERE vo.provider=$1 AND vo.provider_reference=$2`,
    [provider, reference]
  );
  if (!rows.length) return res.status(404).send('Order not found.');
  const order = rows[0];

  if (order.status === 'paid') {
    return res.send(orderConfirmationPage('Already confirmed', 'This order was already completed.'));
  }

  try {
    const result = await gatewayService.verifyCheckout(
      order.tenant_id, provider, provider === 'flutterwave' ? transactionId : reference
    );
    if (!result.success) {
      await pool.query(`UPDATE voucher_orders SET status='failed' WHERE id=$1`, [order.id]);
      return res.send(orderConfirmationPage('Payment failed', 'No voucher was issued.'));
    }

    // SECURITY: `reference` (used to look up the order above) and
    // `transactionId` (used to verify with Flutterwave) are two
    // independent, client-supplied query params - Flutterwave's verify-by-
    // transactionId API doesn't tie them together on its own. Without this
    // check, someone could pay for a cheap package, grab that payment's
    // transactionId, then hit this callback again with a DIFFERENT,
    // pricier order's reference and their own cheap transactionId: the
    // verify call would still report success (it's a real, paid
    // transaction - just not for this order), and fulfillOrder would issue
    // the expensive package anyway. Confirming the verified transaction's
    // own tx_ref matches this order's reference, and that its amount
    // covers this order's package price, closes that gap. Paystack doesn't
    // need this: its verify call is keyed by the SAME reference used to
    // look up the order, so there's no separate transactionId to mismatch.
    if (provider === 'flutterwave') {
      if (result.reference !== order.provider_reference) {
        await pool.query(`UPDATE voucher_orders SET status='failed' WHERE id=$1`, [order.id]);
        return res.send(orderConfirmationPage('Payment could not be verified', 'This transaction does not match this order.'));
      }
      if (Math.round(Number(result.amountGHS) * 100) < Math.round(Number(order.package_price) * 100)) {
        await pool.query(`UPDATE voucher_orders SET status='failed' WHERE id=$1`, [order.id]);
        return res.send(orderConfirmationPage('Payment could not be verified', 'The amount paid does not match this order.'));
      }
    }

    // fulfillOrder claims the order atomically - a null back means another
    // concurrent hit on this same reference (retry, refreshed tab) already
    // won the race, not that anything failed here.
    const voucher = await fulfillOrder(order);
    if (!voucher) {
      return res.send(orderConfirmationPage('Already confirmed', 'This order was already completed.'));
    }
    // Same auto-connect treatment as the QR-scan path (see /:id/qrcode in
    // routes/vouchers.js and portal.html's ?code= handling): send the
    // browser straight to the portal page with the code pre-filled and
    // auto-submitted, instead of leaving the customer to copy the code off
    // this plain confirmation page and paste it in manually. Falls back to
    // showing the bare code with no link if APP_BASE_URL isn't configured,
    // so this never produces a broken link - same fallback used for the QR.
    const base = process.env.APP_BASE_URL;
    if (base) {
      const connectUrl = `${base}/p/${order.site_id}?code=${encodeURIComponent(voucher.code)}`;
      res.send(orderConfirmationPage(
        'Payment successful',
        `Your voucher code: <strong>${voucher.code}</strong><br><br>` +
        `<a href="${connectUrl}" style="color:#4fd1c5">Tap here to connect now</a>`,
        connectUrl
      ));
    } else {
      res.send(orderConfirmationPage('Payment successful', `Your voucher code: <strong>${voucher.code}</strong>`));
    }
  } catch (err) {
    res.status(502).send('Could not verify payment: ' + err.message);
  }
}));

// PUBLIC: Paystack's server-to-server webhook for TENANT customer voucher
// purchases - a second, independent path to fulfillment alongside the
// redirect-based /gateway-callback/paystack above, same reason it exists
// on the owner's license flow (routes/license.js): a customer can pay
// successfully and then close the tab/lose signal before the redirect
// back to us ever fires, and without this the voucher would just never
// get issued even though they were charged.
//
// One important difference from the owner's webhook: THAT one has a
// single Paystack account, so one env-var secret key verifies every
// event. Here, every tenant has their OWN separate Paystack account with
// their OWN secret key - but Paystack only supports ONE fixed webhook URL
// per account (unlike callback_url, which can be set per-transaction), so
// there's no way to bake a tenant identifier into a per-order URL the way
// Hubtel's `wt` token does. Solving this any other way (e.g. a URL with
// the tenant/site id baked in) would mean handing every tenant a
// different URL to go paste into their own dashboard - easy to mess up.
// Instead every tenant pastes this SAME url into their own Paystack
// account's webhook settings, and the order lookup below (by the
// reference Paystack sends back, which we generated) is what identifies
// WHICH tenant's secret key to check the signature against. This is safe
// specifically because nothing is trusted until the signature check
// passes: an attacker who doesn't already know a real (UUID-based, hard
// to guess) order reference gets rejected at the lookup; one who does
// still needs that SPECIFIC tenant's real Paystack secret key to produce
// a valid signature, which only that tenant's own Paystack account has.
router.post('/gateway-webhook/paystack', asyncHandler(async (req, res) => {
  const event = req.body || {};
  if (event.event !== 'charge.success') return res.json({ received: true });

  const reference = event.data?.reference;
  if (!reference) return res.json({ received: true });

  const { rows } = await pool.query(
    `SELECT * FROM voucher_orders WHERE provider='paystack' AND provider_reference=$1`,
    [reference]
  );
  if (!rows.length) return res.json({ received: true }); // not one of ours - ignore
  const order = rows[0];

  const secretKey = await gatewayService.getPaystackSecretKey(order.tenant_id);
  const validSignature = paystackGateway.verifyWebhookSignature({
    secretKey,
    rawBody: req.rawBody,
    signature: req.headers['x-paystack-signature'],
  });
  if (!validSignature) return res.status(401).json({ error: 'Invalid signature' });

  if (order.status === 'paid') return res.json({ received: true, note: 'already fulfilled' });

  // Re-verify directly with Paystack's API rather than trusting the
  // webhook payload's own amount/status fields for what gets issued -
  // same rule the redirect callback follows above.
  const result = await paystackGateway.verifyPayment({ secretKey, reference });
  if (!result.success) {
    await pool.query(`UPDATE voucher_orders SET status='failed' WHERE id=$1 AND status='pending'`, [order.id]);
    return res.json({ received: true });
  }

  // fulfillOrder's own atomic claim is what makes this safe to run
  // concurrently with the redirect callback firing for the same order -
  // whichever gets there first wins, the other gets `null` back and does
  // nothing further.
  await fulfillOrder(order);
  res.json({ received: true });
}));

// PUBLIC: Hubtel confirms payment via webhook (a server-to-server POST),
// not a browser redirect - there's no page to show the customer here, so
// SMS (handled in fulfillOrder) is the actual delivery channel for Hubtel
// orders. Logging the raw payload since webhook field names are worth
// double-checking against your live Hubtel account before fully trusting.
//
// SECURITY: Hubtel has no signature scheme on this webhook, so the `wt`
// query param (see utils/webhookToken.js) is the only thing standing
// between this endpoint and anyone who's ever called buy-voucher - which
// hands the same `reference` this webhook keys off of straight back in
// its own response. Reject outright if it's missing or doesn't match.
router.post('/gateway-webhook/hubtel', asyncHandler(async (req, res) => {
  logger.info('Hubtel webhook received', { body: req.body });
  const interpreted = hubtelGateway.interpretWebhook(req.body);

  if (!interpreted.reference) {
    return res.status(400).json({ error: 'No reference in webhook payload' });
  }

  const { rows } = await pool.query(
    `SELECT * FROM voucher_orders WHERE provider='hubtel' AND provider_reference=$1`,
    [interpreted.reference]
  );
  if (!rows.length) return res.status(404).json({ error: 'Order not found' });
  const order = rows[0];

  if (!webhookToken.tokensMatch(req.query.wt, order.webhook_token_hash)) {
    logger.error('Hubtel webhook token mismatch - possible forged callback', { reference: interpreted.reference });
    return res.status(401).json({ error: 'Invalid or missing webhook token' });
  }

  if (order.status === 'paid') return res.json({ ok: true, note: 'already fulfilled' });

  if (interpreted.success) {
    // Return value not needed here: whether this call won the claim or a
    // concurrent retry already did, the order ends up fulfilled either way.
    await fulfillOrder(order);
  } else {
    await pool.query(`UPDATE voucher_orders SET status='failed' WHERE id=$1`, [order.id]);
  }

  res.json({ ok: true });
}));

// redirectUrl, when given, mirrors the QR-scan path's "prefill + auto-
// submit" behavior: the browser is sent on to the portal page itself after
// a short pause (long enough for the customer to see their code first),
// where portal.html's own ?code= handling takes over and calls the exact
// same redeem() a manual entry or QR scan would - no gateway-specific
// behavior, just skipping the copy/paste step. The visible link is kept as
// a fallback for anyone who navigates away before the redirect fires.
function orderConfirmationPage(title, bodyHtml, redirectUrl) {
  const redirectTag = redirectUrl
    ? `<meta http-equiv="refresh" content="3;url=${redirectUrl}">`
    : '';
  return `
    <html><head>${redirectTag}</head><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0d1a1e;color:#e8f0f1">
      <h1>${title}</h1>
      <p>${bodyHtml}</p>
    </body></html>
  `;
}

module.exports = router;

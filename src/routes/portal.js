const express = require('express');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const voucherService = require('../services/voucherService');
const gatewayService = require('../services/paymentGatewayService');
const hubtelGateway = require('../integrations/gateways/hubtelGateway');
const sms = require('../integrations/smsService');
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
    `SELECT tenant_id, portal_business_name, portal_logo_url, portal_primary_color,
            portal_background_image_url, portal_caution_text, portal_whatsapp_number,
            portal_momo_number, portal_momo_name, portal_use_rotating_backgrounds
     FROM sites WHERE id=$1`,
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
    momoNumber: site.portal_momo_number,
    momoName: site.portal_momo_name,
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
// voucher, mark the order paid, and get it to the customer (SMS if we have
// their phone - the only reliable channel for a webhook flow with no
// browser to redirect back to, like Hubtel's).
async function fulfillOrder(order) {
  const vouchers = await voucherService.generateVouchers(order.tenant_id, {
    packageId: order.package_id,
    siteId: order.site_id,
    quantity: 1,
  });
  const voucher = vouchers[0];

  await pool.query(
    `UPDATE voucher_orders SET status='paid', voucher_id=$1, completed_at=now() WHERE id=$2`,
    [voucher.id, order.id]
  );

  if (order.customer_phone) {
    sms.sendSms(order.customer_phone, `Your YourNet WiFi voucher code: ${voucher.code}`).catch(() => {});
  }

  return voucher;
}

// PUBLIC: customer picks a package on the portal and pays online instead of
// using a printed/MoMo-manual code. Works with whichever gateway the
// tenant has activated (Paystack, Hubtel, or Flutterwave) - the customer
// never needs to know which one.
router.post('/:siteId/buy-voucher', asyncHandler(async (req, res) => {
  const { siteId } = req.params;
  const { packageId, email, phone } = req.body;
  if (!packageId) return res.status(400).json({ error: 'packageId is required' });

  const { rows } = await pool.query('SELECT tenant_id FROM sites WHERE id=$1', [siteId]);
  if (!rows.length) return res.status(404).json({ error: 'Unknown site' });
  const tenantId = rows[0].tenant_id;

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

// PUBLIC: Paystack/Flutterwave redirect the customer's browser here after
// payment. We verify server-side (never trust the redirect alone) before
// issuing anything.
router.get('/gateway-callback/:provider', asyncHandler(async (req, res) => {
  const { provider } = req.params;
  const reference = req.query.reference || req.query.tx_ref || req.query.trxref;
  const transactionId = req.query.transaction_id; // Flutterwave-specific

  const { rows } = await pool.query(
    `SELECT * FROM voucher_orders WHERE provider=$1 AND provider_reference=$2`,
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

    const voucher = await fulfillOrder(order);
    res.send(orderConfirmationPage('Payment successful', `Your voucher code: <strong>${voucher.code}</strong>`));
  } catch (err) {
    res.status(502).send('Could not verify payment: ' + err.message);
  }
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
    await fulfillOrder(order);
  } else {
    await pool.query(`UPDATE voucher_orders SET status='failed' WHERE id=$1`, [order.id]);
  }

  res.json({ ok: true });
}));

function orderConfirmationPage(title, bodyHtml) {
  return `
    <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0d1a1e;color:#e8f0f1">
      <h1>${title}</h1>
      <p>${bodyHtml}</p>
    </body></html>
  `;
}

module.exports = router;

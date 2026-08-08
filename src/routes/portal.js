const express = require('express');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const voucherService = require('../services/voucherService');
const gatewayService = require('../services/paymentGatewayService');
const hubtelGateway = require('../integrations/gateways/hubtelGateway');
const sms = require('../integrations/smsService');
const logger = require('../utils/logger');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

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
  // Hubtel confirms via a server-to-server webhook, not a browser redirect -
  // it needs a different URL shape than Paystack/Flutterwave's callback.
  const callbackUrl = activeGateway.provider === 'hubtel'
    ? `${base}/portal/gateway-webhook/hubtel`
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
      `INSERT INTO voucher_orders (tenant_id, site_id, package_id, customer_email, customer_phone, provider, provider_reference)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [tenantId, siteId, packageId, email || null, phone || null, checkout.provider, checkout.reference]
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

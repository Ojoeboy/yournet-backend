const express = require('express');
const pool = require('../db/pool');
const billing = require('../integrations/billing');
const license = require('../services/licenseService');
const sms = require('../integrations/smsService');
const validate = require('../utils/validate');
const asyncHandler = require('../utils/asyncHandler');
const { requireOwnerAuth } = require('../middleware/auth');

const router = express.Router();

const LICENSE_PRICE_GHS = Number(process.env.LICENSE_PRICE_GHS || 500);

// PUBLIC: start a Paystack payment for a license (card or Mobile Money via
// Paystack's own checkout). On success, a key is generated automatically -
// no manual step needed for this path.
router.post('/purchase/paystack/initialize', asyncHandler(async (req, res) => {
  const { email } = req.body;
  const validationError = validate.required(req.body, ['email']) || (!validate.isEmail(email) ? 'Please enter a valid email address.' : null);
  if (validationError) return res.status(400).json({ error: validationError });

  try {
    const result = await billing.initializePayment({
      email,
      amountGHS: LICENSE_PRICE_GHS,
      tenantId: null,
      planCode: 'license_purchase',
      callbackPath: '/license/purchase/paystack/callback',
    });
    res.json({ authorizationUrl: result.authorization_url, reference: result.reference });
  } catch (err) {
    res.status(502).json({ error: 'Could not start payment. Check Paystack API keys are configured.', detail: err.message });
  }
}));

// PUBLIC: Paystack redirects here after payment. Verify server-side, then
// generate the actual key and show it to the buyer once.
router.get('/purchase/paystack/callback', asyncHandler(async (req, res) => {
  const { reference } = req.query;
  if (!reference) return res.status(400).send('Missing payment reference.');

  try {
    const result = await billing.verifyPayment(reference);
    if (result.status !== 'success') {
      return res.send(renderPage('Payment failed', 'No key was issued. If you were charged, contact support.'));
    }

    const key = await license.issueKey({
      amount: LICENSE_PRICE_GHS,
      paymentMethod: 'paystack',
      paymentReference: reference,
      buyerEmail: result.customer?.email,
    });

    res.send(renderPage(
      'Payment successful - here is your activation key',
      `<div class="key">${key.key_code}</div>
       <p>Save this key now - you'll need it once, during signup at <a href="/admin">/admin</a>. It cannot be reused for a second business.</p>`
    ));
  } catch (err) {
    res.status(502).send('Could not verify payment: ' + err.message);
  }
}));

// PUBLIC: buyer submits proof after sending a direct MoMo transfer. This
// creates a real, server-side pending record - not just a WhatsApp message
// you might lose track of.
router.post('/momo-claim', asyncHandler(async (req, res) => {
  const { buyerName, buyerEmail, buyerPhone, businessName, momoReference, amount } = req.body;
  const validationError = validate.required(req.body, ['buyerEmail']) || (!validate.isEmail(buyerEmail) ? 'Please enter a valid email address.' : null);
  if (validationError) return res.status(400).json({ error: validationError });

  const { rows } = await pool.query(
    `INSERT INTO momo_payment_claims (buyer_name, buyer_email, buyer_phone, business_name, momo_reference, amount)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
    [buyerName || null, buyerEmail, buyerPhone || null, businessName || null, momoReference || null, amount || LICENSE_PRICE_GHS]
  );
  res.json({ ok: true, claimId: rows[0].id });
}));

// OWNER ONLY: see pending (and past) MoMo claims to review against your
// actual MoMo transaction history before approving.
router.get('/admin/momo-claims', requireOwnerAuth, asyncHandler(async (req, res) => {
  const { status } = req.query;
  // LEFT JOIN so approved claims carry their key_code permanently - without
  // this, the key was only ever visible in the approve() response, gone on
  // the next list refresh or page reload.
  const { rows } = await pool.query(
    status
      ? `SELECT c.*, k.key_code FROM momo_payment_claims c
         LEFT JOIN license_keys k ON k.id = c.issued_key_id
         WHERE c.status=$1 ORDER BY c.created_at DESC`
      : `SELECT c.*, k.key_code FROM momo_payment_claims c
         LEFT JOIN license_keys k ON k.id = c.issued_key_id
         ORDER BY c.created_at DESC LIMIT 200`,
    status ? [status] : []
  );
  res.json(rows);
}));

// OWNER ONLY: approve a claim - this is the moment a real key is generated
// and the claim is permanently linked to it. The buyer is notified by SMS
// (if they gave a phone number) AND their key is still shown to you here,
// since SMS delivery can fail silently.
router.post('/admin/momo-claims/:id/approve', requireOwnerAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM momo_payment_claims WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Claim not found' });
  const claim = rows[0];
  if (claim.status !== 'pending') return res.status(400).json({ error: `Claim already ${claim.status}` });

  const key = await license.issueKey({
    amount: claim.amount,
    paymentMethod: 'momo_manual',
    buyerEmail: claim.buyer_email,
    buyerPhone: claim.buyer_phone,
    notes: `MoMo ref: ${claim.momo_reference || 'none provided'}`,
  });

  await pool.query(
    `UPDATE momo_payment_claims SET status='approved', issued_key_id=$1, reviewed_at=now() WHERE id=$2`,
    [key.id, claim.id]
  );

  if (claim.buyer_phone) {
    sms.sendLicenseKeySms(claim.buyer_phone, key.key_code).catch(() => {});
  }

  res.json({ ok: true, key });
}));

// OWNER ONLY: reject a claim (e.g. no matching transaction found).
router.post('/admin/momo-claims/:id/reject', requireOwnerAuth, asyncHandler(async (req, res) => {
  await pool.query(
    `UPDATE momo_payment_claims SET status='rejected', reviewed_at=now() WHERE id=$1 AND status='pending'`,
    [req.params.id]
  );
  res.json({ ok: true });
}));

// OWNER ONLY: manually issue a key after confirming a direct MoMo transfer
// landed in the Snowy Enterprise MoMo account. Nothing here is automatic -
// Ghana P2P MoMo transfers aren't verifiable via API without a paid
// aggregator, so this is a deliberate manual step for you to confirm first.
router.post('/admin/issue-manual', requireOwnerAuth, asyncHandler(async (req, res) => {
  const { buyerPhone, buyerEmail, notes, amount } = req.body;
  const key = await license.issueKey({
    amount: amount || LICENSE_PRICE_GHS,
    paymentMethod: 'momo_manual',
    buyerPhone,
    buyerEmail,
    notes,
  });
  if (buyerPhone) sms.sendLicenseKeySms(buyerPhone, key.key_code).catch(() => {});
  res.json(key);
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
        padding:16px;display:inline-block;margin:20px 0}</style>
      ${bodyHtml}
    </body></html>
  `;
}

module.exports = router;

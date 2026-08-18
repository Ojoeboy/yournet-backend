const express = require('express');
const QRCode = require('qrcode');
const pool = require('../db/pool');
const { requireAuth, requireNotAgent } = require('../middleware/auth');
const voucherService = require('../services/voucherService');
const validate = require('../utils/validate');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(requireAuth, requireNotAgent);

router.post('/generate', asyncHandler(async (req, res) => {
  const { packageId, siteId, agentId, quantity, batch } = req.body;
  const missingError = validate.required(req.body, ['packageId', 'siteId', 'quantity']);
  if (missingError) return res.status(400).json({ error: missingError });
  if (!validate.isPositiveNumber(quantity)) return res.status(400).json({ error: 'Quantity must be a positive number.' });

  try {
    const vouchers = await voucherService.generateVouchers(req.tenantId, {
      packageId, siteId, agentId, quantity: Math.min(quantity, 500), batch,
    });
    res.json({ count: vouchers.length, vouchers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// What print.html needs once per page load, not per card: the tenant's
// business name (always set, used as the printed company name) and a
// logo to show alongside it. There's no tenant-level logo field - only
// per-site portal branding - so this picks the first site that has one
// configured. Good enough for the common case of one look across a
// tenant's sites; a tenant branding multiple sites differently can still
// filter the print list to one site/batch at a time.
router.get('/print-branding', asyncHandler(async (req, res) => {
  const { rows: tenantRows } = await pool.query('SELECT business_name FROM tenants WHERE id=$1', [req.tenantId]);
  const { rows: logoRows } = await pool.query(
    `SELECT portal_logo_url FROM sites WHERE tenant_id=$1 AND portal_logo_url IS NOT NULL AND portal_logo_url != '' ORDER BY name ASC LIMIT 1`,
    [req.tenantId]
  );
  res.json({
    businessName: tenantRows[0]?.business_name || 'WiFi Vouchers',
    logoUrl: logoRows[0]?.portal_logo_url || null,
  });
}));

router.get('/', asyncHandler(async (req, res) => {
  const { status, batch, agentId } = req.query;
  const clauses = ['v.tenant_id=$1'];
  const params = [req.tenantId];
  if (status) { params.push(status); clauses.push(`v.status=$${params.length}`); }
  if (batch) { params.push(batch); clauses.push(`v.batch=$${params.length}`); }
  if (agentId === 'none') {
    clauses.push('v.agent_id IS NULL');
  } else if (agentId) {
    params.push(agentId);
    clauses.push(`v.agent_id=$${params.length}`);
  }
  // Joined to packages (label/price/duration_minutes - what print.html
  // needs on the card), tenants (business_name - the printed company
  // name), and tenant_users (the assigned agent's name, if any), so the
  // print page can render everything from one call instead of stitching
  // together several round trips itself.
  const { rows } = await pool.query(
    `SELECT v.*, p.label AS package_label, p.price AS package_price, p.duration_minutes AS package_duration_minutes,
            t.business_name, a.name AS agent_name
     FROM vouchers v
     JOIN packages p ON p.id = v.package_id
     JOIN tenants t ON t.id = v.tenant_id
     LEFT JOIN tenant_users a ON a.id = v.agent_id
     WHERE ${clauses.join(' AND ')} ORDER BY v.created_at DESC LIMIT 500`,
    params
  );
  res.json(rows);
}));

router.get('/:id/qrcode', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT code, site_id FROM vouchers WHERE id=$1 AND tenant_id=$2', [
    req.params.id, req.tenantId,
  ]);
  if (!rows.length) return res.status(404).end();

  // Encodes the portal URL with the code embedded (?code=XXXX-XXXX), not
  // just the bare code. A generic QR scanner opens straight to the
  // customer's portal page with the code pre-filled and auto-submitted
  // (see portal.html) - a real "scan to connect" instead of "scan to read
  // the code, then still have to type it in". Falls back to encoding the
  // plain code if APP_BASE_URL isn't configured, so this never produces a
  // broken/unusable QR in an environment that's missing it.
  const base = process.env.APP_BASE_URL;
  const payload = base
    ? `${base}/p/${rows[0].site_id}?code=${encodeURIComponent(rows[0].code)}`
    : rows[0].code;
  const png = await QRCode.toBuffer(payload, { width: 240, margin: 1 });
  res.type('png').send(png);
}));

// Delete a single voucher - but only when doing so can't strand or cut off
// a real customer:
//   - 'unused'                              -> safe, never touched anyone.
//   - 'redeeming' (mid-flight right now)     -> blocked; let it finish first,
//                                               it'll land on 'active' or
//                                               get released back to 'unused'.
//   - 'active' with expires_at still ahead   -> blocked; this is a LIVE
//                                               session - deleting the row
//                                               doesn't disconnect the
//                                               customer (the router grants
//                                               access independently), it
//                                               just destroys the record
//                                               while they're still using it.
//   - 'active' with expires_at already past  -> safe; there's a schema quirk
//                                               worth knowing - nothing ever
//                                               flips status to 'expired',
//                                               so a lapsed session still
//                                               reads as 'active' in the DB.
//                                               expires_at, not status, is
//                                               what actually tells you the
//                                               session is over.
router.delete('/:id', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT id, status, expires_at FROM vouchers WHERE id=$1 AND tenant_id=$2', [
    req.params.id, req.tenantId,
  ]);
  if (!rows.length) return res.status(404).json({ error: 'Voucher not found.' });
  const v = rows[0];

  if (v.status === 'redeeming') {
    return res.status(409).json({ error: 'This voucher is mid-redemption right now. Try again in a moment.' });
  }
  if (v.status === 'active' && (!v.expires_at || new Date(v.expires_at) > new Date())) {
    return res.status(409).json({ error: 'This voucher has an active session and can\u2019t be deleted while in use. It can be deleted once the session expires.' });
  }

  await pool.query('DELETE FROM vouchers WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
  res.json({ ok: true });
}));

// Pending manual-MoMo voucher claims - customers who said they'd pay the
// owner's personal MoMo number directly (no gateway configured). Nothing
// here has been verified against any payment API; this is what the owner
// checks against their own MoMo alert before approving.
router.get('/manual-orders', asyncHandler(async (req, res) => {
  const { status } = req.query;
  const { rows } = await pool.query(
    `SELECT vo.id, vo.customer_phone, vo.customer_note, vo.status, vo.created_at, vo.completed_at,
            p.label AS package_label, p.price AS package_price, s.name AS site_name
     FROM voucher_orders vo
     JOIN packages p ON p.id = vo.package_id
     JOIN sites s ON s.id = vo.site_id
     WHERE vo.tenant_id=$1 AND vo.provider='manual_momo' AND vo.status = $2
     ORDER BY vo.created_at DESC LIMIT 200`,
    [req.tenantId, status === 'paid' || status === 'failed' ? status : 'pending']
  );
  res.json(rows);
}));

// Owner confirms they actually received the MoMo transfer (checked against
// their own phone's MoMo alert, outside this app) - THIS click is the real
// verification step, since there's no API to confirm a P2P transfer for
// us. Issues the voucher and SMS's it to the phone number the customer
// gave, same as an automatic gateway order.
router.post('/manual-orders/:id/approve', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM voucher_orders WHERE id=$1 AND tenant_id=$2 AND provider='manual_momo'`,
    [req.params.id, req.tenantId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Order not found.' });
  const order = rows[0];
  if (order.status !== 'pending') return res.status(409).json({ error: `This order is already ${order.status}.` });

  try {
    // fulfillOrder does its own atomic pending->fulfilling claim, so the
    // status check above is just for a fast, friendly error message - it's
    // not what actually prevents a double-approve race.
    const voucher = await voucherService.fulfillOrder(order);
    if (!voucher) return res.status(409).json({ error: 'This order was already resolved.' });
    res.json({ ok: true, voucher });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// Owner declines a claim (no MoMo alert found, wrong amount, etc.) - no
// voucher is ever created for it.
router.post('/manual-orders/:id/reject', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE voucher_orders SET status='failed', completed_at=now()
     WHERE id=$1 AND tenant_id=$2 AND provider='manual_momo' AND status='pending' RETURNING id`,
    [req.params.id, req.tenantId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Order not found or already resolved.' });
  res.json({ ok: true });
}));

module.exports = router;

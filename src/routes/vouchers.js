const express = require('express');
const QRCode = require('qrcode');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const voucherService = require('../services/voucherService');
const validate = require('../utils/validate');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(requireAuth);

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

router.get('/', asyncHandler(async (req, res) => {
  const { status, batch } = req.query;
  const clauses = ['tenant_id=$1'];
  const params = [req.tenantId];
  if (status) { params.push(status); clauses.push(`status=$${params.length}`); }
  if (batch) { params.push(batch); clauses.push(`batch=$${params.length}`); }
  const { rows } = await pool.query(
    `SELECT * FROM vouchers WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT 500`,
    params
  );
  res.json(rows);
}));

router.get('/:id/qrcode', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT code FROM vouchers WHERE id=$1 AND tenant_id=$2', [
    req.params.id, req.tenantId,
  ]);
  if (!rows.length) return res.status(404).end();

  // Encoding just the plain code (not a full URL) keeps this scannable by
  // any generic QR reader and simple to key into the portal by hand too.
  const png = await QRCode.toBuffer(rows[0].code, { width: 240, margin: 1 });
  res.type('png').send(png);
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
    const voucher = await voucherService.fulfillOrder(order);
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

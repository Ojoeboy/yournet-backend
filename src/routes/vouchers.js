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

module.exports = router;

const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const validate = require('../utils/validate');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(requireAuth);

router.post('/', asyncHandler(async (req, res) => {
  const { label, price, durationMinutes, rateLimitDown, rateLimitUp } = req.body;
  const missingError = validate.required(req.body, ['label', 'price', 'durationMinutes']);
  if (missingError) return res.status(400).json({ error: missingError });
  if (!validate.isNonEmptyString(label, 100)) return res.status(400).json({ error: 'Label must be text, up to 100 characters.' });
  if (!validate.isPositiveNumber(price)) return res.status(400).json({ error: 'Price must be a positive number.' });
  if (!validate.isPositiveNumber(durationMinutes)) return res.status(400).json({ error: 'Duration must be a positive number of minutes.' });

  const { rows } = await pool.query(
    `INSERT INTO packages (tenant_id, label, price, duration_minutes, rate_limit_down, rate_limit_up)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.tenantId, label, price, durationMinutes, rateLimitDown || null, rateLimitUp || null]
  );
  res.json(rows[0]);
}));

router.get('/', asyncHandler(async (req, res) => {
  // Voucher-generation dropdowns should only ever see live pricing, so the
  // default stays active-only. The package-management screen passes
  // ?all=true to see everything, including deactivated packages, so old
  // prices remain visible/manageable without resurrecting them for new
  // vouchers.
  const includeInactive = req.query.all === 'true';
  const { rows } = await pool.query(
    `SELECT * FROM packages WHERE tenant_id=$1 ${includeInactive ? '' : 'AND active=true'} ORDER BY price ASC`,
    [req.tenantId]
  );
  res.json(rows);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const { rows: existing } = await pool.query('SELECT * FROM packages WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
  if (!existing.length) return res.status(404).json({ error: 'Package not found.' });

  const { label, price, durationMinutes, rateLimitDown, rateLimitUp, active } = req.body;
  if (label !== undefined && !validate.isNonEmptyString(label, 100)) return res.status(400).json({ error: 'Label must be text, up to 100 characters.' });
  if (price !== undefined && !validate.isPositiveNumber(price)) return res.status(400).json({ error: 'Price must be a positive number.' });
  if (durationMinutes !== undefined && !validate.isPositiveNumber(durationMinutes)) return res.status(400).json({ error: 'Duration must be a positive number of minutes.' });

  const { rows } = await pool.query(
    `UPDATE packages SET
       label = COALESCE($1, label),
       price = COALESCE($2, price),
       duration_minutes = COALESCE($3, duration_minutes),
       rate_limit_down = CASE WHEN $4::boolean THEN $5 ELSE rate_limit_down END,
       rate_limit_up = CASE WHEN $6::boolean THEN $7 ELSE rate_limit_up END,
       active = COALESCE($8, active)
     WHERE id=$9 AND tenant_id=$10 RETURNING *`,
    [
      label ?? null, price ?? null, durationMinutes ?? null,
      rateLimitDown !== undefined, rateLimitDown ?? null,
      rateLimitUp !== undefined, rateLimitUp ?? null,
      active ?? null, req.params.id, req.tenantId,
    ]
  );
  res.json(rows[0]);
}));

// Packages are only ever hard-deleted if nothing references them yet -
// vouchers.package_id and voucher_orders.package_id both point at this
// table with no CASCADE, specifically so a real customer's voucher/order
// history can never be silently orphaned by deleting the package it was
// bought under. If a package HAS been used, the honest move (and the one
// this returns as guidance) is to deactivate it instead - old vouchers
// keep working, it just stops appearing for new ones.
router.delete('/:id', asyncHandler(async (req, res) => {
  const { rows: existing } = await pool.query('SELECT id FROM packages WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
  if (!existing.length) return res.status(404).json({ error: 'Package not found.' });

  const { rows: usage } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM vouchers WHERE package_id=$1)::int AS voucher_count,
       (SELECT COUNT(*) FROM voucher_orders WHERE package_id=$1)::int AS order_count`,
    [req.params.id]
  );
  const used = usage[0].voucher_count + usage[0].order_count;
  if (used > 0) {
    return res.status(409).json({
      error: `This package has already been used for ${used} voucher(s)/order(s), so deleting it would break that history. Deactivate it instead - it'll stop appearing for new vouchers but existing ones keep working.`,
      usedCount: used,
    });
  }

  await pool.query('DELETE FROM packages WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
  res.json({ ok: true });
}));

module.exports = router;

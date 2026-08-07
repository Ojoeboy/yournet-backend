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
  const { rows } = await pool.query(
    `SELECT * FROM packages WHERE tenant_id=$1 AND active=true ORDER BY price ASC`,
    [req.tenantId]
  );
  res.json(rows);
}));

module.exports = router;

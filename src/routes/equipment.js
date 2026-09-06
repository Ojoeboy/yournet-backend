const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const validate = require('../utils/validate');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(requireAuth);

const CATEGORIES = ['router', 'access_point', 'switch', 'cpe', 'power_equipment', 'server', 'other'];
const STATUSES = ['in_service', 'spare', 'faulty', 'retired'];

// List equipment for the tenant, optionally filtered by site/category/status.
// GET /equipment?site_id=&category=&status=
router.get('/', asyncHandler(async (req, res) => {
  const { site_id, category, status } = req.query;
  const conditions = ['tenant_id = $1'];
  const params = [req.tenantId];

  if (site_id) {
    params.push(site_id);
    conditions.push(`site_id = $${params.length}`);
  }
  if (category) {
    if (!CATEGORIES.includes(category)) return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
    params.push(category);
    conditions.push(`category = $${params.length}`);
  }
  if (status) {
    if (!STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }

  const { rows } = await pool.query(
    `SELECT e.*, s.name AS site_name
       FROM equipment e
       LEFT JOIN sites s ON s.id = e.site_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY e.created_at DESC`,
    params
  );
  res.json(rows);
}));

// Add a new piece of equipment.
// POST /equipment
router.post('/', asyncHandler(async (req, res) => {
  const { site_id, category, brand, model, serial_number, mac_address, status, purchase_date, notes } = req.body;

  const missingError = validate.required(req.body, ['category']);
  if (missingError) return res.status(400).json({ error: missingError });
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });

  if (site_id) {
    const siteCheck = await pool.query('SELECT id FROM sites WHERE id = $1 AND tenant_id = $2', [site_id, req.tenantId]);
    if (siteCheck.rows.length === 0) return res.status(400).json({ error: 'site_id does not belong to this tenant' });
  }

  const { rows } = await pool.query(
    `INSERT INTO equipment
       (tenant_id, site_id, category, brand, model, serial_number, mac_address, status, purchase_date, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [req.tenantId, site_id || null, category, brand, model, serial_number, mac_address, status || 'in_service', purchase_date || null, notes]
  );
  res.status(201).json(rows[0]);
}));

// Update an existing piece of equipment (e.g. reassign site, mark faulty/retired).
// PATCH /equipment/:id
router.patch('/:id', asyncHandler(async (req, res) => {
  const { site_id, category, brand, model, serial_number, mac_address, status, purchase_date, notes } = req.body;

  if (category && !CATEGORIES.includes(category)) return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });

  if (site_id) {
    const siteCheck = await pool.query('SELECT id FROM sites WHERE id = $1 AND tenant_id = $2', [site_id, req.tenantId]);
    if (siteCheck.rows.length === 0) return res.status(400).json({ error: 'site_id does not belong to this tenant' });
  }

  const { rows } = await pool.query(
    `UPDATE equipment SET
       site_id = COALESCE($1, site_id),
       category = COALESCE($2, category),
       brand = COALESCE($3, brand),
       model = COALESCE($4, model),
       serial_number = COALESCE($5, serial_number),
       mac_address = COALESCE($6, mac_address),
       status = COALESCE($7, status),
       purchase_date = COALESCE($8, purchase_date),
       notes = COALESCE($9, notes),
       updated_at = now()
     WHERE id = $10 AND tenant_id = $11
     RETURNING *`,
    [site_id, category, brand, model, serial_number, mac_address, status, purchase_date, notes, req.params.id, req.tenantId]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Equipment not found' });
  res.json(rows[0]);
}));

// Remove an equipment record entirely (use PATCH status='retired' to keep history instead).
// DELETE /equipment/:id
router.delete('/:id', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'DELETE FROM equipment WHERE id = $1 AND tenant_id = $2 RETURNING id',
    [req.params.id, req.tenantId]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Equipment not found' });
  res.json({ success: true });
}));

module.exports = router;

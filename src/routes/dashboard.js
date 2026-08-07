const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const mikrotik = require('../integrations/mikrotik');
const { decrypt } = require('../utils/credentialCrypto');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(requireAuth);

router.get('/summary', asyncHandler(async (req, res) => {
  const { rows: totals } = await pool.query(
    `SELECT
       COUNT(*) AS total_vouchers,
       COUNT(*) FILTER (WHERE status != 'unused') AS redeemed_vouchers,
       COUNT(*) FILTER (WHERE status = 'unused') AS unused_vouchers
     FROM vouchers WHERE tenant_id = $1`,
    [req.tenantId]
  );

  const { rows: revenueRows } = await pool.query(
    `SELECT COALESCE(SUM(p.price), 0) AS revenue
     FROM vouchers v JOIN packages p ON p.id = v.package_id
     WHERE v.tenant_id = $1 AND v.status != 'unused'`,
    [req.tenantId]
  );

  const { rows: sites } = await pool.query(
    `SELECT id, name, type, status FROM sites WHERE tenant_id = $1`,
    [req.tenantId]
  );

  const { rows: topPackages } = await pool.query(
    `SELECT p.label, COUNT(*) AS sold
     FROM vouchers v JOIN packages p ON p.id = v.package_id
     WHERE v.tenant_id = $1 AND v.status != 'unused'
     GROUP BY p.label ORDER BY sold DESC LIMIT 5`,
    [req.tenantId]
  );

  res.json({
    totalVouchers: Number(totals[0].total_vouchers),
    redeemedVouchers: Number(totals[0].redeemed_vouchers),
    unusedVouchers: Number(totals[0].unused_vouchers),
    revenue: Number(revenueRows[0].revenue),
    sites,
    topPackages,
  });
}));

// Live client count for a specific site - actually queries the router,
// rather than showing a placeholder. Only implemented for Mikrotik sites
// so far (Omada's client-list call already exists in integrations/omada.js
// and can be wired in the same way later).
router.get('/sites/:id/live', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM sites WHERE id=$1 AND tenant_id=$2', [
    req.params.id, req.tenantId,
  ]);
  if (!rows.length) return res.status(404).json({ error: 'Site not found' });
  const site = rows[0];

  if (site.type !== 'mikrotik') {
    return res.status(400).json({ error: 'Live client view only supports Mikrotik sites right now.' });
  }

  try {
    const clients = await mikrotik.listActiveClients({
      ...site,
      mk_password_decrypted: decrypt(site.mk_password_encrypted),
    });
    res.json({ clients, count: clients.length });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach the router.', detail: err.message });
  }
}));

module.exports = router;

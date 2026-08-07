const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const validate = require('../utils/validate');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(requireAuth);

router.post('/', asyncHandler(async (req, res) => {
  const { name, email, commissionPct, password } = req.body;
  if (!validate.isNonEmptyString(name, 100)) return res.status(400).json({ error: 'A valid agent name is required.' });
  if (commissionPct !== undefined && (Number(commissionPct) < 0 || Number(commissionPct) > 100)) {
    return res.status(400).json({ error: 'Commission percentage must be between 0 and 100.' });
  }

  const passwordHash = await bcrypt.hash(password || Math.random().toString(36), 10);
  const { rows } = await pool.query(
    `INSERT INTO tenant_users (tenant_id, name, email, role, password_hash, commission_pct)
     VALUES ($1,$2,$3,'agent',$4,$5) RETURNING id, name, email, commission_pct`,
    [req.tenantId, name, email || null, passwordHash, commissionPct || 10]
  );
  res.json(rows[0]);
}));

router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, email, commission_pct, created_at FROM tenant_users
     WHERE tenant_id=$1 AND role='agent' ORDER BY created_at DESC`,
    [req.tenantId]
  );
  res.json(rows);
}));

// Per-agent sales summary: how many vouchers they've sold (redeemed = paid),
// how much revenue that represents, and what their commission comes to.
router.get('/:id/summary', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE v.status != 'unused') AS vouchers_sold,
       COALESCE(SUM(p.price) FILTER (WHERE v.status != 'unused'), 0) AS revenue,
       tu.commission_pct
     FROM tenant_users tu
     LEFT JOIN vouchers v ON v.agent_id = tu.id
     LEFT JOIN packages p ON p.id = v.package_id
     WHERE tu.id = $1 AND tu.tenant_id = $2
     GROUP BY tu.commission_pct`,
    [req.params.id, req.tenantId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Agent not found' });

  const row = rows[0];
  const revenue = Number(row.revenue);
  const commissionOwed = (revenue * Number(row.commission_pct)) / 100;
  res.json({
    vouchersSold: Number(row.vouchers_sold),
    revenue,
    commissionPct: Number(row.commission_pct),
    commissionOwed: Math.round(commissionOwed * 100) / 100,
  });
}));

// Daily settlement sheet: for a given agent and date, breaks down how many
// vouchers of each package they were given vs. actually sold (redeemed),
// the resulting sales total, commission owed, and cash to return. This is
// the reconciliation an agent hands over at the end of a shift.
router.get('/:id/settlement', asyncHandler(async (req, res) => {
  const { date, batch } = req.query; // date: YYYY-MM-DD (matches created_at day)

  const { rows: agentRows } = await pool.query(
    `SELECT id, name, commission_pct FROM tenant_users WHERE id=$1 AND tenant_id=$2`,
    [req.params.id, req.tenantId]
  );
  if (!agentRows.length) return res.status(404).json({ error: 'Agent not found' });
  const agent = agentRows[0];

  const conditions = ['v.agent_id = $1'];
  const params = [req.params.id];
  if (date) {
    params.push(date);
    conditions.push(`v.created_at::date = $${params.length}`);
  }
  if (batch) {
    params.push(batch);
    conditions.push(`v.batch = $${params.length}`);
  }

  const { rows: lines } = await pool.query(
    `SELECT p.label, p.price,
       COUNT(*) AS given,
       COUNT(*) FILTER (WHERE v.status != 'unused') AS sold
     FROM vouchers v JOIN packages p ON p.id = v.package_id
     WHERE ${conditions.join(' AND ')}
     GROUP BY p.label, p.price
     ORDER BY p.price ASC`,
    params
  );

  let totalSales = 0;
  const items = lines.map((l) => {
    const sales = Number(l.sold) * Number(l.price);
    totalSales += sales;
    return {
      label: l.label,
      price: Number(l.price),
      given: Number(l.given),
      sold: Number(l.sold),
      sales,
    };
  });

  const commissionOwed = Math.round(((totalSales * Number(agent.commission_pct)) / 100) * 100) / 100;
  const cashToReturn = Math.round((totalSales - commissionOwed) * 100) / 100;

  res.json({
    agent: { id: agent.id, name: agent.name, commissionPct: Number(agent.commission_pct) },
    date: date || null,
    batch: batch || null,
    items,
    totalSales,
    commissionOwed,
    cashToReturn,
  });
}));

module.exports = router;

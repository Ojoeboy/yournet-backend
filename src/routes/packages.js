const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireNotAgent } = require('../middleware/auth');
const validate = require('../utils/validate');
const asyncHandler = require('../utils/asyncHandler');
const { listPackagesWithEffectivePrice } = require('../utils/pricing');

const router = express.Router();
router.use(requireAuth, requireNotAgent);

router.post('/', asyncHandler(async (req, res) => {
  const { label, price, durationMinutes, rateLimitDown, rateLimitUp } = req.body;
  const missingError = validate.required(req.body, ['label', 'price', 'durationMinutes']);
  if (missingError) return res.status(400).json({ error: missingError });
  if (!validate.isNonEmptyString(label, 100)) return res.status(400).json({ error: 'Label must be text, up to 100 characters.' });
  if (!validate.isPositiveNumber(price)) return res.status(400).json({ error: 'Price must be a positive number.' });
  if (!validate.isPositiveNumber(durationMinutes)) return res.status(400).json({ error: 'Duration must be a positive number of minutes.' });

  // Backstop for a double-submit slipping past the button guard (retried
  // request on a flaky connection, etc.) - if the exact same package was
  // just created seconds ago, treat this as the same click landing twice
  // rather than creating a second identical row that would then just show
  // up twice on the portal.
  const { rows: recentDup } = await pool.query(
    `SELECT * FROM packages
     WHERE tenant_id=$1 AND label=$2 AND price=$3 AND duration_minutes=$4
       AND created_at > now() - interval '10 seconds'
     ORDER BY created_at DESC LIMIT 1`,
    [req.tenantId, label, price, durationMinutes]
  );
  if (recentDup.length) return res.json(recentDup[0]);

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

// ---- Fixed-path routes below MUST stay above the /:id routes further
// down - Express matches route patterns in registration order, and
// /:id would otherwise swallow "pricing-settings"/"site-prices" as if
// they were a package id. ----

// The tenant-wide toggle (see utils/pricing.js for what it actually
// controls). OFF by default - a tenant only sees per-site pricing at all
// once they've deliberately turned this on.
router.get('/pricing-settings', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT per_site_pricing_enabled FROM tenants WHERE id=$1', [req.tenantId]);
  res.json({ perSitePricingEnabled: !!rows[0]?.per_site_pricing_enabled });
}));

router.patch('/pricing-settings', asyncHandler(async (req, res) => {
  const { perSitePricingEnabled } = req.body;
  if (typeof perSitePricingEnabled !== 'boolean') {
    return res.status(400).json({ error: 'perSitePricingEnabled must be true or false' });
  }
  // Deliberately just flips the flag - never touches site_package_prices.
  // Turning this off doesn't delete anyone's per-site overrides, and
  // turning it back on doesn't require re-entering them; see the comment
  // on site_package_prices in schema.sql.
  await pool.query('UPDATE tenants SET per_site_pricing_enabled=$1 WHERE id=$2', [perSitePricingEnabled, req.tenantId]);
  res.json({ ok: true, perSitePricingEnabled });
}));

// Every package's price at one specific site - the template price, this
// site's override if it has one, and which one is actually in effect.
// Powers the owner's per-site pricing table.
router.get('/site-prices', asyncHandler(async (req, res) => {
  const { siteId } = req.query;
  if (!siteId) return res.status(400).json({ error: 'siteId is required' });

  const { rows: siteRows } = await pool.query('SELECT id FROM sites WHERE id=$1 AND tenant_id=$2', [siteId, req.tenantId]);
  if (!siteRows.length) return res.status(404).json({ error: 'Site not found' });

  const packages = await listPackagesWithEffectivePrice(req.tenantId, siteId, { includeInactive: true });
  res.json(packages.map((p) => ({
    id: p.id,
    label: p.label,
    templatePrice: Number(p.price),
    sitePrice: p.has_site_override ? Number(p.effective_price) : null,
    effectivePrice: Number(p.effective_price),
    active: p.active,
  })));
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

// Set (or replace) this site's override price for one package. Requires
// per-site pricing to actually be turned on first - setting an override
// while it's off would be invisible and confusing (it wouldn't do
// anything until someone later flips the toggle, by which point they've
// likely forgotten it's there).
router.put('/:packageId/site-price', asyncHandler(async (req, res) => {
  const { siteId, price } = req.body;
  if (!siteId) return res.status(400).json({ error: 'siteId is required' });
  if (!validate.isPositiveNumber(price)) return res.status(400).json({ error: 'Price must be a positive number.' });

  const { rows: tenantRows } = await pool.query('SELECT per_site_pricing_enabled FROM tenants WHERE id=$1', [req.tenantId]);
  if (!tenantRows[0]?.per_site_pricing_enabled) {
    return res.status(400).json({ error: 'Turn on per-site pricing first, then set individual site prices.' });
  }

  const { rows: pkgRows } = await pool.query('SELECT id FROM packages WHERE id=$1 AND tenant_id=$2', [req.params.packageId, req.tenantId]);
  if (!pkgRows.length) return res.status(404).json({ error: 'Package not found.' });
  const { rows: siteRows } = await pool.query('SELECT id FROM sites WHERE id=$1 AND tenant_id=$2', [siteId, req.tenantId]);
  if (!siteRows.length) return res.status(404).json({ error: 'Site not found.' });

  const { rows } = await pool.query(
    `INSERT INTO site_package_prices (tenant_id, site_id, package_id, price)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (site_id, package_id) DO UPDATE SET price = EXCLUDED.price
     RETURNING *`,
    [req.tenantId, siteId, req.params.packageId, price]
  );
  res.json(rows[0]);
}));

// Explicit removal, per the design here: never a side effect of the
// toggle, only ever this direct action. Reverts that one site/package
// back to the shared template price.
router.delete('/:packageId/site-price/:siteId', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'DELETE FROM site_package_prices WHERE package_id=$1 AND site_id=$2 AND tenant_id=$3 RETURNING id',
    [req.params.packageId, req.params.siteId, req.tenantId]
  );
  if (!rows.length) return res.status(404).json({ error: 'No override found for this site/package.' });
  res.json({ ok: true });
}));

module.exports = router;

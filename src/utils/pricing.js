const pool = require('../db/pool');

/**
 * The single place that decides what a package actually costs at a given
 * site, right now. Every voucher-creation and price-display path in the
 * app should go through this rather than reading packages.price directly,
 * so "per-site pricing" only has to be implemented once.
 *
 * Resolution order:
 *   1. tenants.per_site_pricing_enabled must be true, otherwise every
 *      site just uses the package's own price (legacy/default behavior).
 *   2. If it's true, a matching row in site_package_prices wins.
 *   3. Otherwise, falls back to the package's own price - so turning
 *      per-site pricing on doesn't require setting an override for every
 *      site immediately; only the sites you've deliberately tuned differ.
 *
 * Returns null if the package doesn't exist/isn't this tenant's, so
 * callers can tell "no such package" apart from a real zero-ish price.
 */
async function getEffectivePrice(tenantId, siteId, packageId) {
  const { rows: pkgRows } = await pool.query(
    'SELECT price FROM packages WHERE id=$1 AND tenant_id=$2',
    [packageId, tenantId]
  );
  if (!pkgRows.length) return null;
  const basePrice = pkgRows[0].price;
  if (!siteId) return basePrice;

  const { rows: tenantRows } = await pool.query(
    'SELECT per_site_pricing_enabled FROM tenants WHERE id=$1',
    [tenantId]
  );
  if (!tenantRows[0]?.per_site_pricing_enabled) return basePrice;

  const { rows: overrideRows } = await pool.query(
    'SELECT price FROM site_package_prices WHERE site_id=$1 AND package_id=$2',
    [siteId, packageId]
  );
  return overrideRows.length ? overrideRows[0].price : basePrice;
}

/**
 * Bulk version for a list screen showing every package's effective price
 * at one particular site (the owner's per-site pricing table, and the
 * customer-facing portal's package list) - one query instead of N calls
 * to getEffectivePrice.
 */
async function listPackagesWithEffectivePrice(tenantId, siteId, { includeInactive = false } = {}) {
  const { rows: tenantRows } = await pool.query(
    'SELECT per_site_pricing_enabled FROM tenants WHERE id=$1',
    [tenantId]
  );
  const perSitePricingEnabled = !!tenantRows[0]?.per_site_pricing_enabled;

  const { rows: packages } = await pool.query(
    `SELECT * FROM packages WHERE tenant_id=$1 ${includeInactive ? '' : 'AND active=true'} ORDER BY price ASC`,
    [tenantId]
  );
  if (!packages.length) return packages.map((p) => ({ ...p, effective_price: p.price, has_site_override: false }));

  let overridesByPackage = new Map();
  if (perSitePricingEnabled && siteId) {
    const { rows: overrides } = await pool.query(
      'SELECT package_id, price FROM site_package_prices WHERE site_id=$1',
      [siteId]
    );
    overridesByPackage = new Map(overrides.map((o) => [o.package_id, o.price]));
  }

  return packages.map((p) => ({
    ...p,
    effective_price: overridesByPackage.has(p.id) ? overridesByPackage.get(p.id) : p.price,
    has_site_override: overridesByPackage.has(p.id),
  }));
}

module.exports = { getEffectivePrice, listPackagesWithEffectivePrice };

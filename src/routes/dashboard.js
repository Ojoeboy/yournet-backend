const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const mikrotik = require('../integrations/mikrotik');
const omada = require('../integrations/omada');
const unifi = require('../integrations/unifi');
const meraki = require('../integrations/meraki');
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

// ---------- trend history (powers the dashboard's charts) ----------
// range is always one of exactly two values - never interpolated from
// anything the client can control beyond that choice - so building these
// two fragments into the SQL string below is safe (no free-form input
// reaches the query text; every actual value is still bound as $1/$2).
function bucketConfig(range) {
  if (range === '30d') return { trunc: 'day', sinceInterval: '30 days' };
  return { trunc: 'hour', sinceInterval: '24 hours' }; // default / '24h'
}
function normalizedRange(range) {
  return range === '30d' ? '30d' : '24h';
}
async function getOwnedSite(tenantId, siteId) {
  if (!siteId) return null;
  const { rows } = await pool.query('SELECT id FROM sites WHERE id=$1 AND tenant_id=$2', [siteId, tenantId]);
  return rows[0] || null;
}

// Revenue over time - computed straight from vouchers+packages (real
// timestamps already exist there), no snapshot table needed.
router.get('/history/revenue', asyncHandler(async (req, res) => {
  const { trunc, sinceInterval } = bucketConfig(req.query.range);
  const { rows } = await pool.query(
    `SELECT date_trunc('${trunc}', COALESCE(v.redeemed_at, v.created_at)) AS bucket,
            COALESCE(SUM(p.price), 0) AS revenue
     FROM vouchers v JOIN packages p ON p.id = v.package_id
     WHERE v.tenant_id = $1 AND v.status != 'unused'
       AND COALESCE(v.redeemed_at, v.created_at) >= now() - interval '${sinceInterval}'
     GROUP BY bucket ORDER BY bucket`,
    [req.tenantId]
  );
  res.json({
    range: normalizedRange(req.query.range),
    points: rows.map((r) => ({ t: r.bucket, revenue: Number(r.revenue) })),
  });
}));

// Vouchers sold (created) vs redeemed over time - also straight from the
// vouchers table, no snapshot table needed.
router.get('/history/vouchers', asyncHandler(async (req, res) => {
  const { trunc, sinceInterval } = bucketConfig(req.query.range);
  const { rows: soldRows } = await pool.query(
    `SELECT date_trunc('${trunc}', created_at) AS bucket, COUNT(*) AS sold
     FROM vouchers WHERE tenant_id = $1 AND created_at >= now() - interval '${sinceInterval}'
     GROUP BY bucket ORDER BY bucket`,
    [req.tenantId]
  );
  const { rows: redeemedRows } = await pool.query(
    `SELECT date_trunc('${trunc}', redeemed_at) AS bucket, COUNT(*) AS redeemed
     FROM vouchers WHERE tenant_id = $1 AND redeemed_at IS NOT NULL
       AND redeemed_at >= now() - interval '${sinceInterval}'
     GROUP BY bucket ORDER BY bucket`,
    [req.tenantId]
  );
  const byBucket = {};
  soldRows.forEach((r) => {
    byBucket[r.bucket.toISOString()] = { t: r.bucket, sold: Number(r.sold), redeemed: 0 };
  });
  redeemedRows.forEach((r) => {
    const key = r.bucket.toISOString();
    if (!byBucket[key]) byBucket[key] = { t: r.bucket, sold: 0, redeemed: 0 };
    byBucket[key].redeemed = Number(r.redeemed);
  });
  const points = Object.values(byBucket).sort((a, b) => new Date(a.t) - new Date(b.t));
  res.json({ range: normalizedRange(req.query.range), points });
}));

// Connected clients over time for one site - this one DOES need the
// snapshot table, since "how many clients were online at 3pm yesterday"
// isn't something the live router can answer after the fact.
router.get('/history/clients', asyncHandler(async (req, res) => {
  const site = await getOwnedSite(req.tenantId, req.query.siteId);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  const { trunc, sinceInterval } = bucketConfig(req.query.range);
  const { rows } = await pool.query(
    `SELECT date_trunc('${trunc}', checked_at) AS bucket,
            ROUND(AVG(client_count)) AS avg_clients,
            MAX(client_count) AS max_clients
     FROM site_status_snapshots
     WHERE site_id = $1 AND client_count IS NOT NULL
       AND checked_at >= now() - interval '${sinceInterval}'
     GROUP BY bucket ORDER BY bucket`,
    [req.query.siteId]
  );
  res.json({
    range: normalizedRange(req.query.range),
    points: rows.map((r) => ({ t: r.bucket, avg: Number(r.avg_clients), max: Number(r.max_clients) })),
  });
}));

// Uptime history for one site - % of snapshots in each bucket where the
// site answered online.
router.get('/history/uptime', asyncHandler(async (req, res) => {
  const site = await getOwnedSite(req.tenantId, req.query.siteId);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  const { trunc, sinceInterval } = bucketConfig(req.query.range);
  const { rows } = await pool.query(
    `SELECT date_trunc('${trunc}', checked_at) AS bucket,
            ROUND(100.0 * COUNT(*) FILTER (WHERE online) / COUNT(*), 1) AS uptime_pct
     FROM site_status_snapshots
     WHERE site_id = $1 AND checked_at >= now() - interval '${sinceInterval}'
     GROUP BY bucket ORDER BY bucket`,
    [req.query.siteId]
  );
  res.json({
    range: normalizedRange(req.query.range),
    points: rows.map((r) => ({ t: r.bucket, uptimePct: Number(r.uptime_pct) })),
  });
}));

// Live client count for a specific site - actually queries the router,
// rather than showing a placeholder. All four equipment types are wired:
// Mikrotik/Omada/UniFi return a real connected-client list; Meraki returns
// clients seen on the network in the last 5 minutes (Dashboard API has no
// concept of "currently associated" the way an on-prem controller does -
// see src/integrations/meraki.js for why).
router.get('/sites/:id/live', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM sites WHERE id=$1 AND tenant_id=$2', [
    req.params.id, req.tenantId,
  ]);
  if (!rows.length) return res.status(404).json({ error: 'Site not found' });
  const site = rows[0];

  try {
    if (site.type === 'mikrotik') {
      const clients = await mikrotik.listActiveClients({
        ...site,
        mk_password_decrypted: decrypt(site.mk_password_encrypted),
      });
      return res.json({ clients, count: clients.length });
    }

    if (site.type === 'omada') {
      const raw = await omada.listClients({
        ...site,
        omada_client_secret_decrypted: decrypt(site.omada_client_secret_encrypted),
      });
      // Omada's Open API field names below match the 5.0.15+ client list
      // shape - worth double-checking against your Controller version's
      // FAQ (see the note at the top of src/integrations/omada.js) since
      // this hasn't been verified against a live Controller. Normalized
      // to the same shape as Mikrotik's output so the dashboard UI doesn't
      // need vendor-specific rendering logic.
      const clients = raw.map((c) => ({
        user: c.name || c.hostName || null,
        address: c.ip || null,
        macAddress: c.mac || null,
        uptime: c.uptime != null ? String(c.uptime) : null,
        bytesIn: c.trafficDown != null ? String(c.trafficDown) : null,
        bytesOut: c.trafficUp != null ? String(c.trafficUp) : null,
      }));
      return res.json({ clients, count: clients.length });
    }

    if (site.type === 'unifi') {
      const raw = await unifi.listClients({
        ...site,
        unifi_password_decrypted: decrypt(site.unifi_password_encrypted),
        unifi_api_key_decrypted: decrypt(site.unifi_api_key_encrypted),
      });
      const clients = raw.map((c) => ({
        user: c.hostname || c.name || null,
        address: c.ip || null,
        macAddress: c.mac || null,
        uptime: c.uptime != null ? String(c.uptime) : null,
        bytesIn: c['rx_bytes'] != null ? String(c['rx_bytes']) : null,
        bytesOut: c['tx_bytes'] != null ? String(c['tx_bytes']) : null,
      }));
      return res.json({ clients, count: clients.length });
    }

    if (site.type === 'meraki') {
      const raw = await meraki.listClients({
        ...site,
        meraki_dashboard_api_key_decrypted: decrypt(site.meraki_dashboard_api_key_encrypted),
      });
      const clients = raw.map((c) => ({
        user: c.description || c.dhcpHostname || null,
        address: c.ip || null,
        macAddress: c.mac || null,
        uptime: null, // Dashboard API doesn't expose a live session-uptime figure here
        bytesIn: c.usage?.recv != null ? String(c.usage.recv) : null,
        bytesOut: c.usage?.sent != null ? String(c.usage.sent) : null,
      }));
      return res.json({ clients, count: clients.length });
    }

    return res.status(400).json({ error: `Unknown site type "${site.type}".` });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach the router.', detail: err.message });
  }
}));

module.exports = router;

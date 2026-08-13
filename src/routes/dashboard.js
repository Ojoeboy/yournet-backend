const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { requireAuth, requireNotAgent } = require('../middleware/auth');
const mikrotik = require('../integrations/mikrotik');
const omada = require('../integrations/omada');
const unifi = require('../integrations/unifi');
const meraki = require('../integrations/meraki');
const { decrypt } = require('../utils/credentialCrypto');
const asyncHandler = require('../utils/asyncHandler');
const freeStockPhotos = require('../integrations/freeStockPhotos');

const router = express.Router();
router.use(requireAuth, requireNotAgent);

// Account/profile logo upload - memory storage (never touches disk, since
// Render's filesystem is ephemeral) - the buffer is base64-encoded into a
// data: URL and saved straight into tenants.account_logo.
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1.5 * 1024 * 1024 }, // 1.5MB - this is an icon, not a banner
  fileFilter: (req, file, cb) => {
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)) {
      return cb(new Error('Logo must be a PNG, JPEG, WEBP, or GIF image'));
    }
    cb(null, true);
  },
});

router.post('/logo', asyncHandler(async (req, res) => {
  logoUpload.single('logo')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    await pool.query('UPDATE tenants SET account_logo=$1 WHERE id=$2', [dataUrl, req.tenantId]);
    res.json({ ok: true, logoUrl: dataUrl });
  });
}));

router.delete('/logo', asyncHandler(async (req, res) => {
  await pool.query('UPDATE tenants SET account_logo=NULL WHERE id=$1', [req.tenantId]);
  res.json({ ok: true });
}));

// Owner's opt-in toggle for a rotating photo background on admin/dashboard/
// billing/vouchers pages, in place of the default SVG connectivity mesh -
// OFF by default (see schema.sql), so a tenant only gets it by explicitly
// asking for it here.
router.get('/background-settings', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT admin_use_rotating_backgrounds FROM tenants WHERE id=$1',
    [req.tenantId]
  );
  res.json({ useRotatingBackgrounds: rows[0]?.admin_use_rotating_backgrounds || false });
}));

router.patch('/background-settings', asyncHandler(async (req, res) => {
  const { useRotatingBackgrounds } = req.body;
  if (typeof useRotatingBackgrounds !== 'boolean') {
    return res.status(400).json({ error: 'useRotatingBackgrounds must be true or false' });
  }
  await pool.query('UPDATE tenants SET admin_use_rotating_backgrounds=$1 WHERE id=$2', [
    useRotatingBackgrounds, req.tenantId,
  ]);
  res.json({ ok: true, useRotatingBackgrounds });
}));

// Account tab (business name, admin's full name, digital address, country,
// business location) + the same fields surfaced in the topbar profile panel.
// owner_email comes along read-only - it's set at signup, not edited here.
router.get('/account-info', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT business_name, admin_full_name, owner_email, digital_address, country, business_location, account_logo
     FROM tenants WHERE id=$1`,
    [req.tenantId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Tenant not found' });
  const t = rows[0];
  res.json({
    businessName: t.business_name,
    adminFullName: t.admin_full_name,
    email: t.owner_email,
    digitalAddress: t.digital_address,
    country: t.country,
    businessLocation: t.business_location,
    logoUrl: t.account_logo,
  });
}));

router.patch('/account-info', asyncHandler(async (req, res) => {
  const { businessName, adminFullName, digitalAddress, country, businessLocation } = req.body;
  if (!businessName || !String(businessName).trim()) {
    return res.status(400).json({ error: 'Business name cannot be empty' });
  }
  // The Account form always sends its full current state (not a partial
  // patch), so blank optional fields intentionally clear the stored value -
  // this stays a simple full overwrite rather than per-field COALESCE.
  const clean = (v) => (v && String(v).trim()) ? String(v).trim() : null;
  await pool.query(
    `UPDATE tenants SET
       business_name = $1,
       admin_full_name = $2,
       digital_address = $3,
       country = $4,
       business_location = $5
     WHERE id=$6`,
    [
      String(businessName).trim(),
      clean(adminFullName),
      clean(digitalAddress),
      clean(country),
      clean(businessLocation),
      req.tenantId,
    ]
  );
  res.json({ ok: true });
}));

// Authenticated version of the same rotating photo list the public portal
// config route serves - shell.js calls this only when the toggle above is on.
router.get('/rotating-backgrounds', asyncHandler(async (req, res) => {
  const backgrounds = await freeStockPhotos.getRotatingBackgrounds();
  res.json({ backgrounds });
}));

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

// Access-point list - CAPsMAN only, so only meaningful for Mikrotik sites.
// See the big comment on mikrotik.listAccessPoints for why this can come
// back empty even on a healthy site: it only sees real Mikrotik CAP
// devices under a CAPsMAN manager, not generic APs bridged to the router.
router.get('/sites/:id/access-points', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM sites WHERE id=$1 AND tenant_id=$2', [
    req.params.id, req.tenantId,
  ]);
  if (!rows.length) return res.status(404).json({ error: 'Site not found' });
  const site = rows[0];

  if (site.type !== 'mikrotik') {
    return res.status(400).json({ error: 'Access-point listing is only available for Mikrotik sites (CAPsMAN).' });
  }

  try {
    const result = await mikrotik.listAccessPoints({
      ...site,
      mk_password_decrypted: decrypt(site.mk_password_encrypted),
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'Could not reach the router.', detail: err.message });
  }
}));

// ---------- plan overview ----------
// Aggregates everything the "Overview of Plan" page needs into one call:
// current plan + price + start/end dates, linked payment gateways (no
// secrets), and a merged log of both (a) this tenant's own YourNet
// subscription payments and (b) their customers' payments through their
// linked gateways (vouchers + PPPoE), sorted newest first.
const SAAS_PLANS = {
  starter: { label: 'Starter', priceGHS: 50 },
  pro: { label: 'Pro', priceGHS: 150 },
};
const LICENSE_SIGNUP_PRICE_GHS = Number(process.env.LICENSE_SIGNUP_PRICE_GHS || 150);
const LICENSE_REACTIVATION_PRICE_GHS = Number(process.env.LICENSE_REACTIVATION_PRICE_GHS || 50);

router.get('/plan-overview', asyncHandler(async (req, res) => {
  const { rows: tenantRows } = await pool.query(
    `SELECT plan, plan_started_at, plan_expires_at, subscription_status, currency
     FROM tenants WHERE id=$1`,
    [req.tenantId]
  );
  if (!tenantRows.length) return res.status(404).json({ error: 'Tenant not found' });
  const tenant = tenantRows[0];

  // Price: prefer what was actually last paid (kind='initial' or
  // 'renewal', most recent) since that reflects any historical price
  // change; fall back to the current price table if there's no payment
  // history yet (e.g. a manually-issued/legacy account).
  const { rows: lastPaymentRows } = await pool.query(
    `SELECT amount FROM subscription_payments
     WHERE tenant_id=$1 AND status IN ('success','paid')
     ORDER BY created_at DESC LIMIT 1`,
    [req.tenantId]
  );
  let priceGHS = lastPaymentRows[0] ? Number(lastPaymentRows[0].amount) : null;
  if (priceGHS === null) {
    if (SAAS_PLANS[tenant.plan]) priceGHS = SAAS_PLANS[tenant.plan].priceGHS;
    else if (tenant.plan === 'licensed') priceGHS = LICENSE_REACTIVATION_PRICE_GHS;
  }

  const { rows: gateways } = await pool.query(
    `SELECT provider, is_active, contact_email, hubtel_merchant_account_number,
       (paystack_secret_key_encrypted IS NOT NULL) AS paystack_configured,
       (hubtel_client_secret_encrypted IS NOT NULL) AS hubtel_configured,
       (flutterwave_secret_key_encrypted IS NOT NULL) AS flutterwave_configured
     FROM payment_gateways WHERE tenant_id=$1 ORDER BY provider`,
    [req.tenantId]
  );

  const { rows: subscriptionLog } = await pool.query(
    `SELECT 'subscription' AS kind, amount, currency, provider, status, kind AS payment_kind, created_at
     FROM subscription_payments WHERE tenant_id=$1
     ORDER BY created_at DESC LIMIT 25`,
    [req.tenantId]
  );

  const { rows: customerLog } = await pool.query(
    `SELECT 'voucher' AS kind, p.price AS amount, 'GHS' AS currency, vo.provider, vo.status,
       NULL AS payment_kind, vo.created_at
     FROM voucher_orders vo JOIN packages p ON p.id = vo.package_id
     WHERE vo.tenant_id=$1
     UNION ALL
     SELECT 'pppoe' AS kind, pp.amount, 'GHS' AS currency, pp.provider, pp.status,
       NULL AS payment_kind, pp.created_at
     FROM pppoe_payments pp
     WHERE pp.tenant_id=$1
     ORDER BY created_at DESC LIMIT 50`,
    [req.tenantId]
  );

  res.json({
    plan: tenant.plan,
    planLabel: SAAS_PLANS[tenant.plan]?.label || (tenant.plan === 'licensed' ? 'Licensed' : tenant.plan),
    priceGHS,
    currency: tenant.currency,
    subscriptionStatus: tenant.subscription_status,
    planStartedAt: tenant.plan_started_at,
    planExpiresAt: tenant.plan_expires_at,
    gateways,
    subscriptionPayments: subscriptionLog,
    customerPayments: customerLog,
  });
}));

module.exports = router;

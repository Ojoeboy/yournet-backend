require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const siteRoutes = require('./routes/sites');
const voucherRoutes = require('./routes/vouchers');
const packageRoutes = require('./routes/packages');
const billingRoutes = require('./routes/billing');
const agentRoutes = require('./routes/agents');
const installerRoutes = require('./routes/installers');
const dashboardRoutes = require('./routes/dashboard');
const licenseRoutes = require('./routes/license');
const ownerRoutes = require('./routes/owner');
const paymentGatewayRoutes = require('./routes/paymentGateways');
const portalRoutes = require('./routes/portal');
const pppoeRoutes = require('./routes/pppoe');

const app = express();
// Render puts this app behind exactly one reverse-proxy hop, which sets
// X-Forwarded-For on every request. Express doesn't trust that header by
// default, so express-rate-limit can't tell real client IPs apart (it
// throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR and would otherwise bucket
// everyone under one key). `1` means "trust exactly one hop" - the correct
// value for Render's setup - as opposed to `true`, which would trust the
// whole chain including headers a client could spoof.
app.set('trust proxy', 1);
// contentSecurityPolicy disabled: the captive portal page (public/portal.html)
// intentionally uses inline <style>/<script> so it stays a single
// self-contained file with zero external requests - required because the
// device viewing it usually has no internet access yet. The rest of the
// API returns JSON only, so this trade-off is scoped to that one page.
app.use(helmet({ contentSecurityPolicy: false }));
// Restricted to this app's own origin(s) - every legitimate caller
// (admin.html, dashboard.html, portal pages) is served from here and none
// of them need cross-origin access. Requests with no Origin header (curl,
// Postman, server-to-server calls, native mobile HTTP clients) are never
// subject to CORS in the first place, so those still work unaffected -
// this only blocks a browser page on some OTHER origin from calling this
// API using a token it shouldn't have anyway.
//
// Built from APP_BASE_URL plus two fallbacks, since APP_BASE_URL is also
// used to build links in emails/webhooks (see billing.js, vouchers.js,
// portal.js, auth.js) and may get pointed at a custom domain while the
// app itself is still (or also) reachable at the Render *.onrender.com
// URL - trailing slashes are stripped so a difference there doesn't
// cause a false rejection like APP_BASE_URL vs the request origin did:
// - RENDER_EXTERNAL_URL: set automatically by Render to this service's
//   own onrender.com URL, so it always tracks the real deploy even if
//   APP_BASE_URL drifts to a custom domain or gets left stale.
// - ALLOWED_ORIGINS: optional comma-separated list of any other origins
//   that should be allowed (e.g. a separate frontend host), for cases
//   neither of the above covers.
const allowedOrigins = [
  process.env.APP_BASE_URL,
  process.env.RENDER_EXTERNAL_URL,
  ...(process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()),
]
  .filter(Boolean)
  .map((o) => o.replace(/\/$/, ''));
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin.replace(/\/$/, ''))) return callback(null, true);
    console.log('CORS rejected origin:', JSON.stringify(origin), 'allowed:', JSON.stringify(allowedOrigins));
    callback(new Error('Not allowed by CORS'));
  },
}));
// Default Express JSON body limit is 100kb - fine for ordinary API
// calls, but the account/portal logo fields (see logo-editor.js) send
// the uploaded image back as a base64 data: URL inside a normal JSON
// PATCH (e.g. savePortalBranding in admin.html), not a multipart upload.
// A 1.5MB image becomes ~2MB once base64-encoded, so it blew straight
// through the 100kb default - and past that limit, Express returns its
// own HTML error page instead of JSON, which is what produced
// "Unexpected token '<' ... is not valid JSON" in the browser instead of
// a real error message. 5mb gives comfortable headroom above the ~2MB
// worst case plus the rest of the form fields.
//
// verify stashes the exact raw bytes on req.rawBody before Express parses
// them into req.body. Needed by routes/license.js's Paystack webhook,
// which has to HMAC the ORIGINAL body to check x-paystack-signature -
// JSON.stringify(req.body) is not guaranteed to reproduce the same bytes
// Paystack signed (key order, spacing, unicode escaping can all differ),
// so re-serializing the parsed object would make real webhooks
// intermittently fail signature verification. Cheap for every other
// route - just a Buffer reference, nothing extra parsed or copied.
app.use(express.json({
  limit: '5mb',
  verify: (req, res, buf) => { req.rawBody = buf; },
}));
app.use('/p', express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.use('/i18n', express.static(path.join(__dirname, '..', 'public', 'i18n')));
app.use('/icons', express.static(path.join(__dirname, '..', 'public', 'icons')));
// Root-level static assets (shell.js, shell.css, bg-rotate.js, etc.) - only
// serves files that actually exist in public/, so it never shadows the
// explicit page/API routes below (e.g. GET /admin has no file called
// "admin" without an extension to match against).
app.use(express.static(path.join(__dirname, '..', 'public')));

const pool = require('./db/pool');
const { renderPortal, renderManifest, renderServiceWorker } = require('./utils/portalRenderer');
const asyncHandler = require('./utils/asyncHandler');
const freeStockPhotos = require('./integrations/freeStockPhotos');

// PUBLIC: rotating background photos for pages that aren't tied to a
// logged-in tenant (license.html, license-admin.html, owner-login.html) -
// the per-tenant equivalent for portal/admin/dashboard pages lives behind
// auth in routes/dashboard.js and routes/portal.js instead. Same
// fail-quiet behavior as those: no key configured, or the Pexels call
// itself fails, just means an empty list and the page keeps its plain
// background rather than erroring.
app.get('/api/public/rotating-backgrounds', asyncHandler(async (req, res) => {
  const backgrounds = await freeStockPhotos.getRotatingBackgrounds().catch(() => []);
  res.json({ backgrounds });
}));

// Serves the captive portal page for a site - either the built-in template
// with that tenant's branding (business name / logo / color) injected, or,
// if the tenant has set portal_custom_html, their own page verbatim. In
// the custom-HTML case it's on THEM to keep it working against
// /portal/:siteId/redeem - documented in the admin UI, not enforced here.
app.get('/p/:siteId', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM sites WHERE id=$1', [req.params.siteId]);
  if (!rows.length) return res.status(404).send('Unknown site.');
  const site = rows[0];

  if (site.portal_custom_html) {
    return res.type('html').send(site.portal_custom_html);
  }
  res.type('html').send(renderPortal(site));
}));

app.get('/p/:siteId/manifest.json', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM sites WHERE id=$1', [req.params.siteId]);
  if (!rows.length) return res.status(404).json({ error: 'Unknown site' });
  res.type('application/manifest+json').json(renderManifest(rows[0]));
}));

app.get('/p/:siteId/sw.js', (req, res) => {
  res.type('application/javascript').send(renderServiceWorker(req.params.siteId));
});

// Public captive-portal endpoint gets its own, more generous rate limit
// (real customers redeeming codes), separate from the admin API.
const portalLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
// Owner login guards the keys to the whole platform - much stricter than
// normal API traffic, since this endpoint is a realistic brute-force target.
const ownerLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

app.use('/api/auth', apiLimiter, authRoutes);
app.use('/api/sites', apiLimiter, siteRoutes);
app.use('/api/vouchers', apiLimiter, voucherRoutes);
app.use('/api/packages', apiLimiter, packageRoutes);
app.use('/api/agents', apiLimiter, agentRoutes);
app.use('/api/installers', apiLimiter, installerRoutes);
app.use('/api/dashboard', apiLimiter, dashboardRoutes);
app.use('/api/payment-gateways', apiLimiter, paymentGatewayRoutes);
app.use('/api/pppoe', apiLimiter, pppoeRoutes);
app.use('/license', apiLimiter, licenseRoutes);
app.use('/owner', ownerLoginLimiter, ownerRoutes);
app.use('/billing', apiLimiter, billingRoutes);
app.use('/portal', portalLimiter, portalRoutes);

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

app.get('/print', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'print.html'));
});

app.get('/billing', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'billing.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

app.get('/pppoe', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'pppoe.html'));
});

app.get('/agents', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'agents.html'));
});

// Installer self-service login/wizard page - a clean URL for the same
// reason /login, /admin, /agents etc. all get one (agent.html itself has
// no such route and is only ever reached at /agent.html directly; this
// gives installers the nicer link instead, since it's the one URL an
// owner will be handing out to new installers).
app.get('/installer', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'installer.html'));
});

app.get('/license', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'license.html'));
});

app.get('/license-admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'license-admin.html'));
});

app.get('/owner-revenue', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'owner-revenue.html'));
});

app.get('/owner-tenants', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'owner-tenants.html'));
});

app.get('/owner-media', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'owner-media.html'));
});

app.get('/settlement', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'settlement.html'));
});

app.get('/rsc-wizard.html', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'rsc-wizard.html'));
});

app.get('/owner-login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'owner-login.html'));
});

app.get('/forgot-password', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'forgot-password.html'));
});

app.get('/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'reset-password.html'));
});

app.get('/health', (req, res) => res.json({ ok: true }));

// DB-touching health check, distinct from /health above. /health (and
// /login, which UptimeRobot was already pinging) only prove this Express
// process is awake - Render's free tier - but Neon's serverless Postgres
// has its own separate autosuspend timer that idles regardless of whether
// this process is up. Point a second UptimeRobot monitor at this route so
// something actually queries the DB on a schedule and keeps Neon's compute
// endpoint from suspending between real hotspot visits to /p/:siteId.
app.get('/api/public/health', asyncHandler(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, db: true });
}));

// Centralized error handler - MUST be registered after every route above.
// Anything forwarded via next(err), including every asyncHandler-wrapped
// route, ends up here as a clean JSON response instead of a stack trace
// or a hung request.
const errorHandler = require('./middleware/errorHandler');
app.use(errorHandler);

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`YourNet backend running on port ${port}`));

// --- RADIUS auth server (CGNAT-safe voucher redemption) ---------------------
// Opt-in via env var: this is a brand-new, separate UDP listener alongside
// the existing HTTP app above, and radius-mode is per-site (sites.mk_auth_mode)
// - so leaving RADIUS_ENABLED unset changes nothing for any tenant currently
// using the RouterOS-API push flow. See integrations/radius.js for why this
// exists and services/voucherService.js#redeemVoucherByRadius for the
// redemption logic it calls into.
if (process.env.RADIUS_ENABLED === 'true') {
  const radius = require('./integrations/radius');
  const voucherService = require('./services/voucherService');
  const { decrypt } = require('./utils/credentialCrypto');

  radius.startAuthServer({
    port: parseInt(process.env.RADIUS_AUTH_PORT || '1812', 10),
    getSiteSecret: async (nasIdentifier) => {
      const { rows } = await pool.query(
        `SELECT radius_secret_encrypted FROM sites WHERE radius_nas_identifier = $1 AND mk_auth_mode = 'radius' AND active = true`,
        [nasIdentifier]
      );
      if (!rows.length || !rows[0].radius_secret_encrypted) return null;
      return decrypt(rows[0].radius_secret_encrypted);
    },
    onAuthenticate: ({ nasIdentifier, username, callingStationId }) =>
      voucherService.redeemVoucherByRadius(nasIdentifier, username, { clientMac: callingStationId || null }),
  });

  // Accounting-Request listener (Start/Interim-Update/Stop) - separate UDP
  // port and socket from auth, matching RFC 2865 vs 2866 and RouterOS's own
  // /radius config (independent auth-port/acct-port fields). Shares the
  // same per-NAS secret lookup as the auth server above.
  const radiusAccountingService = require('./services/radiusAccountingService');
  radius.startAcctServer({
    port: parseInt(process.env.RADIUS_ACCT_PORT || '1813', 10),
    getSiteSecret: async (nasIdentifier) => {
      const { rows } = await pool.query(
        `SELECT radius_secret_encrypted FROM sites WHERE radius_nas_identifier = $1 AND mk_auth_mode = 'radius' AND active = true`,
        [nasIdentifier]
      );
      if (!rows.length || !rows[0].radius_secret_encrypted) return null;
      return decrypt(rows[0].radius_secret_encrypted);
    },
    onAccounting: (nasIdentifier, event) => radiusAccountingService.handleAccountingEvent(nasIdentifier, event),
  });
}

// --- Automated site health polling ---
// Previously, a site's online/offline status only updated when someone
// manually clicked "Test connection" on /admin. This checks every site,
// every few minutes, so the dashboard reflects reality without a human
// having to remember to check. Runs inside this same process for now -
// fine at small scale; a genuinely large deployment would move this to a
// separate worker process instead of sharing the web server's event loop.
const mikrotik = require('./integrations/mikrotik');
const omada = require('./integrations/omada');
const unifi = require('./integrations/unifi');
const meraki = require('./integrations/meraki');
const { decrypt } = require('./utils/credentialCrypto');
const logger = require('./utils/logger');

async function pollAllSites() {
  try {
    const { rows: sites } = await pool.query('SELECT * FROM sites');
    if (sites.length === 0) return; // nothing to check - don't wake Neon for an empty table
    for (const site of sites) {
      try {
        let online = false;
        if (site.type === 'mikrotik') {
          const result = await mikrotik.ping({ ...site, mk_password_decrypted: decrypt(site.mk_password_encrypted) });
          online = result.online;
        } else if (site.type === 'omada') {
          const token = await omada.getAccessToken({ ...site, omada_client_secret_decrypted: decrypt(site.omada_client_secret_encrypted) });
          online = !!token;
        } else if (site.type === 'unifi') {
          const result = await unifi.ping({ ...site, unifi_password_decrypted: decrypt(site.unifi_password_encrypted), unifi_api_key_decrypted: decrypt(site.unifi_api_key_encrypted) });
          online = result.online;
        } else if (site.type === 'meraki') {
          // This branch was missing before - Meraki sites always showed
          // "error"/offline on the dashboard regardless of real status,
          // since no case matched and `online` stayed false by default.
          const result = await meraki.ping({ ...site, meraki_dashboard_api_key_decrypted: decrypt(site.meraki_dashboard_api_key_encrypted) });
          online = result.online;
        }
        await pool.query('UPDATE sites SET status=$1, last_checked_at=now() WHERE id=$2', [
          online ? 'online' : 'error', site.id,
        ]);
      } catch (err) {
        // One unreachable/misconfigured site shouldn't stop the rest from
        // being checked - log and move on to the next.
        await pool.query('UPDATE sites SET status=$1, last_checked_at=now() WHERE id=$2', ['error', site.id]).catch(() => {});
      }
    }
  } catch (err) {
    logger.error('Site health poll failed', { message: err.message });
  }
}

const HEALTH_POLL_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
setInterval(pollAllSites, HEALTH_POLL_INTERVAL_MS);
// Run once shortly after startup too, rather than waiting a full interval.
setTimeout(pollAllSites, 10 * 1000);

// --- Historical snapshots (powers the dashboard trend charts) ---
// pollAllSites above is deliberately lightweight (ping only) and runs every
// 5 minutes just to keep the "online/offline" pill fresh. This is a
// separate, heavier pass - it also asks each router/controller for its
// current client list - and only runs about once an hour, which is all the
// resolution the 24h/30d charts need. Kept as its own function/interval
// rather than folded into pollAllSites so a slow/rate-limited client-list
// call (Meraki and Omada both involve extra API round-trips) never delays
// the frequent status poll the rest of the admin UI depends on.
async function snapshotAllSites() {
  try {
    const { rows: sites } = await pool.query('SELECT * FROM sites');
    for (const site of sites) {
      let online = false;
      let error = null;
      let clientCount = null;
      try {
        if (site.type === 'mikrotik') {
          const decorated = { ...site, mk_password_decrypted: decrypt(site.mk_password_encrypted) };
          const result = await mikrotik.ping(decorated);
          online = result.online;
          error = result.error || null;
          if (online) {
            try { clientCount = (await mikrotik.listActiveClients(decorated)).length; } catch (_) { /* status still valid without a count */ }
          }
        } else if (site.type === 'omada') {
          const decorated = { ...site, omada_client_secret_decrypted: decrypt(site.omada_client_secret_encrypted) };
          try {
            clientCount = (await omada.listClients(decorated)).length;
            online = true;
          } catch (e) {
            online = false;
            error = e.message;
          }
        } else if (site.type === 'unifi') {
          const decorated = { ...site, unifi_password_decrypted: decrypt(site.unifi_password_encrypted), unifi_api_key_decrypted: decrypt(site.unifi_api_key_encrypted) };
          const result = await unifi.ping(decorated);
          online = result.online;
          error = result.error || null;
          if (online) {
            try { clientCount = (await unifi.listClients(decorated)).length; } catch (_) { /* status still valid without a count */ }
          }
        } else if (site.type === 'meraki') {
          const decorated = { ...site, meraki_dashboard_api_key_decrypted: decrypt(site.meraki_dashboard_api_key_encrypted) };
          const result = await meraki.ping(decorated);
          online = result.online;
          error = result.error || null;
          if (online) {
            try { clientCount = (await meraki.listClients(decorated)).length; } catch (_) { /* status still valid without a count */ }
          }
        } else {
          continue; // unconfigured/unknown type - nothing to snapshot yet
        }
      } catch (err) {
        online = false;
        error = err.message;
      }
      await pool.query(
        `INSERT INTO site_status_snapshots (site_id, tenant_id, online, client_count, error)
         VALUES ($1, $2, $3, $4, $5)`,
        [site.id, site.tenant_id, online, clientCount, error]
      ).catch((e) => logger.error('Snapshot insert failed', { site_id: site.id, message: e.message }));
    }
    // Keep the table bounded - 35 days of ~hourly rows per site is enough
    // to serve both the 24h and 30d chart views with room to spare.
    await pool.query(`DELETE FROM site_status_snapshots WHERE checked_at < now() - interval '35 days'`).catch(() => {});
  } catch (err) {
    logger.error('Site snapshot failed', { message: err.message });
  }
}

const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000; // roughly once an hour
setInterval(snapshotAllSites, SNAPSHOT_INTERVAL_MS);
// First snapshot shortly after startup, staggered after the quick status
// poll above so they don't both hammer every site at the exact same second.
setTimeout(snapshotAllSites, 45 * 1000);

// --- Monthly license auto-renewal ---
// Charges every tenant whose Paystack authorization is due for its monthly
// hit. Checked a few times a day (not once a day) so a tenant whose card
// only just became due doesn't wait up to 24h before the first attempt -
// runMonthlyBilling()'s own `next_billing_at <= now()` filter is what
// actually gates who gets charged, this interval just controls how often
// that check runs.
const subscriptionBilling = require('./services/subscriptionBilling');
const BILLING_INTERVAL_MS = 4 * 60 * 60 * 1000; // every 4 hours
setInterval(() => {
  subscriptionBilling.runMonthlyBilling().catch((err) => logger.error('Monthly billing run failed', { message: err.message }));
}, BILLING_INTERVAL_MS);
setTimeout(() => {
  subscriptionBilling.runMonthlyBilling().catch((err) => logger.error('Monthly billing run failed', { message: err.message }));
}, 60 * 1000);

// --- PPPoE overdue/suspension enforcement ---
// Separate job, separate interval, from the platform-license billing above
// - this one enforces individual PPPoE subscriber due dates (overdue ->
// grace period -> router suspension), not the tenant's own platform
// subscription. See services/pppoeBilling.js for what it does and does not
// do yet (no auto-charge - reactivation is a manual/admin-recorded payment
// for now).
const pppoeBilling = require('./services/pppoeBilling');
const PPPOE_BILLING_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours - daily granularity (due dates) doesn't need tighter polling
setInterval(() => {
  pppoeBilling.runPppoeBillingPass().catch((err) => logger.error('PPPoE billing pass failed', { message: err.message }));
}, PPPOE_BILLING_INTERVAL_MS);
setTimeout(() => {
  pppoeBilling.runPppoeBillingPass().catch((err) => logger.error('PPPoE billing pass failed', { message: err.message }));
}, 90 * 1000);

// --- Voucher wall-clock expiry enforcement ---
// The router's own limit-uptime only counts connected time and pauses on
// disconnect, so it can't be trusted alone to cut a customer off at the
// wall-clock time they were actually sold ("24 hours from redemption",
// not "24 hours of connected time"). This sweep is what enforces that
// promise: it finds vouchers whose expires_at has passed while still
// marked 'active', kicks/removes the session on the router (see
// services/voucherExpiry.js for per-site-type coverage), and flips status
// to 'expired' so the DB stops drifting from what's actually happening on
// the router - see the delete-guard comment in routes/vouchers.js for the
// mismatch this was causing before. Runs frequently (every minute) since,
// unlike the billing jobs above, being late here means a customer stays
// online longer than they paid for.
const voucherExpiry = require('./services/voucherExpiry');
const VOUCHER_EXPIRY_INTERVAL_MS = 60 * 1000; // every minute
setInterval(() => {
  voucherExpiry.runVoucherExpirySweep().catch((err) => logger.error('Voucher expiry sweep failed', { message: err.message }));
}, VOUCHER_EXPIRY_INTERVAL_MS);
setTimeout(() => {
  voucherExpiry.runVoucherExpirySweep().catch((err) => logger.error('Voucher expiry sweep failed', { message: err.message }));
}, 15 * 1000);

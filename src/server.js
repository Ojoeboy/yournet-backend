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
const dashboardRoutes = require('./routes/dashboard');
const licenseRoutes = require('./routes/license');
const ownerRoutes = require('./routes/owner');
const paymentGatewayRoutes = require('./routes/paymentGateways');
const portalRoutes = require('./routes/portal');

const app = express();
// contentSecurityPolicy disabled: the captive portal page (public/portal.html)
// intentionally uses inline <style>/<script> so it stays a single
// self-contained file with zero external requests - required because the
// device viewing it usually has no internet access yet. The rest of the
// API returns JSON only, so this trade-off is scoped to that one page.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use('/p', express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.use('/i18n', express.static(path.join(__dirname, '..', 'public', 'i18n')));
app.use('/icons', express.static(path.join(__dirname, '..', 'public', 'icons')));

const pool = require('./db/pool');
const { renderPortal, renderManifest, renderServiceWorker } = require('./utils/portalRenderer');
const asyncHandler = require('./utils/asyncHandler');

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
app.use('/api/dashboard', apiLimiter, dashboardRoutes);
app.use('/api/payment-gateways', apiLimiter, paymentGatewayRoutes);
app.use('/license', apiLimiter, licenseRoutes);
app.use('/owner', ownerLoginLimiter, ownerRoutes);
app.use('/billing', apiLimiter, billingRoutes);
app.use('/portal', portalLimiter, portalRoutes);

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

app.get('/license', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'license.html'));
});

app.get('/license-admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'momo-admin.html'));
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

// Centralized error handler - MUST be registered after every route above.
// Anything forwarded via next(err), including every asyncHandler-wrapped
// route, ends up here as a clean JSON response instead of a stack trace
// or a hung request.
const errorHandler = require('./middleware/errorHandler');
app.use(errorHandler);

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`YourNet backend running on port ${port}`));

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
const { decrypt } = require('./utils/credentialCrypto');
const logger = require('./utils/logger');

async function pollAllSites() {
  try {
    const { rows: sites } = await pool.query('SELECT * FROM sites');
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
          const result = await unifi.ping({ ...site, unifi_password_decrypted: decrypt(site.unifi_password_encrypted) });
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
